import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { AccountType, FieldType } from "../../lib/types";

const KINDS = ["document", "permit", "tax", "contract"];
const ACCOUNTS: AccountType[] = ["civilian", "politician", "company", "auror", "admin"];
const FIELD_TYPES: FieldType[] = [
  "text", "long_text", "number", "currency", "date", "dropdown", "checkbox",
  "radio", "region_select", "user_select", "company_select", "file", "signature", "declaration",
];

interface Template {
  id: string; code: string; kind: string; name: string; numbering_prefix: string;
  approval_permission: string; applicant_account_types: AccountType[];
  auto_issue_on_approval: boolean; expires_after_days: number | null;
}
interface Field {
  id: string; key: string; label: string; field_type: FieldType; required: boolean; sort_order: number;
}

export function TemplatesPanel() {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [perms, setPerms] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [tpl, setTpl] = useState({
    code: "", name: "", kind: "document", department: "", numbering_prefix: "DOC",
    approval_permission: "documents.approve", applicant: new Set<AccountType>(["civilian"]),
    auto_issue: false, expires: "",
  });
  const [fld, setFld] = useState({ key: "", label: "", field_type: "text" as FieldType, required: true, options: "" });

  async function load() {
    const [{ data: t }, { data: p }] = await Promise.all([
      supabase.from("document_templates").select("id,code,kind,name,numbering_prefix,approval_permission,applicant_account_types,auto_issue_on_approval,expires_after_days").order("name"),
      supabase.from("permissions").select("key").order("key"),
    ]);
    setTemplates((t as Template[]) ?? []);
    setPerms(((p as { key: string }[]) ?? []).map((x) => x.key));
  }
  useEffect(() => { load(); }, []);

  async function loadFields(id: string) {
    const { data } = await supabase.from("document_template_fields")
      .select("id,key,label,field_type,required,sort_order").eq("template_id", id).order("sort_order");
    setFields((data as Field[]) ?? []);
  }
  useEffect(() => { if (sel) loadFields(sel); }, [sel]);

  async function createTemplate() {
    setError(null);
    if (!tpl.code.trim() || !tpl.name.trim()) return setError("Template needs a code and a name.");
    const { data, error: e } = await supabase.from("document_templates").insert({
      code: tpl.code.trim(), name: tpl.name.trim(), kind: tpl.kind,
      department: tpl.department.trim() || null, numbering_prefix: tpl.numbering_prefix.trim() || "DOC",
      approval_permission: tpl.approval_permission,
      applicant_account_types: Array.from(tpl.applicant),
      auto_issue_on_approval: tpl.auto_issue,
      expires_after_days: tpl.expires ? Number(tpl.expires) : null,
    }).select("id").single();
    if (e) return setError(e.message);
    setTpl({ ...tpl, code: "", name: "", department: "" });
    await load();
    setSel((data as { id: string }).id);
  }

  async function addField() {
    if (!sel) return;
    setError(null);
    if (!fld.key.trim() || !fld.label.trim()) return setError("Field needs a key and a label.");
    const options = ["dropdown", "radio"].includes(fld.field_type) && fld.options.trim()
      ? { choices: fld.options.split(",").map((s) => s.trim()).filter(Boolean) } : {};
    const { error: e } = await supabase.from("document_template_fields").insert({
      template_id: sel, key: fld.key.trim(), label: fld.label.trim(),
      field_type: fld.field_type, required: fld.required, sort_order: fields.length + 1, options,
    });
    if (e) return setError(e.message);
    setFld({ key: "", label: "", field_type: "text", required: true, options: "" });
    loadFields(sel);
  }

  async function delField(id: string) {
    await supabase.from("document_template_fields").delete().eq("id", id);
    if (sel) loadFields(sel);
  }

  function toggleAccount(a: AccountType) {
    const next = new Set(tpl.applicant);
    next.has(a) ? next.delete(a) : next.add(a);
    setTpl({ ...tpl, applicant: next });
  }

  if (templates === null) return <p className="note">Opening the forms cabinet…</p>;

  return (
    <div className="offices-grid">
      <div className="offices-list">
        <div className="admin-subhead">Templates</div>
        {templates.map((t) => (
          <button key={t.id} className={`office-item${sel === t.id ? " is-selected" : ""}`} onClick={() => setSel(t.id)}>
            {t.name}<span className="office-min">{t.kind} · {t.numbering_prefix}</span>
          </button>
        ))}
        <div className="admin-subhead" style={{ marginTop: 14 }}>New template</div>
        <input className="admin-inline" placeholder="Code (e.g. RESIDENCY_CERT)" value={tpl.code} onChange={(e) => setTpl({ ...tpl, code: e.target.value })} />
        <input className="admin-inline" placeholder="Name" value={tpl.name} onChange={(e) => setTpl({ ...tpl, name: e.target.value })} />
        <select className="admin-inline" value={tpl.kind} onChange={(e) => setTpl({ ...tpl, kind: e.target.value })}>
          {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input className="admin-inline" placeholder="Department (optional)" value={tpl.department} onChange={(e) => setTpl({ ...tpl, department: e.target.value })} />
        <input className="admin-inline" placeholder="ID prefix (DOC, PRM, TAX…)" value={tpl.numbering_prefix} onChange={(e) => setTpl({ ...tpl, numbering_prefix: e.target.value })} />
        <select className="admin-inline" value={tpl.approval_permission} onChange={(e) => setTpl({ ...tpl, approval_permission: e.target.value })}>
          {perms.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <div className="admin-subhead" style={{ marginTop: 8 }}>Who may apply</div>
        <div className="chip-set">
          {ACCOUNTS.map((a) => (
            <label key={a} className="admin-check"><input type="checkbox" checked={tpl.applicant.has(a)} onChange={() => toggleAccount(a)} /> {a}</label>
          ))}
        </div>
        <label className="admin-check" style={{ marginTop: 6 }}><input type="checkbox" checked={tpl.auto_issue} onChange={(e) => setTpl({ ...tpl, auto_issue: e.target.checked })} /> auto-issue on approval</label>
        <input className="admin-inline" placeholder="Expires after N days (optional)" value={tpl.expires} onChange={(e) => setTpl({ ...tpl, expires: e.target.value.replace(/\D/g, "") })} />
        <button className="btn btn--stamp" style={{ marginTop: 6 }} onClick={createTemplate}>Create template</button>
      </div>

      <div className="offices-detail">
        {error ? <p className="note note--error">{error}</p> : null}
        {!sel ? <p className="note">Select or create a template to add fields.</p> : (
          <>
            <div className="admin-subhead">Fields on this form</div>
            <table className="ledger">
              <thead><tr><th>#</th><th>Label</th><th>Key</th><th>Type</th><th>Req</th><th></th></tr></thead>
              <tbody>
                {fields.map((f) => (
                  <tr key={f.id}>
                    <td>{f.sort_order}</td><td>{f.label}</td><td><code>{f.key}</code></td>
                    <td>{f.field_type}</td><td>{f.required ? "✓" : ""}</td>
                    <td style={{ textAlign: "right" }}><button className="linkish" onClick={() => delField(f.id)}>remove</button></td>
                  </tr>
                ))}
                {fields.length === 0 ? <tr><td className="note" style={{ border: 0 }}>No fields yet.</td></tr> : null}
              </tbody>
            </table>
            <div className="admin-subhead" style={{ marginTop: 12 }}>Add a field</div>
            <div className="admin-row">
              <input className="admin-search" placeholder="Label" value={fld.label} onChange={(e) => setFld({ ...fld, label: e.target.value })} />
              <input className="admin-search" placeholder="key" value={fld.key} onChange={(e) => setFld({ ...fld, key: e.target.value.replace(/\s/g, "_").toLowerCase() })} style={{ maxWidth: 140 }} />
              <select value={fld.field_type} onChange={(e) => setFld({ ...fld, field_type: e.target.value as FieldType })}>
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <label className="admin-check"><input type="checkbox" checked={fld.required} onChange={(e) => setFld({ ...fld, required: e.target.checked })} /> required</label>
            </div>
            {["dropdown", "radio"].includes(fld.field_type) ? (
              <input className="admin-search" style={{ width: "100%", marginBottom: 8 }} placeholder="Options, comma separated" value={fld.options} onChange={(e) => setFld({ ...fld, options: e.target.value })} />
            ) : null}
            <button className="btn" onClick={addField}>Add field</button>
          </>
        )}
      </div>
    </div>
  );
}
