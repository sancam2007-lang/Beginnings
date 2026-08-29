import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

interface AurorProfile {
  public_no: string; rank: string | null; specialization: string | null;
  clearance: string; is_active: boolean;
}
interface Record { completed: number; failed: number; active: number; total: number; }

export function AgentFile() {
  const { profile } = useAuth();
  const [ap, setAp] = useState<AurorProfile | null | undefined>(undefined);
  const [record, setRecord] = useState<Record | null>(null);
  const [commends, setCommends] = useState<{ id: string; title: string; note: string | null }[]>([]);
  const [discipline, setDiscipline] = useState<{ id: string; note: string; created_at: string }[]>([]);

  useEffect(() => {
    if (!profile) return;
    supabase.from("auror_profiles").select("public_no,rank,specialization,clearance,is_active").eq("user_id", profile.id).maybeSingle()
      .then(({ data }) => setAp((data as AurorProfile) ?? null));
    supabase.rpc("auror_record", { p_user: profile.id }).then(({ data }) => setRecord((data as Record) ?? null));
    supabase.from("auror_commendations").select("id,title,note").eq("auror_user_id", profile.id)
      .then(({ data }) => setCommends((data as { id: string; title: string; note: string | null }[]) ?? []));
    supabase.from("auror_disciplinary").select("id,note,created_at").eq("auror_user_id", profile.id)
      .then(({ data }) => setDiscipline((data as { id: string; note: string; created_at: string }[]) ?? []));
  }, [profile]);

  if (ap === undefined) return <p className="note">Retrieving your file…</p>;
  if (ap === null) return (
    <div>
      <div className="doc-seal">Auror Service</div>
      <p className="note">You are not yet enrolled as an active auror. An administrator or the Ministry of Defense must add you to the register before you can take missions.</p>
    </div>
  );

  return (
    <div>
      <div className="doc-seal">Auror Service Record</div>
      <h2 className="doc-h">{profile?.full_name ?? "Agent"}</h2>
      <div className="doc-meta">{ap.public_no} · clearance: {ap.clearance}{ap.is_active ? "" : " · INACTIVE"}</div>
      <table className="ledger">
        <tbody>
          <tr><th>Rank</th><td>{ap.rank ?? "—"}</td></tr>
          <tr><th>Specialization</th><td>{ap.specialization ?? "—"}</td></tr>
          {record ? <>
            <tr><th>Missions completed</th><td>{record.completed}</td></tr>
            <tr><th>Missions failed</th><td>{record.failed}</td></tr>
            <tr><th>Active assignments</th><td>{record.active}</td></tr>
          </> : null}
        </tbody>
      </table>

      {commends.length ? <>
        <div className="admin-subhead" style={{ marginTop: 12 }}>Commendations</div>
        {commends.map((c) => <div key={c.id}><strong>{c.title}</strong>{c.note ? ` — ${c.note}` : ""}</div>)}
      </> : null}

      {discipline.length ? <>
        <div className="admin-subhead" style={{ marginTop: 12 }}>Disciplinary notes</div>
        {discipline.map((d) => <div key={d.id} className="note note--error">{new Date(d.created_at).toLocaleDateString()} — {d.note}</div>)}
      </> : null}
    </div>
  );
}
