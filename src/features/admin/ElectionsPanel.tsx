import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

const TYPES = ["representative", "governor", "mayor", "referendum", "proposition"];
const BALLOTS = ["single_choice", "yes_no"];
const VIS = ["hidden_until_close", "live_totals", "percentage_only", "full_numbers"];
const NEXT: Record<string, string[]> = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["open", "draft", "cancelled"],
  open: ["closed"],
  closed: ["certified", "cancelled"],
  certified: ["archived"],
};

interface Election { id: string; public_no: string | null; title: string; type: string; status: string; results_visibility: string; }
interface Candidate { id: string; name: string; sort_order: number; }

export function ElectionsPanel() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<Election[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [results, setResults] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", description: "", type: "representative", ballot_type: "single_choice", results_visibility: "hidden_until_close" });
  const [candName, setCandName] = useState("");

  async function load() {
    const { data } = await supabase.from("elections").select("id,public_no,title,type,status,results_visibility").order("created_at", { ascending: false });
    setRows((data as Election[]) ?? []);
  }
  useEffect(() => { load(); }, []);

  async function loadDetail(id: string) {
    const { data } = await supabase.from("election_candidates").select("id,name,sort_order").eq("election_id", id).order("sort_order");
    setCands((data as Candidate[]) ?? []);
    const { data: res } = await supabase.rpc("election_results", { p_election: id });
    setResults((res as Record<string, unknown>) ?? null);
  }
  useEffect(() => { if (sel) loadDetail(sel); else { setCands([]); setResults(null); } }, [sel]);

  async function create() {
    setError(null);
    if (!form.title.trim()) return setError("An election needs a title.");
    const { data, error: e } = await supabase.from("elections").insert({
      title: form.title.trim(), description: form.description.trim() || null,
      type: form.type, ballot_type: form.ballot_type, results_visibility: form.results_visibility,
      created_by: profile?.id ?? null,
    }).select("id").single();
    if (e) return setError(e.message);
    setForm({ ...form, title: "", description: "" });
    await load();
    setSel((data as { id: string }).id);
  }

  async function addCandidate() {
    if (!sel || !candName.trim()) return;
    setError(null);
    const { error: e } = await supabase.from("election_candidates").insert({ election_id: sel, name: candName.trim(), sort_order: cands.length + 1 });
    if (e) return setError(e.message);
    setCandName("");
    loadDetail(sel);
  }

  async function transition(to: string) {
    if (!sel) return;
    setError(null);
    const { error: e } = await supabase.rpc("election_transition", { p_election: sel, p_to: to, p_comment: null });
    if (e) return setError(e.message);
    await load();
    loadDetail(sel);
  }

  if (rows === null) return <p className="note">Opening the election office…</p>;
  const current = rows.find((r) => r.id === sel);

  return (
    <div className="offices-grid">
      <div className="offices-list">
        <div className="admin-subhead">Elections</div>
        {rows.map((r) => (
          <button key={r.id} className={`office-item${sel === r.id ? " is-selected" : ""}`} onClick={() => setSel(r.id)}>
            {r.title}<span className="office-min">{r.type} · {r.status}</span>
          </button>
        ))}
        <div className="admin-subhead" style={{ marginTop: 14 }}>New election</div>
        <input className="admin-inline" placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <input className="admin-inline" placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <select className="admin-inline" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
        <select className="admin-inline" value={form.ballot_type} onChange={(e) => setForm({ ...form, ballot_type: e.target.value })}>{BALLOTS.map((t) => <option key={t}>{t}</option>)}</select>
        <select className="admin-inline" value={form.results_visibility} onChange={(e) => setForm({ ...form, results_visibility: e.target.value })}>{VIS.map((t) => <option key={t}>{t}</option>)}</select>
        <button className="btn btn--stamp" style={{ marginTop: 6 }} onClick={create}>Create election</button>
      </div>

      <div className="offices-detail">
        {error ? <p className="note note--error">{error}</p> : null}
        {!current ? <p className="note">Select or create an election.</p> : (
          <>
            <div className="admin-subhead">{current.title} — {current.status}{current.public_no ? ` · ${current.public_no}` : ""}</div>
            <div className="admin-row">
              {(NEXT[current.status] ?? []).map((to) => (
                <button key={to} className={`btn${to === "cancelled" ? " btn--ghost" : " btn--stamp"}`} onClick={() => transition(to)}>{to}</button>
              ))}
            </div>

            <div className="admin-subhead" style={{ marginTop: 12 }}>Candidates</div>
            <div className="admin-row">
              <input className="admin-search" placeholder="Candidate / option name" value={candName} onChange={(e) => setCandName(e.target.value)} />
              <button className="btn" onClick={addCandidate}>Add</button>
            </div>
            <table className="ledger"><tbody>
              {cands.map((c) => <tr key={c.id}><td style={{ width: 30 }}>{c.sort_order}</td><td>{c.name}</td></tr>)}
              {cands.length === 0 ? <tr><td className="note" style={{ border: 0 }}>No candidates yet.</td></tr> : null}
            </tbody></table>

            <div className="admin-subhead" style={{ marginTop: 12 }}>Results</div>
            {results ? <ResultsView results={results} /> : <p className="note">No tally yet.</p>}
          </>
        )}
      </div>
    </div>
  );
}

function ResultsView({ results }: { results: Record<string, unknown> }) {
  if (results.sealed) return <p className="note">Results are sealed until polls close.</p>;
  const rows = (results.results as { name: string; votes?: number; percent: number }[]) ?? [];
  const total = results.total as number | null;
  return (
    <table className="ledger">
      <thead><tr><th>Candidate</th><th>Votes</th><th>Share</th></tr></thead>
      <tbody>
        {rows.map((r, i) => <tr key={i}><td>{r.name}</td><td>{r.votes ?? "—"}</td><td>{r.percent}%</td></tr>)}
        {total != null ? <tr><td><strong>Total ballots</strong></td><td colSpan={2}>{total}</td></tr> : null}
      </tbody>
    </table>
  );
}
