import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

const STAMPS: { key: string; label: string; cls: string }[] = [
  { key: "received", label: "Received", cls: "received" },
  { key: "paid", label: "Paid", cls: "paid" },
  { key: "classified", label: "Classified", cls: "classified" },
  { key: "approved", label: "Approved", cls: "approved" },
  { key: "denied", label: "Denied", cls: "denied" },
  { key: "void", label: "Void", cls: "void" },
];

interface FieldValue { value: string | null; field: { label: string } | null; }

export function StampReview({ submissionId, publicNo, templateName, status, onDone }: {
  submissionId: string; publicNo: string | null; templateName: string; status: string; onDone: () => void;
}) {
  const [values, setValues] = useState<FieldValue[]>([]);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("document_field_values").select("value,document_template_fields(label)").eq("submission_id", submissionId)
      .then(({ data }) => {
        const mapped = ((data as unknown as { value: string | null; document_template_fields: { label: string } | null }[]) ?? [])
          .map((r) => ({ value: r.value, field: r.document_template_fields }));
        setValues(mapped);
      });
  }, [submissionId]);

  function toggle(k: string) {
    const n = new Set(applied);
    n.has(k) ? n.delete(k) : n.add(k);
    setApplied(n);
  }

  async function send() {
    if (applied.size === 0) return setError("Apply at least one stamp before sending.");
    setError(null); setBusy(true);
    const { error: e } = await supabase.rpc("process_stamps", {
      p_submission: submissionId, p_stamps: Array.from(applied), p_comment: comment.trim() || null,
    });
    setBusy(false);
    if (e) return setError(e.message);
    onDone();
  }

  return (
    <div>
      <button className="linkish" onClick={onDone}>‹ back to inbox</button>
      <div className="doc-seal" style={{ marginTop: 8 }}>{templateName}</div>
      <div className="doc-meta">{publicNo ?? "—"} · {status}</div>

      <table className="ledger"><tbody>
        {values.map((v, i) => <tr key={i}><th style={{ width: "40%" }}>{v.field?.label ?? "—"}</th><td>{v.value || "—"}</td></tr>)}
        {values.length === 0 ? <tr><td className="note" style={{ border: 0 }}>No field values.</td></tr> : null}
      </tbody></table>

      {applied.size > 0 ? (
        <div className="stamp-row">
          {STAMPS.filter((s) => applied.has(s.key)).map((s) => (
            <span key={s.key} className={`stamp stamp--${s.cls}`}>{s.label}</span>
          ))}
        </div>
      ) : null}

      <div className="admin-subhead" style={{ marginTop: 8 }}>Apply stamps</div>
      <div className="stamp-picker">
        {STAMPS.map((s) => (
          <button key={s.key} className={`stamp-btn${applied.has(s.key) ? " is-on" : ""}`} onClick={() => toggle(s.key)}>{s.label}</button>
        ))}
      </div>
      <textarea className="admin-textarea" placeholder="Note (recorded in the document's history)…" value={comment} onChange={(e) => setComment(e.target.value)} />
      {error ? <p className="note note--error">{error}</p> : null}
      <div className="btn-row">
        <button className="btn btn--stamp" onClick={send} disabled={busy}>{busy ? "Processing…" : "Send to outgoing tray"}</button>
      </div>
    </div>
  );
}
