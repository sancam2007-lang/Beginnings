import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { Stamp } from "../../components/paper/Stamp";
import type { DocumentTemplate, TemplateField } from "../../lib/types";

interface Filing { id: string; public_no: string | null; status: string; template: { name: string } | null; }

export function CompanyFilings({ companyId }: { companyId: string }) {
  const [templates, setTemplates] = useState<DocumentTemplate[] | null>(null);
  const [filings, setFilings] = useState<Filing[]>([]);
  const [chosen, setChosen] = useState<DocumentTemplate | null>(null);

  async function load() {
    const { data: t } = await supabase.from("document_templates")
      .select("id,code,kind,name,description,department,applicant_account_types,is_active").eq("is_active", true);
    setTemplates(((t as DocumentTemplate[]) ?? []).filter((x) => x.applicant_account_types.includes("company")));
    const { data: f } = await supabase.from("document_submissions")
      .select("id,public_no,status,document_templates(name)").eq("on_behalf_of_company_id", companyId)
      .order("created_at", { ascending: false });
    const mapped = ((f as unknown as { id: string; public_no: string | null; status: string; document_templates: { name: string } | null }[]) ?? [])
      .map((r) => ({ id: r.id, public_no: r.public_no, status: r.status, template: r.document_templates }));
    setFilings(mapped);
  }
  useEffect(() => { load(); }, [companyId]);

  if (chosen) return <FilingForm template={chosen} companyId={companyId} onDone={() => { setChosen(null); load(); }} />;
  if (templates === null) return <p className="note">Fetching the filing cabinet…</p>;

  return (
    <div>
      <div className="doc-seal">Government Filings</div>
      <div className="admin-subhead">Available forms</div>
      {templates.length === 0 ? <p className="note">No company forms available yet.</p> : (
        <table className="ledger"><tbody>
          {templates.map((t) => (
            <tr key={t.id}>
              <td>{t.name}<div style={{ opacity: 0.6, fontSize: 12 }}>{t.department ?? t.kind}</div></td>
              <td style={{ textAlign: "right" }}><button className="linkish" onClick={() => setChosen(t)}>file</button></td>
            </tr>
          ))}
        </tbody></table>
      )}
      <div className="admin-subhead" style={{ marginTop: 14 }}>Our filings</div>
      <table className="ledger"><tbody>
        {filings.map((f) => (
          <tr key={f.id}><td>{f.template?.name ?? "Document"}</td><td>{f.public_no ?? "draft"}</td><td>{f.status}</td></tr>
        ))}
        {filings.length === 0 ? <tr><td className="note" style={{ border: 0 }}>No filings yet.</td></tr> : null}
      </tbody></table>
    </div>
  );
}

function FilingForm({ template, companyId, onDone }: { template: DocumentTemplate; companyId: string; onDone: () => void }) {
  const { profile } = useAuth();
  const [fields, setFields] = useState<TemplateField[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("document_template_fields")
      .select("id,template_id,key,label,description,field_type,required,sort_order,options")
      .eq("template_id", template.id).order("sort_order")
      .then(({ data }) => setFields((data as TemplateField[]) ?? []));
  }, [template.id]);

  async function submit() {
    if (!fields || !profile) return;
    setError(null);
    for (const f of fields) {
      if (f.required && f.field_type !== "declaration" && !values[f.key]?.trim()) return setError(`${f.label} is required.`);
    }
    setBusy(true);
    try {
      const { data: sub, error: subErr } = await supabase.from("document_submissions")
        .insert({ template_id: template.id, submitted_by: profile.id, on_behalf_of_company_id: companyId, status: "draft" })
        .select("id").single();
      if (subErr) throw subErr;
      const id = (sub as { id: string }).id;
      const rows = fields.filter((f) => f.field_type !== "declaration").map((f) => ({ submission_id: id, field_id: f.id, value: values[f.key] ?? "" }));
      if (rows.length) {
        const { error: fvErr } = await supabase.from("document_field_values").insert(rows);
        if (fvErr) throw fvErr;
      }
      const { error: rpcErr } = await supabase.rpc("document_transition", { p_submission: id, p_to: "submitted", p_comment: null });
      if (rpcErr) throw rpcErr;
      const { data: done } = await supabase.from("document_submissions").select("public_no").eq("id", id).single();
      setReceipt((done as { public_no: string | null })?.public_no ?? "SUBMITTED");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Filing failed.");
    } finally {
      setBusy(false);
    }
  }

  if (receipt) {
    return (
      <div style={{ textAlign: "center" }}>
        <div className="doc-seal">Filed with the Ministry</div>
        <Stamp text="Received" />
        <p className="doc-meta" style={{ marginTop: 14 }}>Tracking number: {receipt}</p>
        <div className="btn-row" style={{ justifyContent: "center" }}><button className="btn btn--ghost" onClick={onDone}>Back to filings</button></div>
      </div>
    );
  }

  return (
    <div>
      <div className="doc-seal">{template.department ?? "Government"}</div>
      <h2 className="doc-h">{template.name}</h2>
      {fields === null ? <p className="note">Printing the form…</p> : fields.map((f) => (
        f.field_type === "declaration" ? (
          <div key={f.id} className="field field--check">
            <input id={f.id} type="checkbox" checked={values[f.key] === "true"} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked ? "true" : "" })} />
            <label htmlFor={f.id} style={{ margin: 0 }}>{f.label}</label>
          </div>
        ) : (
          <div key={f.id} className="field">
            <label htmlFor={f.id}>{f.label}{f.required ? " *" : ""}</label>
            {f.field_type === "long_text"
              ? <textarea id={f.id} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
              : <input id={f.id} type={f.field_type === "date" ? "date" : (f.field_type === "number" || f.field_type === "currency") ? "number" : "text"} value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />}
          </div>
        )
      ))}
      {error ? <p className="note note--error">{error}</p> : null}
      <div className="btn-row">
        <button className="btn btn--ghost" onClick={onDone} disabled={busy}>Cancel</button>
        <button className="btn btn--stamp" onClick={submit} disabled={busy || !fields}>{busy ? "Filing…" : "Seal & submit"}</button>
      </div>
    </div>
  );
}
