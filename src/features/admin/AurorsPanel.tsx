import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

const CLEARANCE = ["public", "official", "restricted", "confidential", "secret"];

interface Agent {
  id: string; user_id: string; public_no: string; rank: string | null;
  specialization: string | null; clearance: string; is_active: boolean;
  citizen_id: string; full_name: string | null;
}

export function AurorsPanel() {
  const [rows, setRows] = useState<Agent[] | null>(null);
  const [form, setForm] = useState({ ident: "", rank: "", specialization: "", clearance: "official" });
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase.from("auror_profiles")
      .select("id,user_id,public_no,rank,specialization,clearance,is_active,profiles!inner(citizen_id,full_name)")
      .order("public_no");
    const mapped = ((data as unknown as { id: string; user_id: string; public_no: string; rank: string | null; specialization: string | null; clearance: string; is_active: boolean; profiles: { citizen_id: string; full_name: string | null } }[]) ?? [])
      .map((a) => ({ id: a.id, user_id: a.user_id, public_no: a.public_no, rank: a.rank, specialization: a.specialization, clearance: a.clearance, is_active: a.is_active, citizen_id: a.profiles.citizen_id, full_name: a.profiles.full_name }));
    setRows(mapped);
  }
  useEffect(() => { load(); }, []);

  async function enroll() {
    setError(null);
    const id = form.ident.trim();
    if (!id) return setError("Enter a citizen ID or username.");
    const { data: prof } = await supabase.from("profiles").select("id").or(`citizen_id.eq.${id},username.eq.${id}`).maybeSingle();
    if (!prof) return setError("No citizen found with that ID or username.");
    const { error: e } = await supabase.from("auror_profiles").insert({
      user_id: (prof as { id: string }).id, rank: form.rank.trim() || null,
      specialization: form.specialization.trim() || null, clearance: form.clearance,
    });
    if (e) return setError(e.message);
    setForm({ ident: "", rank: "", specialization: "", clearance: "official" });
    load();
  }

  async function patch(id: string, changes: Partial<Agent>) {
    setRows((r) => r?.map((x) => (x.id === id ? { ...x, ...changes } : x)) ?? null);
    const { error: e } = await supabase.from("auror_profiles").update(changes).eq("id", id);
    if (e) setError(e.message);
  }

  if (rows === null) return <p className="note">Opening the auror register…</p>;

  return (
    <div>
      <div className="admin-subhead">Enroll an agent</div>
      <div className="admin-row">
        <input className="admin-search" placeholder="Citizen ID or username" value={form.ident} onChange={(e) => setForm({ ...form, ident: e.target.value })} />
        <input className="admin-search" placeholder="Rank" value={form.rank} onChange={(e) => setForm({ ...form, rank: e.target.value })} style={{ maxWidth: 130 }} />
        <select value={form.clearance} onChange={(e) => setForm({ ...form, clearance: e.target.value })}>{CLEARANCE.map((c) => <option key={c}>{c}</option>)}</select>
        <button className="btn btn--stamp" onClick={enroll}>Enroll</button>
      </div>
      {error ? <p className="note note--error">{error}</p> : null}

      <div className="admin-subhead" style={{ marginTop: 14 }}>Register</div>
      <table className="ledger">
        <thead><tr><th>No.</th><th>Agent</th><th>Rank</th><th>Clearance</th><th>Active</th></tr></thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td>{a.public_no}</td>
              <td>{a.full_name ?? a.citizen_id}</td>
              <td><input className="admin-inline" value={a.rank ?? ""} onChange={(e) => patch(a.id, { rank: e.target.value })} /></td>
              <td><select value={a.clearance} onChange={(e) => patch(a.id, { clearance: e.target.value })}>{CLEARANCE.map((c) => <option key={c}>{c}</option>)}</select></td>
              <td><button className="linkish" onClick={() => patch(a.id, { is_active: !a.is_active })}>{a.is_active ? "active" : "inactive"}</button></td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td className="note" style={{ border: 0 }}>No agents enrolled.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
