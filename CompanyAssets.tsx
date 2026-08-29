import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

const STATUSES = ["active", "sold", "depreciated", "written_off", "transferred"];

interface Cat { code: string; label: string; }
interface Asset {
  id: string; category_code: string | null; name: string; current_value: number;
  acquisition_value: number; status: string; location: string | null;
}

export function CompanyAssets({ companyId }: { companyId: string }) {
  const [cats, setCats] = useState<Cat[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ category_code: "", name: "", acquisition_value: "", current_value: "", location: "" });

  async function load() {
    const { data: c } = await supabase.from("asset_categories").select("code,label").eq("is_enabled", true).order("label");
    setCats((c as Cat[]) ?? []);
    const { data } = await supabase.from("company_assets")
      .select("id,category_code,name,current_value,acquisition_value,status,location").eq("company_id", companyId).order("created_at", { ascending: false });
    setAssets((data as Asset[]) ?? []);
  }
  useEffect(() => { load(); }, [companyId]);

  async function add() {
    setError(null);
    if (!form.name.trim()) return setError("An asset needs a name.");
    const { error: e } = await supabase.from("company_assets").insert({
      company_id: companyId, category_code: form.category_code || null, name: form.name.trim(),
      acquisition_value: Number(form.acquisition_value) || 0, current_value: Number(form.current_value) || 0,
      location: form.location.trim() || null,
    });
    if (e) return setError(e.message);
    setForm({ category_code: "", name: "", acquisition_value: "", current_value: "", location: "" });
    load();
  }

  async function setStatus(id: string, status: string) {
    setAssets((a) => a.map((x) => (x.id === id ? { ...x, status } : x)));
    await supabase.from("company_assets").update({ status }).eq("id", id);
  }

  return (
    <div>
      <div className="doc-seal">Asset Register</div>
      <table className="ledger">
        <thead><tr><th>Asset</th><th>Category</th><th>Value</th><th>Status</th></tr></thead>
        <tbody>
          {assets.map((a) => (
            <tr key={a.id}>
              <td>{a.name}{a.location ? <span style={{ opacity: 0.6 }}> · {a.location}</span> : null}</td>
              <td>{a.category_code ?? "—"}</td>
              <td>{a.current_value}</td>
              <td><select value={a.status} onChange={(e) => setStatus(a.id, e.target.value)}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select></td>
            </tr>
          ))}
          {assets.length === 0 ? <tr><td className="note" style={{ border: 0 }}>No assets registered.</td></tr> : null}
        </tbody>
      </table>

      <div className="admin-subhead" style={{ marginTop: 12 }}>Register an asset</div>
      <div className="field"><input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
      <div className="btn-row" style={{ marginBottom: 8 }}>
        <select value={form.category_code} onChange={(e) => setForm({ ...form, category_code: e.target.value })}>
          <option value="">Category…</option>
          {cats.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
        </select>
        <input placeholder="Acq. value" value={form.acquisition_value} onChange={(e) => setForm({ ...form, acquisition_value: e.target.value.replace(/[^\d.]/g, "") })} style={{ maxWidth: 90 }} />
        <input placeholder="Cur. value" value={form.current_value} onChange={(e) => setForm({ ...form, current_value: e.target.value.replace(/[^\d.]/g, "") })} style={{ maxWidth: 90 }} />
      </div>
      <div className="field"><input placeholder="Location (optional)" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></div>
      {error ? <p className="note note--error">{error}</p> : null}
      <div className="btn-row"><button className="btn btn--stamp" onClick={add}>Register asset</button></div>
    </div>
  );
}
