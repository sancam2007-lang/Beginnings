import { useState } from "react";
import { supabase } from "../../lib/supabase";

interface Found { id: string; public_no: string | null; status: string; template: string | null; }

export function ReviewArchive() {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    setError(null); setFound(undefined);
    const term = q.trim();
    if (!term) return;
    const { data } = await supabase.from("document_submissions")
      .select("id,public_no,status,document_templates(name)").eq("public_no", term).maybeSingle();
    if (!data) return setFound(null);
    const r = data as unknown as { id: string; public_no: string | null; status: string; document_templates: { name: string } | null };
    setFound({ id: r.id, public_no: r.public_no, status: r.status, template: r.document_templates?.name ?? null });
  }

  async function voidDoc() {
    if (!found) return;
    setBusy(true); setError(null);
    const { error: e } = await supabase.rpc("process_stamps", { p_submission: found.id, p_stamps: ["void"], p_comment: "Voided from archive" });
    setBusy(false);
    if (e) return setError(e.message);
    search();
  }

  return (
    <div>
      <div className="doc-seal">Records Archive</div>
      <div className="admin-row">
        <input className="admin-search" placeholder="Tracking number (e.g. DOC-000123)" value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} />
        <button className="btn" onClick={search}>Retrieve</button>
      </div>
      {error ? <p className="note note--error">{error}</p> : null}
      {found === null ? <p className="note">No record found, or you're not cleared to view it.</p> : null}
      {found ? (
        <table className="ledger"><tbody>
          <tr><th>Document</th><td>{found.template ?? "—"}</td></tr>
          <tr><th>Tracking</th><td>{found.public_no}</td></tr>
          <tr><th>Status</th><td>{found.status}</td></tr>
        </tbody></table>
      ) : null}
      {found && ["issued", "approved"].includes(found.status) ? (
        <div className="btn-row"><button className="btn btn--ghost" onClick={voidDoc} disabled={busy}>{busy ? "Voiding…" : "Void / revoke this document"}</button></div>
      ) : null}
      <p className="note">Retrieve a document by its tracking number to review or revoke it.</p>
    </div>
  );
}
