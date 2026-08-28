import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { Stamp } from "../../components/paper/Stamp";
import type { DocumentTemplate, TemplateField } from "../../lib/types";

export function DocumentRequest() {
  const { profile } = useAuth();
  const [templates, setTemplates] = useState<DocumentTemplate[] | null>(null);
  const [chosen, setChosen] = useState<DocumentTemplate | null>(null);

  useEffect(() => {
    supabase
      .from("document_templates")
      .select("id,code,kind,name,description,department,applicant_account_types,is_active")
      .eq("is_active", true)
      .then(({ data }) => setTemplates((data as DocumentTemplate[]) ?? []));
  }, []);

  const available = useMemo(() => {
    if (!templates || !profile) return [];
    return templates.filter((t) => t.applicant_account_types.includes(profile.account_type));
  }, [templates, profile]);

  if (chosen) {
    return <DocumentForm template={chosen} onBack={() => setChosen(null)} />;
  }

  if (templates === null) return <p className="note">Fetching the forms cabinet…</p>;

  return (
    <div>
      <div className="doc-seal">Government Forms</div>
      {available.length === 0 ? (
        <p className="note">No forms are available to your account type right now.</p>
      ) : (
        <table className="ledger">
          <tbody>
            {available.map((t) => (
              <tr key={t.id}>
                <td>
                  <div>{t.name}</div>
                  <div style={{ opacity: 0.65, fontSize: 12 }}>
                    {t.department ?? t.kind}
                  </div>
                </td>
                <td style={{ width: 90, textAlign: "right" }}>
                  <button className="linkish" onClick={() => setChosen(t)}>
                    request
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DocumentForm({
  template,
  onBack,
}: {
  template: DocumentTemplate;
  onBack: () => void;
}) {
  const { profile } = useAuth();
  const [fields, setFields] = useState<TemplateField[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("document_template_fields")
      .select("id,template_id,key,label,description,field_type,required,sort_order,options")
      .eq("template_id", template.id)
      .order("sort_order")
      .then(({ data }) => setFields((data as TemplateField[]) ?? []));
  }, [template.id]);

  function set(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  async function submit() {
    if (!fields || !profile) return;
    setError(null);
    for (const f of fields) {
      if (f.required && f.field_type !== "declaration" && !values[f.key]?.trim()) {
        setError(`${f.label} is required.`);
        return;
      }
    }
    setBusy(true);
    try {
      const { data: sub, error: subErr } = await supabase
        .from("document_submissions")
        .insert({
          template_id: template.id,
          submitted_by: profile.id,
          region_id: profile.home_region_id,
          status: "draft",
        })
        .select("id")
        .single();
      if (subErr) throw subErr;
      const submissionId = (sub as { id: string }).id;

      const rows = fields
        .filter((f) => f.field_type !== "declaration")
        .map((f) => ({ submission_id: submissionId, field_id: f.id, value: values[f.key] ?? "" }));
      if (rows.length) {
        const { error: fvErr } = await supabase.from("document_field_values").insert(rows);
        if (fvErr) throw fvErr;
      }

      const { error: rpcErr } = await supabase.rpc("document_transition", {
        p_submission: submissionId,
        p_to: "submitted",
        p_comment: null,
      });
      if (rpcErr) throw rpcErr;

      const { data: done } = await supabase
        .from("document_submissions")
        .select("public_no")
        .eq("id", submissionId)
        .single();
      setReceipt((done as { public_no: string | null })?.public_no ?? "SUBMITTED");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Submission failed.");
    } finally {
      setBusy(false);
    }
  }

  if (receipt) {
    return (
      <div style={{ textAlign: "center" }}>
        <div className="doc-seal">Filed with the Ministry</div>
        <Stamp text="Received" sub={new Date().toLocaleDateString()} />
        <p style={{ marginTop: 18 }}>
          Your {template.name.toLowerCase()} has been placed in the outgoing tray.
        </p>
        <p className="doc-meta">Tracking number: {receipt}</p>
        <div className="btn-row" style={{ justifyContent: "center" }}>
          <button className="btn btn--ghost" onClick={onBack}>Back to forms</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="doc-seal">{template.department ?? "Government"}</div>
      <h2 className="doc-h">{template.name}</h2>
      {template.description ? <p className="doc-meta">{template.description}</p> : null}

      {fields === null ? (
        <p className="note">Printing the form…</p>
      ) : (
        fields.map((f) => <FieldInput key={f.id} field={f} value={values[f.key] ?? ""} onChange={set} />)
      )}

      {error ? <p className="note note--error">{error}</p> : null}

      <div className="btn-row">
        <button className="btn btn--ghost" onClick={onBack} disabled={busy}>Cancel</button>
        <button className="btn btn--stamp" onClick={submit} disabled={busy || !fields}>
          {busy ? "Filing…" : "Seal & submit"}
        </button>
      </div>
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: TemplateField;
  value: string;
  onChange: (key: string, v: string) => void;
}) {
  if (field.field_type === "declaration") {
    return (
      <div className="field field--check">
        <input
          id={field.id}
          type="checkbox"
          checked={value === "true"}
          onChange={(e) => onChange(field.key, e.target.checked ? "true" : "")}
        />
        <label htmlFor={field.id} style={{ margin: 0 }}>{field.label}</label>
      </div>
    );
  }

  const label = (
    <label htmlFor={field.id}>
      {field.label}
      {field.required ? " *" : ""}
    </label>
  );

  if (field.field_type === "long_text") {
    return (
      <div className="field">
        {label}
        <textarea id={field.id} value={value} onChange={(e) => onChange(field.key, e.target.value)} />
      </div>
    );
  }

  const type =
    field.field_type === "date" ? "date"
      : field.field_type === "number" || field.field_type === "currency" ? "number"
      : "text";

  return (
    <div className="field">
      {label}
      <input id={field.id} type={type} value={value} onChange={(e) => onChange(field.key, e.target.value)} />
    </div>
  );
}
