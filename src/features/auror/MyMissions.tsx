import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

interface Mission { id: string; public_no: string | null; title: string; status: string; classification: string; }
interface Briefing { summary: string | null; intelligence: string | null; objectives: string | null; classified_notes: string | null; }

export function MyMissions() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<Mission[] | null>(null);
  const [sel, setSel] = useState<Mission | null>(null);

  async function load() {
    if (!profile) return;
    const { data: mem } = await supabase.from("mission_members").select("mission_id,state").eq("user_id", profile.id).neq("state", "withdrawn");
    const ids = ((mem as { mission_id: string }[]) ?? []).map((x) => x.mission_id);
    if (ids.length === 0) { setRows([]); return; }
    const { data } = await supabase.from("missions").select("id,public_no,title,status,classification").in("id", ids).order("created_at", { ascending: false });
    setRows((data as Mission[]) ?? []);
  }
  useEffect(() => { load(); }, [profile]);

  if (sel) return <MissionDetail mission={sel} onBack={() => { setSel(null); load(); }} />;
  if (rows === null) return <p className="note">Gathering your assignments…</p>;

  return (
    <div>
      <div className="doc-seal">Your Assignments</div>
      {rows.length === 0 ? <p className="note">You have no active assignments.</p> : (
        <table className="ledger"><tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td>{m.title}<div style={{ opacity: 0.6, fontSize: 12 }}>{m.public_no ?? "—"} · {m.classification}</div></td>
              <td>{m.status}</td>
              <td style={{ textAlign: "right" }}><button className="linkish" onClick={() => setSel(m)}>open</button></td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}

function MissionDetail({ mission, onBack }: { mission: Mission; onBack: () => void }) {
  const { profile } = useAuth();
  const [brief, setBrief] = useState<Briefing | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [debrief, setDebrief] = useState({ report: "", outcome: "", objective_status: "", casualties: "", injuries: "", discovered_info: "", observations: "" });
  const [filed, setFiled] = useState(false);

  useEffect(() => {
    supabase.from("mission_briefings").select("summary,intelligence,objectives,classified_notes").eq("mission_id", mission.id).maybeSingle()
      .then(({ data }) => setBrief((data as Briefing) ?? null));
  }, [mission.id]);

  const canDebrief = ["active", "awaiting_debrief"].includes(mission.status);
  const canWithdraw = ["available", "assigned"].includes(mission.status);

  async function withdraw() {
    setError(null);
    const { error: e } = await supabase.rpc("withdraw_mission", { p_mission: mission.id });
    if (e) return setError(e.message);
    onBack();
  }

  async function fileDebrief() {
    if (!profile) return;
    setError(null);
    const { error: e } = await supabase.from("mission_debriefs").insert({
      mission_id: mission.id, author_id: profile.id, ...debrief,
    });
    if (e) return setError(e.message);
    setFiled(true);
  }

  return (
    <div>
      <button className="linkish" onClick={onBack}>‹ back to assignments</button>
      <div className="doc-seal" style={{ marginTop: 8 }}>{mission.title}</div>
      <div className="doc-meta">{mission.public_no ?? "—"} · {mission.status} · clearance {mission.classification}</div>

      <div className="admin-subhead" style={{ marginTop: 10 }}>Briefing</div>
      {brief === undefined ? <p className="note">Opening the sealed folder…</p>
        : brief === null ? <p className="note">No briefing has been issued.</p>
        : <table className="ledger"><tbody>
            {brief.summary ? <tr><th>Summary</th><td>{brief.summary}</td></tr> : null}
            {brief.objectives ? <tr><th>Objectives</th><td>{brief.objectives}</td></tr> : null}
            {brief.intelligence ? <tr><th>Intelligence</th><td>{brief.intelligence}</td></tr> : null}
            {brief.classified_notes ? <tr><th>Classified</th><td>{brief.classified_notes}</td></tr> : null}
          </tbody></table>}

      {error ? <p className="note note--error">{error}</p> : null}

      {canWithdraw ? <div className="btn-row"><button className="btn btn--ghost" onClick={withdraw}>Withdraw from mission</button></div> : null}

      {canDebrief ? (
        filed ? <p className="note" style={{ marginTop: 12 }}>Your debrief has been filed with your supervisor.</p> : (
          <>
            <div className="admin-subhead" style={{ marginTop: 12 }}>File a debrief</div>
            <div className="field"><label>Report</label><textarea value={debrief.report} onChange={(e) => setDebrief({ ...debrief, report: e.target.value })} /></div>
            <div className="field"><label>Outcome</label><input value={debrief.outcome} onChange={(e) => setDebrief({ ...debrief, outcome: e.target.value })} /></div>
            <div className="field"><label>Objective status</label><input value={debrief.objective_status} onChange={(e) => setDebrief({ ...debrief, objective_status: e.target.value })} /></div>
            <div className="field"><label>Casualties</label><input value={debrief.casualties} onChange={(e) => setDebrief({ ...debrief, casualties: e.target.value })} /></div>
            <div className="field"><label>Injuries</label><input value={debrief.injuries} onChange={(e) => setDebrief({ ...debrief, injuries: e.target.value })} /></div>
            <div className="field"><label>Information discovered</label><textarea value={debrief.discovered_info} onChange={(e) => setDebrief({ ...debrief, discovered_info: e.target.value })} /></div>
            <div className="field"><label>Observations</label><textarea value={debrief.observations} onChange={(e) => setDebrief({ ...debrief, observations: e.target.value })} /></div>
            <div className="btn-row"><button className="btn btn--stamp" onClick={fileDebrief}>Submit debrief</button></div>
          </>
        )
      ) : null}
    </div>
  );
}
