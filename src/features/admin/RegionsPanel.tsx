import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

interface RegionRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
}

export function RegionsPanel() {
  const [rows, setRows] = useState<RegionRow[] | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase
      .from("regions")
      .select("id,code,name,description,is_active")
      .order("code");
    setRows((data as RegionRow[]) ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function create() {
    setError(null);
    if (!code.trim() || !name.trim()) {
      setError("A region needs a code and a name.");
      return;
    }
    const { error: e } = await supabase.from("regions").insert({ code: code.trim(), name: name.trim() });
    if (e) return setError(e.message);
    setCode(""); setName(""); load();
  }

  async function patch(id: string, changes: Partial<RegionRow>) {
    setRows((r) => r?.map((x) => (x.id === id ? { ...x, ...changes } : x)) ?? null);
    const { error: e } = await supabase.from("regions").update(changes).eq("id", id);
    if (e) setError(e.message);
  }

  if (rows === null) return <p className="note">Opening the regional atlas…</p>;

  return (
    <div>
      <div className="admin-row">
        <input className="admin-search" placeholder="Code (e.g. R7)" value={code} onChange={(e) => setCode(e.target.value)} style={{ maxWidth: 120 }} />
        <input className="admin-search" placeholder="Region name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn--stamp" onClick={create}>Charter region</button>
      </div>
      {error ? <p className="note note--error">{error}</p> : null}
      <table className="ledger">
        <thead><tr><th>Code</th><th>Name</th><th>Description</th><th>Status</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.code}</td>
              <td><input value={r.name} onChange={(e) => patch(r.id, { name: e.target.value })} className="admin-inline" /></td>
              <td><input value={r.description ?? ""} placeholder="—" onChange={(e) => patch(r.id, { description: e.target.value })} className="admin-inline" /></td>
              <td>
                <button className="linkish" onClick={() => patch(r.id, { is_active: !r.is_active })}>
                  {r.is_active ? "active" : "inactive"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
