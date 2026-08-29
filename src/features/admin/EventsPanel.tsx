import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { AccountType } from "../../lib/types";

const SEVERITY = ["minor", "moderate", "severe", "critical"];
const STATUS = ["draft", "active", "concluded", "cancelled"];
const ACCOUNTS: AccountType[] = ["civilian", "politician", "company", "auror", "admin"];

interface EventRow {
  id: string; public_no: string; title: string; category: string | null;
  severity: string; status: string; is_public: boolean;
}

export function EventsPanel() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<EventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: "", category: "", description: "", severity: "moderate", is_public: true,
    affected: new Set<AccountType>(), starts: "", ends: "",
  });

  async function load() {
    const { data } = await supabase.from("events")
      .select("id,public_no,title,category,severity,status,is_public")
      .order("created_at", { ascending: false });
    setRows((data as EventRow[]) ?? []);
  }
  useEffect(() => { load(); }, []);

  async function create() {
    setError(null);
    if (!form.title.trim()) return setError("An event needs a title.");
    const { error: e } = await supabase.from("events").insert({
      title: form.title.trim(), category: form.category.trim() || null,
      description: form.description.trim() || null, severity: form.severity,
      is_public: form.is_public,
      affected_account_types: form.affected.size ? Array.from(form.affected) : null,
      starts_at: form.starts ? new Date(form.starts).toISOString() : null,
      ends_at: form.ends ? new Date(form.ends).toISOString() : null,
      created_by: profile?.id ?? null,
    });
    if (e) return setError(e.message);
    setForm({ ...form, title: "", category: "", description: "", starts: "", ends: "", affected: new Set() });
    load();
  }

  async function setStatus(id: string, status: string) {
    setRows((r) => r?.map((x) => (x.id === id ? { ...x, status } : x)) ?? null);
    const { error: e } = await supabase.from("events").update({ status }).eq("id", id);
    if (e) setError(e.message);
  }

  function toggleAccount(a: AccountType) {
    const next = new Set(form.affected);
    next.has(a) ? next.delete(a) : next.add(a);
    setForm({ ...form, affected: next });
  }

  if (rows === null) return <p className="note">Reviewing the event board…</p>;

  return (
    <div>
      <div className="admin-subhead">Declare an event</div>
      <div className="admin-row">
        <input className="admin-search" placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <input className="admin-search" placeholder="Category (war, disaster…)" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} style={{ maxWidth: 200 }} />
        <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>{SEVERITY.map((s) => <option key={s}>{s}</option>)}</select>
        <label className="admin-check"><input type="checkbox" checked={form.is_public} onChange={(e) => setForm({ ...form, is_public: e.target.checked })} /> public</label>
      </div>
      <textarea className="admin-textarea" placeholder="Description…" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      <div className="admin-row" style={{ marginTop: 8 }}>
        <label className="admin-check">Begins <input type="datetime-local" value={form.starts} onChange={(e) => setForm({ ...form, starts: e.target.value })} /></label>
        <label className="admin-check">Ends <input type="datetime-local" value={form.ends} onChange={(e) => setForm({ ...form, ends: e.target.value })} /></label>
      </div>
      <div className="admin-subhead" style={{ marginTop: 8 }}>Affected account types (none = everyone)</div>
      <div className="chip-set">
        {ACCOUNTS.map((a) => <label key={a} className="admin-check"><input type="checkbox" checked={form.affected.has(a)} onChange={() => toggleAccount(a)} /> {a}</label>)}
      </div>
      {error ? <p className="note note--error">{error}</p> : null}
      <div className="admin-row"><button className="btn btn--stamp" onClick={create}>Declare event</button></div>

      <div className="admin-subhead" style={{ marginTop: 16 }}>Event board</div>
      <table className="ledger">
        <thead><tr><th>No.</th><th>Title</th><th>Severity</th><th>Public</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((ev) => (
            <tr key={ev.id}>
              <td>{ev.public_no}</td>
              <td>{ev.title}{ev.category ? <span style={{ opacity: 0.6 }}> · {ev.category}</span> : null}</td>
              <td>{ev.severity}</td>
              <td>{ev.is_public ? "✓" : "—"}</td>
              <td>
                <select value={ev.status} onChange={(e) => setStatus(ev.id, e.target.value)}>{STATUS.map((s) => <option key={s}>{s}</option>)}</select>
              </td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td className="note" style={{ border: 0 }}>No events declared.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
