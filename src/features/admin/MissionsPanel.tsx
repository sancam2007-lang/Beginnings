import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

const ENROLL = ["open", "application", "assigned", "invitation"];
const NEXT: Record<string, string[]> = {
  draft: ["available", "cancelled"],
  available: ["assigned", "active", "cancelled"],
  assigned: ["active", "available", "cancelled"],
  active: ["awaiting_debrief", "failed", "cancelled"],
  awaiting_debrief: ["completed", "failed"],
  completed: ["archived"],
  failed: ["archived"],
  cancelled: ["archived"],
};

interface Mission { id: string; public_no: string | null; title: string; status: string; classification: string; }
interface Debrief { id: string; author_id: string; report: string | null; outcome: string | null; success: boolean | null; grade: string | null; }

export function MissionsPanel() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<Mission[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [debriefs, setDebriefs] = useState<Debrief[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", description: "", location: "", reward: "", enrollment_mode: "open", slots: "" });

  async function load() {
    const { data } = await supabase.from("missions").select("id,public_no,title,status,classification").order("created_at", { ascending: false });
    setRows((data as Mission[]) ?? []);
  }
  useEffect(() => { load(); }, []);

  async function loadDebriefs(id: string) {
    const { data } = await supabase.from("mission_debriefs").select("id,author_id,report,outcome,success,grade").eq("mission_id", id);
    setDebriefs((data as Debrief[]) ?? []);
  }
  useEffect(() => { if (sel) loadDebriefs(sel); else setDebriefs([]); }, [sel]);

  async function create() {
    setError(null);
    if (!form.title.trim()) return setError("A mission needs a title.");
    const { data, error: e } = await supabase.from("missions").insert({
      title: form.title.trim(), description: form.description.trim() || null,
      location: form.location.trim() || null, reward: form.reward.trim() || null,
      enrollment_mode: form.enrollment_mode, available_slots: form.slots ? Number(form.slots) : null,
      created_by: profile?.id ?? null,
    }).select("id").single();
    if (e) return setError(e.message);
    setForm({ ...form, title: "", description: "", location: "", reward: "", slots: "" });
    await load();
    setSel((data as { id: string }).id);
  }

  async function transition(to: string) {
    if (!sel) return;
    setError(null);
    const { error: e } = await supabase.rpc("mission_transition", { p_mission: sel, p_to: to, p_comment: null });
    if (e) return setError(e.message);
    await load();
  }

  async function grade(id: string, success: boolean) {
    setError(null);
    const { error: e } = await supabase.from("mission_debriefs")
      .update({ success, graded_by: profile?.id ?? null, grade: success ? "Pass" : "Fail" }).eq("id", id);
    if (e) return setError(e.message);
    if (sel) loadDebriefs(sel);
  }

  if (rows === null) return <p className="note">Opening the dispatch board…</p>;
  const current = rows.find((r) => r.id === sel);

  return (
    <div className="offices-grid">
      <div className="offices-list">
        <div className="admin-subhead">Missions</div>
        {rows.map((r) => (
          <button key={r.id} className={`office-item${sel === r.id ? " is-selected" : ""}`} onClick={() => setSel(r.id)}>
            {r.title}<span className="office-min">{r.public_no ?? "draft"} · {r.status}</span>
          </button>
        ))}
        <div className="admin-subhead" style={{ marginTop: 14 }}>New mission</div>
        <input className="admin-inline" placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <input className="admin-inline" placeholder="Location" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
        <input className="admin-inline" placeholder="Reward" value={form.reward} onChange={(e) => setForm({ ...form, reward: e.target.value })} />
        <select className="admin-inline" value={form.enrollment_mode} onChange={(e) => setForm({ ...form, enrollment_mode: e.target.value })}>{ENROLL.map((m) => <option key={m}>{m}</option>)}</select>
        <input className="admin-inline" placeholder="Slots (optional)" value={form.slots} onChange={(e) => setForm({ ...form, slots: e.target.value.replace(/\D/g, "") })} />
        <textarea className="admin-textarea" placeholder="Description…" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <button className="btn btn--stamp" style={{ marginTop: 6 }} onClick={create}>Post mission</button>
      </div>

      <div className="offices-detail">
        {error ? <p className="note note--error">{error}</p> : null}
        {!current ? <p className="note">Select or create a mission.</p> : (
          <>
            <div className="admin-subhead">{current.title} — {current.status} · {current.classification}</div>
            <div className="admin-row">
              {(NEXT[current.status] ?? []).map((to) => (
                <button key={to} className={`btn${to === "cancelled" || to === "failed" ? " btn--ghost" : " btn--stamp"}`} onClick={() => transition(to)}>{to}</button>
              ))}
            </div>
            <div className="admin-subhead" style={{ marginTop: 12 }}>Debriefs</div>
            {debriefs.map((d) => (
              <div key={d.id} className="debrief">
                <div className="doc-meta">{d.outcome ?? "—"} · {d.success === null ? "ungraded" : d.success ? "PASS" : "FAIL"}</div>
                <p style={{ margin: "4px 0" }}>{d.report ?? "No report filed."}</p>
                <div className="admin-row">
                  <button className="btn" onClick={() => grade(d.id, true)}>Grade pass</button>
                  <button className="btn btn--ghost" onClick={() => grade(d.id, false)}>Grade fail</button>
                </div>
              </div>
            ))}
            {debriefs.length === 0 ? <p className="note">No debriefs submitted.</p> : null}
          </>
        )}
      </div>
    </div>
  );
}
