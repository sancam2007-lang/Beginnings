import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { StampReview } from "./StampReview";

interface QueueItem { id: string; public_no: string | null; status: string; template_name: string; kind: string; }

export function ReviewInbox() {
  const [rows, setRows] = useState<QueueItem[] | null>(null);
  const [sel, setSel] = useState<QueueItem | null>(null);

  async function load() {
    const { data } = await supabase.rpc("my_review_queue");
    setRows((data as QueueItem[]) ?? []);
  }
  useEffect(() => { load(); }, []);

  if (sel) return (
    <StampReview
      submissionId={sel.id} publicNo={sel.public_no} templateName={sel.template_name} status={sel.status}
      onDone={() => { setSel(null); load(); }}
    />
  );

  if (rows === null) return <p className="note">Sorting the incoming tray…</p>;
  return (
    <div>
      <div className="doc-seal">Awaiting Your Ruling ({rows.length})</div>
      {rows.length === 0 ? <p className="note">Nothing in your review tray.</p> : (
        <table className="ledger"><tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.template_name}<div style={{ opacity: 0.6, fontSize: 12 }}>{r.public_no ?? "—"} · {r.kind}</div></td>
              <td>{r.status}</td>
              <td style={{ textAlign: "right" }}><button className="linkish" onClick={() => setSel(r)}>stamp</button></td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}
