import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

const ROLES = ["manager", "accountant", "employee"];

interface Member { id: string; user_id: string; role: string; citizen_id: string; full_name: string | null; }

export function CompanyMembers({ companyId }: { companyId: string }) {
  const [owner, setOwner] = useState<{ citizen_id: string; full_name: string | null } | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [ident, setIdent] = useState("");
  const [role, setRole] = useState("employee");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data: company } = await supabase.from("companies").select("owner_id").eq("id", companyId).maybeSingle();
    if (company) {
      const { data: op } = await supabase.from("profiles").select("citizen_id,full_name").eq("id", (company as { owner_id: string }).owner_id).maybeSingle();
      setOwner((op as { citizen_id: string; full_name: string | null }) ?? null);
    }
    const { data } = await supabase.from("company_members")
      .select("id,user_id,role,profiles!inner(citizen_id,full_name)").eq("company_id", companyId).eq("is_active", true);
    const rows = ((data as unknown as { id: string; user_id: string; role: string; profiles: { citizen_id: string; full_name: string | null } }[]) ?? [])
      .map((m) => ({ id: m.id, user_id: m.user_id, role: m.role, citizen_id: m.profiles.citizen_id, full_name: m.profiles.full_name }));
    setMembers(rows);
  }
  useEffect(() => { load(); }, [companyId]);

  async function add() {
    setError(null);
    const id = ident.trim();
    if (!id) return;
    const { data: prof } = await supabase.from("profiles").select("id").or(`citizen_id.eq.${id},username.eq.${id}`).maybeSingle();
    if (!prof) return setError("No citizen found with that ID or username.");
    const { error: e } = await supabase.from("company_members").insert({ company_id: companyId, user_id: (prof as { id: string }).id, role });
    if (e) return setError(e.message);
    setIdent(""); load();
  }

  async function remove(id: string) {
    await supabase.from("company_members").delete().eq("id", id);
    load();
  }

  async function changeRole(id: string, r: string) {
    setMembers((m) => m.map((x) => (x.id === id ? { ...x, role: r } : x)));
    await supabase.from("company_members").update({ role: r }).eq("id", id);
  }

  return (
    <div>
      <div className="doc-seal">Personnel Register</div>
      <table className="ledger">
        <tbody>
          {owner ? <tr><td>{owner.citizen_id}</td><td>{owner.full_name ?? "—"}</td><td><strong>owner</strong></td><td></td></tr> : null}
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.citizen_id}</td>
              <td>{m.full_name ?? "—"}</td>
              <td>
                <select value={m.role} onChange={(e) => changeRole(m.id, e.target.value)}>
                  {ROLES.map((r) => <option key={r}>{r}</option>)}
                </select>
              </td>
              <td style={{ textAlign: "right" }}><button className="linkish" onClick={() => remove(m.id)}>remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {error ? <p className="note note--error">{error}</p> : null}
      <div className="field" style={{ marginTop: 12 }}><label>Appoint staff (citizen ID or username)</label>
        <input value={ident} onChange={(e) => setIdent(e.target.value)} />
      </div>
      <div className="btn-row">
        <select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
        <button className="btn" onClick={add}>Appoint</button>
      </div>
      <p className="note">Managers and accountants can file paperwork and record finances; employees cannot.</p>
    </div>
  );
}
