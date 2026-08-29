import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { DocumentTemplate } from "../../lib/types";
import { DocumentForm } from "../civilian/DocumentRequest";

interface Filing { id: string; public_no: string | null; status: string; template: { name: string } | null; }

export function CompanyFilings({ companyId }: { companyId: string }) {
  const [templates, setTemplates] = useState<DocumentTemplate[] | null>(null);
  const [filings, setFilings] = useState<Filing[]>([]);
  const [chosen, setChosen] = useState<DocumentTemplate | null>(null);

  async function load() {
    const { data: t } = await supabase.from("document_templates")
      .select("id,code,kind,name,description,department,applicant_account_types,is_active,background_key,page_aspect")
      .eq("is_active", true);
    setTemplates(((t as DocumentTemplate[]) ?? []).filter((x) => x.applicant_account_types.includes("company")));
    const { data: f } = await supabase.from("document_submissions")
      .select("id,public_no,status,document_templates(name)").eq("on_behalf_of_company_id", companyId)
      .order("created_at", { ascending: false });
    const mapped = ((f as unknown as { id: string; public_no: string | null; status: string; document_templates: { name: string } | null }[]) ?? [])
      .map((r) => ({ id: r.id, public_no: r.public_no, status: r.status, template: r.document_templates }));
    setFilings(mapped);
  }
  useEffect(() => { load(); }, [companyId]);

  if (chosen) return <DocumentForm template={chosen} onBehalfCompanyId={companyId} onBack={() => { setChosen(null); load(); }} />;
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
