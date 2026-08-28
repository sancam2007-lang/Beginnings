import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

const TYPES = ["revenue", "expense", "liability", "asset_acquisition", "adjustment"];

interface Txn { id: string; type: string; category: string | null; description: string | null; amount: number; occurred_on: string; }
interface Financials { revenue: number; expenses: number; net_profit: number; asset_value: number; liabilities: number; estimated_tax: number; tax_rate: number; }

export function CompanyLedger({ companyId }: { companyId: string }) {
  const { profile } = useAuth();
  const [fin, setFin] = useState<Financials | null>(null);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ type: "revenue", category: "", description: "", amount: "", occurred_on: new Date().toISOString().slice(0, 10) });

  async function load() {
    const { data: f } = await supabase.rpc("company_financials", { p_company: companyId, p_year: null });
    setFin((f as Financials) ?? null);
    const { data } = await supabase.from("company_transactions")
      .select("id,type,category,description,amount,occurred_on").eq("company_id", companyId)
      .order("occurred_on", { ascending: false }).limit(100);
    setTxns((data as Txn[]) ?? []);
  }
  useEffect(() => { load(); }, [companyId]);

  async function add() {
    setError(null);
    const amt = Number(form.amount);
    if (!form.amount || Number.isNaN(amt)) return setError("Enter a valid amount.");
    const { error: e } = await supabase.from("company_transactions").insert({
      company_id: companyId, type: form.type, category: form.category.trim() || null,
      description: form.description.trim() || null, amount: amt, occurred_on: form.occurred_on,
      recorded_by: profile?.id ?? null,
    });
    if (e) return setError(e.message);
    setForm({ ...form, category: "", description: "", amount: "" });
    load();
  }

  return (
    <div>
      <div className="doc-seal">Company Ledger</div>
      {fin ? (
        <table className="ledger" style={{ marginBottom: 12 }}>
          <tbody>
            <tr><th>Revenue</th><td>{fin.revenue}</td><th>Expenses</th><td>{fin.expenses}</td></tr>
            <tr><th>Net profit</th><td>{fin.net_profit}</td><th>Liabilities</th><td>{fin.liabilities}</td></tr>
            <tr><th>Asset value</th><td>{fin.asset_value}</td><th>Est. tax ({Math.round(fin.tax_rate * 100)}%)</th><td>{fin.estimated_tax}</td></tr>
          </tbody>
        </table>
      ) : null}

      <div className="admin-subhead">Record an entry</div>
      <div className="btn-row" style={{ marginBottom: 8 }}>
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
        <input placeholder="Amount" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value.replace(/[^\d.]/g, "") })} style={{ maxWidth: 100 }} />
        <input type="date" value={form.occurred_on} onChange={(e) => setForm({ ...form, occurred_on: e.target.value })} />
      </div>
      <div className="field"><input placeholder="Category (optional)" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></div>
      <div className="field"><input placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
      {error ? <p className="note note--error">{error}</p> : null}
      <div className="btn-row"><button className="btn btn--stamp" onClick={add}>Post to ledger</button></div>

      <div className="admin-subhead" style={{ marginTop: 14 }}>Recent entries</div>
      <table className="ledger">
        <tbody>
          {txns.map((t) => (
            <tr key={t.id}>
              <td>{t.occurred_on}</td>
              <td>{t.type}{t.category ? ` · ${t.category}` : ""}</td>
              <td>{t.description ?? ""}</td>
              <td style={{ textAlign: "right" }}>{t.amount}</td>
            </tr>
          ))}
          {txns.length === 0 ? <tr><td className="note" style={{ border: 0 }}>No entries recorded.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
