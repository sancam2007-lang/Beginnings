import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

interface Mission {
  id: string; public_no: string | null; title: string; description: string | null;
  location: string | null; classification: string; difficulty: string | null;
  reward: string | null; recommended_party_size: number | null;
  enrollment_mode: string; available_slots: number | null;
}

export function MissionBoard() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<Mission[] | null>(null);
  const [mine, setMine] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase.from("missions")
      .select("id,public_no,title,description,location,classification,difficulty,reward,recommended_party_size,enrollment_mode,available_slots")
      .eq("status", "available").order("deadline", { ascending: true, nullsFirst: false });
    setRows((data as Mission[]) ?? []);
    if (profile) {
      const { data: m } = await supabase.from("mission_members").select("mission_id,state").eq("user_id", profile.id);
      const map: Record<string, string> = {};
      ((m as { mission_id: string; state: string }[]) ?? []).forEach((x) => { map[x.mission_id] = x.state; });
      setMine(map);
    }
  }
  useEffect(() => { load(); }, [profile]);

  async function act(mission: Mission) {
    setError(null);
    const rpc = mission.enrollment_mode === "application" ? "apply_mission" : "join_mission";
    const { error: e } = await supabase.rpc(rpc, { p_mission: mission.id });
    if (e) return setError(e.message);
    load();
  }

  if (rows === null) return <p className="note">Reading the mission board…</p>;

  return (
    <div>
      <div className="doc-seal">Mission Board · Dispatch</div>
      {error ? <p className="note note--error">{error}</p> : null}
      {rows.length === 0 ? <p className="note">No missions posted at your clearance.</p> : null}
      {rows.map((m) => {
        const state = mine[m.id];
        const byAssignment = m.enrollment_mode === "assigned" || m.enrollment_mode === "invitation";
        return (
          <div key={m.id} className="mission-card">
            <div className="mission-card__head">
              <strong>{m.title}</strong>
              <span className={`clr clr--${m.classification}`}>{m.classification}</span>
            </div>
            <div className="doc-meta">
              {m.public_no ? `${m.public_no} · ` : ""}{m.location ?? "—"}
              {m.difficulty ? ` · ${m.difficulty}` : ""}
              {m.reward ? ` · reward ${m.reward}` : ""}
              {m.available_slots != null ? ` · ${m.available_slots} slots` : ""}
            </div>
            {m.description ? <p style={{ margin: "4px 0" }}>{m.description}</p> : null}
            <div className="btn-row">
              {state ? <span className="note" style={{ margin: 0 }}>You are {state} on this mission.</span>
                : byAssignment ? <span className="note" style={{ margin: 0 }}>By assignment only.</span>
                : <button className="btn btn--stamp" onClick={() => act(m)}>{m.enrollment_mode === "application" ? "Apply" : "Accept"}</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
