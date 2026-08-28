import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Profile, Region, AccountType } from "../../lib/types";

const ACCOUNT_TYPES: AccountType[] = ["civilian", "politician", "company", "auror", "admin"];
const STATUSES = ["active", "suspended", "pending", "closed"];

export function UsersPanel() {
  const [rows, setRows] = useState<Profile[] | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [{ data: profs }, { data: regs }] = await Promise.all([
      supabase.from("profiles").select("*").order("registered_at", { ascending: true }),
      supabase.from("regions").select("id,code,name").order("name"),
    ]);
    setRows((profs as Profile[]) ?? []);
    setRegions((regs as Region[]) ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function patch(id: string, changes: Partial<Profile>) {
    setError(null);
    const prev = rows;
    setRows((r) => r?.map((u) => (u.id === id ? { ...u, ...changes } : u)) ?? null);
    const { error: e } = await supabase.from("profiles").update(changes).eq("id", id);
    if (e) {
      setError(e.message);
      setRows(prev ?? null);
    }
  }

  const filtered = useMemo(() => {
    if (!rows) return [];
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((u) =>
      [u.full_name, u.username, u.citizen_id].some((v) => v?.toLowerCase().includes(t)),
    );
  }, [rows, q]);

  if (rows === null) return <p className="note">Pulling the citizen registry…</p>;

  return (
    <div>
      <div className="admin-toolbar">
        <input
          className="admin-search"
          placeholder="Search name, username, or citizen ID…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="admin-count">{filtered.length} on file</span>
      </div>
      {error ? <p className="note note--error">{error}</p> : null}
      <table className="ledger">
        <thead>
          <tr>
            <th>Citizen ID</th><th>Name</th><th>Classification</th><th>Standing</th><th>Region</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((u) => (
            <tr key={u.id}>
              <td>{u.citizen_id}</td>
              <td>{u.full_name ?? u.username ?? "—"}</td>
              <td>
                <select value={u.account_type} onChange={(e) => patch(u.id, { account_type: e.target.value as AccountType })}>
                  {ACCOUNT_TYPES.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </td>
              <td>
                <select value={u.status} onChange={(e) => patch(u.id, { status: e.target.value })}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </td>
              <td>
                <select
                  value={u.home_region_id ?? ""}
                  onChange={(e) => patch(u.id, { home_region_id: e.target.value || null })}
                >
                  <option value="">—</option>
                  {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
