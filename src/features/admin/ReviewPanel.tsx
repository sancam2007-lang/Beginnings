import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

const PENDING = ["submitted", "received", "under_review", "info_requested"];
const NEXT: Record<string, string[]> = {
  submitted: ["received", "rejected"],
  received: ["under_review", "info_requested", "rejected"],
  under_review: ["approved", "rejected", "info_requested"],
  info_requested: ["under_review", "rejected"],
  approved: ["issued", "archived"],
};

interface Submission {
  id: string; public_no: string | null; status: string; created_at: string;
  template: { name: string; kind: string } | null;
}
interface FieldValue { value: string | null; field: { label: string } | null; }

export function ReviewPanel() {
  const [rows, setRows] = useState<Submission[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [values, setValues] = useState<FieldValue[]>([]);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase.from("document_submissions")
      .select("id,public_no,status,created_at,document_templates(name,kind)")
      .in("status", PENDING).order("created_at", { ascending: true });
    const mapped = ((data as unknown as { id: string; public_no: string | null; status: string; created_at: string; document_templates: { name: string; kind: string } | null }[]) ?? [])
      .map((r) => ({ id: r.id, public_no: r.public_no, status: r.status, created_at: r.created_at, template: r.document_templates }));
    setRows(mapped);
  }
  useEffect(() => { load(); }, []);

  async function loadValues(id: string) {
    const { data } = await supabase.from("document_field_values")
      .select("value,document_template_fields(label)").eq("submission_id", id);
    const mapped = ((data as unknown as { value: string | null; document_template_fields: { label: string } | null }[]) ?? [])
      .map((r) => ({ value: r.value, field: r.document_template_fields }));
    setValues(mapped);
  }
  useEffect(() => { if (sel) loadValues(sel); else setValues([]); }, [sel]);

  async function act(to: string) {
    if (!sel) return;
    setError(null);
    const { error: e } = await supabase.rpc("document_transition", { p_submission: sel, p_to: to, p_comment: comment.trim() || null });
    if (e) return setError(e.message);
    setComment("");
    setSel(null);
    load();
  }

  if (rows === null) return <p className="note">Sorting the incoming tray…</p>;
  const current = rows.find((r) => r.id === sel);

  return (
    <div className="offices-grid">
      <div className="offices-list">
        <div className="admin-subhead">Awaiting review ({rows.length})</div>
        {rows.map((r) => (
          <button key={r.id} className={`office-item${sel === r.id ? " is-selected" : ""}`} onClick={() => setSel(r.id)}>
            {r.template?.name ?? "Document"}
            <span className="office-min">{r.public_no ?? "draft"} · {r.status}</span>
          </button>
        ))}
        {rows.length === 0 ? <p className="note">Nothing awaiting review.</p> : null}
      </div>

      <div className="offices-detail">
        {error ? <p className="note note--error">{error}</p> : null}
        {!current ? <p className="note">Select a submission to review.</p> : (
          <>
            <div className="admin-subhead">{current.template?.name} · {current.public_no ?? "—"} · {current.status}</div>
            <table className="ledger"><tbody>
              {values.map((v, i) => <tr key={i}><th style={{ width: "40%" }}>{v.field?.label ?? "—"}</th><td>{v.value || "—"}</td></tr>)}
              {values.length === 0 ? <tr><td className="note" style={{ border: 0 }}>No field values recorded.</td></tr> : null}
            </tbody></table>
            <div className="admin-subhead" style={{ marginTop: 12 }}>Ruling</div>
            <textarea className="admin-textarea" placeholder="Comment (optional, recorded in the document's history)…" value={comment} onChange={(e) => setComment(e.target.value)} />
            <div className="admin-row" style={{ marginTop: 8 }}>
              {(NEXT[current.status] ?? []).map((to) => (
                <button key={to} className={`btn${["rejected"].includes(to) ? " btn--ghost" : " btn--stamp"}`} onClick={() => act(to)}>{to}</button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
