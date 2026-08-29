import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { TemplateField } from "../../lib/types";
import { PositionedDoc, isPositioned } from "../forms/PositionedDoc";
import { STAMPS, SEALS, ACTION_STAMPS, markSrc, markId, type MarkPlacement } from "../forms/marks";
import { useCanvasDrag } from "../forms/useCanvasDrag";

interface FieldValue { value: string | null; field: { label: string } | null; }

export function StampReview({ submissionId, publicNo, templateName, status, onDone }: {
  submissionId: string; publicNo: string | null; templateName: string; status: string; onDone: () => void;
}) {
  const [values, setValues] = useState<FieldValue[]>([]);
  const [bgKey, setBgKey] = useState<string | null>(null);
  const [fields, setFields] = useState<TemplateField[]>([]);
  const [byKey, setByKey] = useState<Record<string, string>>({});
  const [templateSeals, setTemplateSeals] = useState<MarkPlacement[]>([]);
  const [marks, setMarks] = useState<MarkPlacement[]>([]);   // reviewer-placed
  const [sel, setSel] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLDivElement>(null);
  const marksRef = useRef(marks); marksRef.current = marks;
  const getBox = useCallback((id: string) => { const m = marksRef.current.find((x) => x.id === id); return m ? { x: m.x, y: m.y, w: m.w, h: m.h } : undefined; }, []);
  const apply = useCallback((id: string, box: Partial<{ x: number; y: number; w: number; h: number }>) => setMarks((p) => p.map((m) => (m.id === id ? { ...m, ...box } : m))), []);
  const { startMove, startResize } = useCanvasDrag(canvasRef, apply, getBox);

  useEffect(() => {
    (async () => {
      const { data: sub } = await supabase.from("document_submissions").select("template_id,stamps_layout").eq("id", submissionId).maybeSingle();
      const s = sub as { template_id: string; stamps_layout: MarkPlacement[] } | null;
      if (s?.stamps_layout?.length) setMarks(s.stamps_layout);
      if (s?.template_id) {
        const { data: t } = await supabase.from("document_templates").select("background_key,layout").eq("id", s.template_id).maybeSingle();
        const tt = t as { background_key: string | null; layout: { decorations?: MarkPlacement[] } } | null;
        setBgKey(tt?.background_key ?? null);
        setTemplateSeals(tt?.layout?.decorations ?? []);
        const { data: fs } = await supabase.from("document_template_fields")
          .select("id,template_id,key,label,description,field_type,required,sort_order,options,pos_x,pos_y,width,height,font_size")
          .eq("template_id", s.template_id).order("sort_order");
        setFields((fs as TemplateField[]) ?? []);
      }
      const { data } = await supabase.from("document_field_values").select("value,document_template_fields(label,key)").eq("submission_id", submissionId);
      const raw = (data as unknown as { value: string | null; document_template_fields: { label: string; key: string } | null }[]) ?? [];
      setValues(raw.map((r) => ({ value: r.value, field: r.document_template_fields })));
      const map: Record<string, string> = {};
      raw.forEach((r) => { if (r.document_template_fields?.key) map[r.document_template_fields.key] = r.value ?? ""; });
      setByKey(map);
    })();
  }, [submissionId]);

  function addMark(kind: "stamp" | "seal", key: string) {
    const m: MarkPlacement = kind === "stamp"
      ? { id: markId(), kind, key, x: 0.32, y: 0.4, w: 0.34, h: 0.16, rot: -6 }
      : { id: markId(), kind, key, x: 0.42, y: 0.55, w: 0.14, h: 0.14, rot: 0 };
    setMarks([...marks, m]); setSel(m.id);
  }
  function removeSel() { setMarks((p) => p.filter((m) => m.id !== sel)); setSel(null); }
  const selMark = marks.find((m) => m.id === sel) ?? null;

  async function send() {
    if (marks.length === 0) return setError("Place at least one stamp or seal on the document.");
    setError(null); setBusy(true);
    const stampKeys = Array.from(new Set(marks.filter((m) => m.kind === "stamp" && ACTION_STAMPS.has(m.key)).map((m) => m.key)));
    const { error: e } = await supabase.rpc("process_stamps", { p_submission: submissionId, p_stamps: stampKeys, p_comment: comment.trim() || null, p_layout: marks });
    setBusy(false);
    if (e) return setError(e.message);
    onDone();
  }

  const positioned = isPositioned(bgKey, fields);

  const palette = (
    <>
      <div className="admin-subhead">Stamps</div>
      <div className="mark-palette">
        {STAMPS.map((m) => <button key={m.key} className="mark-pick mark-pick--stamp" title={m.label} onClick={() => addMark("stamp", m.key)}><img src={m.src} alt={m.label} /></button>)}
      </div>
      <div className="admin-subhead" style={{ marginTop: 8 }}>Seals</div>
      <div className="mark-palette">
        {SEALS.map((m) => <button key={m.key} className="mark-pick" title={m.label} onClick={() => addMark("seal", m.key)}><img src={m.src} alt={m.label} /></button>)}
      </div>
      {selMark ? (
        <div style={{ marginTop: 8 }}>
          <label className="admin-check">Rotate <input type="range" min={-30} max={30} step={1} value={selMark.rot ?? 0} onChange={(e) => setMarks((p) => p.map((m) => (m.id === selMark.id ? { ...m, rot: Number(e.target.value) } : m)))} /></label>
          <button className="linkish" onClick={removeSel}>remove</button>
        </div>
      ) : <p className="note">Click a stamp or seal to drop it, then drag it into place.</p>}
      <textarea className="admin-textarea" placeholder="Note (recorded in history)…" value={comment} onChange={(e) => setComment(e.target.value)} />
      {error ? <p className="note note--error">{error}</p> : null}
      <div className="btn-row"><button className="btn btn--stamp" onClick={send} disabled={busy}>{busy ? "Processing…" : "Send to outgoing tray"}</button></div>
    </>
  );

  if (positioned) {
    return (
      <div className="docview">
        <div className="docview__bar">
          <button className="linkish" onClick={onDone}>‹ inbox</button>
          <strong style={{ marginLeft: 8 }}>{templateName}</strong>
          <span className="note" style={{ margin: "0 0 0 8px" }}>{publicNo ?? "—"} · {status}</span>
        </div>
        <div className="docview__grid">
          <div className="docview__stage">
            <div className="review-wrap">
              <PositionedDoc backgroundKey={bgKey} fields={fields} values={byKey} readOnly marks={templateSeals} />
              <div ref={canvasRef} className="mark-layer" onPointerDown={() => setSel(null)}>
                {marks.map((m) => (
                  <div key={m.id} className={`dseal${sel === m.id ? " is-sel" : ""}`}
                    style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%`, transform: `rotate(${m.rot ?? 0}deg)` }}
                    onPointerDown={(e) => { startMove(e, m.id); setSel(m.id); }}>
                    <img src={markSrc(m.kind, m.key)} alt="" draggable={false} />
                    <span className="dfield__handle" onPointerDown={(e) => { startResize(e, m.id); setSel(m.id); }} />
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="docview__panel">{palette}</div>
        </div>
      </div>
    );
  }

  // Fallback for stacked (non-designed) forms: value table + palette.
  return (
    <div>
      <button className="linkish" onClick={onDone}>‹ back to inbox</button>
      <div className="doc-seal" style={{ marginTop: 8 }}>{templateName}</div>
      <div className="doc-meta">{publicNo ?? "—"} · {status}</div>
      <table className="ledger"><tbody>
        {values.map((v, i) => <tr key={i}><th style={{ width: "40%" }}>{v.field?.label ?? "—"}</th><td>{v.value || "—"}</td></tr>)}
        {values.length === 0 ? <tr><td className="note" style={{ border: 0 }}>No field values.</td></tr> : null}
      </tbody></table>
      {palette}
    </div>
  );
}
