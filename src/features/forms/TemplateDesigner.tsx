import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { AccountType, FieldType } from "../../lib/types";
import { BACKGROUNDS, bgByKey } from "./backgrounds";

const KINDS = ["document", "permit", "tax", "contract"];
const ACCOUNTS: AccountType[] = ["civilian", "politician", "company", "auror", "admin"];
const FIELD_TYPES: FieldType[] = [
  "text", "long_text", "number", "currency", "date", "dropdown", "checkbox",
  "radio", "region_select", "user_select", "company_select", "signature", "declaration",
];

interface EditField {
  id?: string; tempId: string; key: string; label: string; field_type: FieldType;
  required: boolean; x: number; y: number; w: number; h: number; font: number;
}

let SEQ = 0;
const nid = () => `f${Date.now()}_${SEQ++}`;

export function TemplateDesigner({ templateId, onClose }: { templateId: string | null; onClose: () => void }) {
  const [perms, setPerms] = useState<string[]>([]);
  const [meta, setMeta] = useState({
    code: "", name: "", kind: "document", department: "", numbering_prefix: "DOC",
    approval_permission: "documents.approve", auto_issue: false, expires: "",
    background_key: "certificate",
    applicant: new Set<AccountType>(["civilian"]),
  });
  const [fields, setFields] = useState<EditField[]>([]);
  const [origIds, setOrigIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [canvasH, setCanvasH] = useState(600);
  const drag = useRef<{ mode: "move" | "resize"; id: string; offX: number; offY: number } | null>(null);

  // load perms + (edit) existing template
  useEffect(() => {
    supabase.from("permissions").select("key").order("key").then(({ data }) => setPerms(((data as { key: string }[]) ?? []).map((p) => p.key)));
    if (!templateId) return;
    (async () => {
      const { data: t } = await supabase.from("document_templates")
        .select("code,name,kind,department,numbering_prefix,approval_permission,auto_issue_on_approval,expires_after_days,background_key,applicant_account_types")
        .eq("id", templateId).maybeSingle();
      if (t) {
        const tt = t as Record<string, unknown>;
        setMeta({
          code: String(tt.code ?? ""), name: String(tt.name ?? ""), kind: String(tt.kind ?? "document"),
          department: String(tt.department ?? ""), numbering_prefix: String(tt.numbering_prefix ?? "DOC"),
          approval_permission: String(tt.approval_permission ?? "documents.approve"),
          auto_issue: !!tt.auto_issue_on_approval, expires: tt.expires_after_days ? String(tt.expires_after_days) : "",
          background_key: String(tt.background_key ?? "certificate"),
          applicant: new Set((tt.applicant_account_types as AccountType[]) ?? ["civilian"]),
        });
      }
      const { data: fs } = await supabase.from("document_template_fields")
        .select("id,key,label,field_type,required,pos_x,pos_y,width,height,font_size,sort_order")
        .eq("template_id", templateId).order("sort_order");
      const rows = ((fs as Record<string, unknown>[]) ?? []).map((f) => ({
        id: String(f.id), tempId: nid(), key: String(f.key), label: String(f.label),
        field_type: f.field_type as FieldType, required: !!f.required,
        x: Number(f.pos_x ?? 0.1), y: Number(f.pos_y ?? 0.1), w: Number(f.width ?? 0.35),
        h: Number(f.height ?? 0.06), font: Number(f.font_size ?? 0.03),
      }));
      setFields(rows);
      setOrigIds(rows.map((r) => r.id!).filter(Boolean));
    })();
  }, [templateId]);

  // track canvas pixel height for font scaling
  useLayoutEffect(() => {
    function measure() { if (canvasRef.current) setCanvasH(canvasRef.current.getBoundingClientRect().height); }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [meta.background_key]);

  // pointer drag/resize
  useEffect(() => {
    function move(e: PointerEvent) {
      const d = drag.current; if (!d || !canvasRef.current) return;
      const r = canvasRef.current.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      setFields((prev) => prev.map((f) => {
        if (f.tempId !== d.id) return f;
        if (d.mode === "move") {
          const x = Math.min(Math.max(fx - d.offX, 0), 1 - f.w);
          const y = Math.min(Math.max(fy - d.offY, 0), 1 - f.h);
          return { ...f, x, y };
        }
        const w = Math.min(Math.max(fx - f.x, 0.04), 1 - f.x);
        const h = Math.min(Math.max(fy - f.y, 0.025), 1 - f.y);
        return { ...f, w, h };
      }));
    }
    function up() { drag.current = null; }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  function startMove(e: React.PointerEvent, f: EditField) {
    e.stopPropagation();
    const r = canvasRef.current!.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    drag.current = { mode: "move", id: f.tempId, offX: fx - f.x, offY: fy - f.y };
    setSelected(f.tempId);
  }
  function startResize(e: React.PointerEvent, f: EditField) {
    e.stopPropagation();
    drag.current = { mode: "resize", id: f.tempId, offX: 0, offY: 0 };
    setSelected(f.tempId);
  }

  function addField() {
    const f: EditField = { tempId: nid(), key: `field_${fields.length + 1}`, label: "New field", field_type: "text", required: true, x: 0.12, y: 0.12, w: 0.4, h: 0.06, font: 0.03 };
    setFields([...fields, f]); setSelected(f.tempId);
  }
  function patchSel(patch: Partial<EditField>) {
    setFields((prev) => prev.map((f) => (f.tempId === selected ? { ...f, ...patch } : f)));
  }
  function removeSel() {
    setFields((prev) => prev.filter((f) => f.tempId !== selected)); setSelected(null);
  }

  async function save() {
    setError(null);
    if (!meta.code.trim() || !meta.name.trim()) return setError("Template needs a code and a name.");
    setBusy(true);
    try {
      const bg = bgByKey(meta.background_key);
      const payload = {
        code: meta.code.trim(), name: meta.name.trim(), kind: meta.kind,
        department: meta.department.trim() || null, numbering_prefix: meta.numbering_prefix.trim() || "DOC",
        approval_permission: meta.approval_permission,
        applicant_account_types: Array.from(meta.applicant),
        auto_issue_on_approval: meta.auto_issue,
        expires_after_days: meta.expires ? Number(meta.expires) : null,
        background_key: meta.background_key, page_aspect: bg?.aspect ?? null,
      };
      let id = templateId;
      if (id) {
        const { error: e } = await supabase.from("document_templates").update(payload).eq("id", id);
        if (e) throw e;
      } else {
        const { data, error: e } = await supabase.from("document_templates").insert(payload).select("id").single();
        if (e) throw e;
        id = (data as { id: string }).id;
      }
      // reconcile fields
      const keptIds: string[] = [];
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const row = {
          template_id: id, key: f.key.trim() || `field_${i + 1}`, label: f.label.trim() || "Field",
          field_type: f.field_type, required: f.required, sort_order: i + 1,
          pos_x: f.x, pos_y: f.y, width: f.w, height: f.h, font_size: f.font, options: {},
        };
        if (f.id) { keptIds.push(f.id); const { error: e } = await supabase.from("document_template_fields").update(row).eq("id", f.id); if (e) throw e; }
        else { const { error: e } = await supabase.from("document_template_fields").insert(row); if (e) throw e; }
      }
      const removed = origIds.filter((x) => !keptIds.includes(x));
      for (const rid of removed) {
        const { error: e } = await supabase.from("document_template_fields").delete().eq("id", rid);
        if (e) throw new Error("A field couldn't be removed (it's used by existing submissions). Retire the form instead of editing that field.");
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  const bg = bgByKey(meta.background_key);
  const sel = fields.find((f) => f.tempId === selected) ?? null;

  return (
    <div className="designer">
      <div className="designer__bar">
        <button className="linkish" onClick={onClose}>‹ back to forms</button>
        <strong style={{ marginLeft: 8 }}>{templateId ? "Edit form" : "New form"}</strong>
        <div className="spacer" />
        <button className="btn btn--stamp" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save form"}</button>
      </div>
      {error ? <p className="note note--error">{error}</p> : null}

      <div className="designer__grid">
        {/* left: settings */}
        <div className="designer__panel">
          <div className="admin-subhead">Form details</div>
          <input className="admin-inline" placeholder="Code (RESIDENCY_CERT)" value={meta.code} onChange={(e) => setMeta({ ...meta, code: e.target.value })} />
          <input className="admin-inline" placeholder="Name" value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
          <select className="admin-inline" value={meta.kind} onChange={(e) => setMeta({ ...meta, kind: e.target.value })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
          <input className="admin-inline" placeholder="Department" value={meta.department} onChange={(e) => setMeta({ ...meta, department: e.target.value })} />
          <input className="admin-inline" placeholder="ID prefix" value={meta.numbering_prefix} onChange={(e) => setMeta({ ...meta, numbering_prefix: e.target.value })} />
          <select className="admin-inline" value={meta.approval_permission} onChange={(e) => setMeta({ ...meta, approval_permission: e.target.value })}>
            {perms.map((k) => <option key={k}>{k}</option>)}
          </select>
          <div className="admin-subhead" style={{ marginTop: 8 }}>Who may apply</div>
          <div className="chip-set">
            {ACCOUNTS.map((a) => <label key={a} className="admin-check"><input type="checkbox" checked={meta.applicant.has(a)} onChange={() => { const n = new Set(meta.applicant); n.has(a) ? n.delete(a) : n.add(a); setMeta({ ...meta, applicant: n }); }} /> {a}</label>)}
          </div>
          <label className="admin-check" style={{ marginTop: 6 }}><input type="checkbox" checked={meta.auto_issue} onChange={(e) => setMeta({ ...meta, auto_issue: e.target.checked })} /> auto-issue on approval</label>
          <input className="admin-inline" placeholder="Expires after N days" value={meta.expires} onChange={(e) => setMeta({ ...meta, expires: e.target.value.replace(/\D/g, "") })} />

          <div className="admin-subhead" style={{ marginTop: 10 }}>Background</div>
          <div className="bg-picker">
            {BACKGROUNDS.map((b) => (
              <button key={b.key} className={`bg-thumb${meta.background_key === b.key ? " is-on" : ""}`} onClick={() => setMeta({ ...meta, background_key: b.key })} title={b.label}>
                <img src={b.src} alt={b.label} />
              </button>
            ))}
          </div>

          <div className="admin-subhead" style={{ marginTop: 10 }}>Field</div>
          <button className="btn" onClick={addField}>+ Add field</button>
          {sel ? (
            <div style={{ marginTop: 8 }}>
              <input className="admin-inline" placeholder="Label" value={sel.label} onChange={(e) => patchSel({ label: e.target.value })} />
              <input className="admin-inline" placeholder="key" value={sel.key} onChange={(e) => patchSel({ key: e.target.value.replace(/\s/g, "_").toLowerCase() })} />
              <select className="admin-inline" value={sel.field_type} onChange={(e) => patchSel({ field_type: e.target.value as FieldType })}>{FIELD_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
              <label className="admin-check"><input type="checkbox" checked={sel.required} onChange={(e) => patchSel({ required: e.target.checked })} /> required</label>
              <label className="admin-check" style={{ marginTop: 4 }}>Font
                <input type="range" min={0.015} max={0.06} step={0.002} value={sel.font} onChange={(e) => patchSel({ font: Number(e.target.value) })} />
              </label>
              <button className="linkish" onClick={removeSel}>remove field</button>
            </div>
          ) : <p className="note">Select a field on the page to edit it, or add one.</p>}
        </div>

        {/* right: canvas */}
        <div className="designer__stage">
          <div
            ref={canvasRef}
            className="designer__canvas"
            style={{ aspectRatio: String(bg?.aspect ?? 0.75), backgroundImage: bg ? `url("${bg.src}")` : undefined }}
            onPointerDown={() => setSelected(null)}
          >
            {fields.map((f) => (
              <div
                key={f.tempId}
                className={`dfield${selected === f.tempId ? " is-sel" : ""}`}
                style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, fontSize: `${f.font * canvasH}px` }}
                onPointerDown={(e) => startMove(e, f)}
              >
                <span className="dfield__label">{f.label}</span>
                <span className="dfield__handle" onPointerDown={(e) => startResize(e, f)} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
