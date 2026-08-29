import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Region } from "../../lib/types";

interface Company {
  id: string; public_no: string; name: string; industry: string | null;
  description: string | null; status: string; region_id: string | null;
}

export function CompanyOffice({ companyId }: { companyId: string }) {
  const [c, setC] = useState<Company | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    supabase.from("companies").select("id,public_no,name,industry,description,status,region_id").eq("id", companyId).maybeSingle()
      .then(({ data }) => setC((data as Company) ?? null));
    supabase.from("regions").select("id,code,name").order("name").then(({ data }) => setRegions((data as Region[]) ?? []));
  }, [companyId]);

  async function save() {
    if (!c) return;
    setError(null); setSaved(false);
    const { error: e } = await supabase.from("companies")
      .update({ name: c.name, industry: c.industry, description: c.description, region_id: c.region_id })
      .eq("id", c.id);
    if (e) return setError(e.message);
    setSaved(true);
  }

  if (!c) return <p className="note">Opening the company office…</p>;
  return (
    <div>
      <div className="doc-seal">Registered Business · Crown Federation</div>
      <h2 className="doc-h">{c.name}</h2>
      <div className="doc-meta">{c.public_no} · standing: {c.status}</div>

      <div className="field">
        <label>Registered name</label>
        <input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
      </div>
      <div className="field">
        <label>Industry</label>
        <input value={c.industry ?? ""} onChange={(e) => setC({ ...c, industry: e.target.value })} />
      </div>
      <div className="field">
        <label>Registered region</label>
        <select value={c.region_id ?? ""} onChange={(e) => setC({ ...c, region_id: e.target.value || null })}>
          <option value="">—</option>
          {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Description</label>
        <textarea value={c.description ?? ""} onChange={(e) => setC({ ...c, description: e.target.value })} />
      </div>
      {error ? <p className="note note--error">{error}</p> : null}
      {saved ? <p className="note">Changes filed with the registry.</p> : null}
      <div className="btn-row"><button className="btn btn--stamp" onClick={save}>Save changes</button></div>
      <p className="note">Company standing (active/suspended) is set by the government, not here.</p>
    </div>
  );
}
