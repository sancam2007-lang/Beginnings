import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

interface Processed { id: string; to_status: string; created_at: string; comment: string | null; public_no: string | null; template: string | null; }

export function OutgoingTray() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<Processed[] | null>(null);

  useEffect(() => {
    if (!profile) return;
    supabase.from("document_workflow_events")
      .select("id,to_status,created_at,comment,document_submissions(public_no,document_templates(name))")
      .eq("actor_id", profile.id).eq("action", "stamped")
      .order("created_at", { ascending: false }).limit(50)
      .then(({ data }) => {
        const mapped = ((data as unknown as { id: string; to_status: string; created_at: string; comment: string | null; document_submissions: { public_no: string | null; document_templates: { name: string } | null } | null }[]) ?? [])
          .map((r) => ({ id: r.id, to_status: r.to_status, created_at: r.created_at, comment: r.comment, public_no: r.document_submissions?.public_no ?? null, template: r.document_submissions?.document_templates?.name ?? null }));
        setRows(mapped);
      });
  }, [profile]);

  if (rows === null) return <p className="note">Opening the outgoing tray…</p>;
  return (
    <div>
      <div className="doc-seal">Processed Documents</div>
      {rows.length === 0 ? <p className="note">You haven't processed any documents yet.</p> : (
        <table className="ledger"><tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.template ?? "Document"}<div style={{ opacity: 0.6, fontSize: 12 }}>{r.public_no ?? "—"}</div></td>
              <td>{r.to_status}</td>
              <td style={{ opacity: 0.7 }}>{new Date(r.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}
