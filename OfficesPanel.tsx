import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

interface OfficeRow { id: string; code: string; name: string; ministry: string | null; }
interface PermissionRow { key: string; category: string; label: string; }
interface MemberRow { id: string; user_id: string; title: string | null; citizen_id: string; full_name: string | null; }

export function OfficesPanel() {
  const [offices, setOffices] = useState<OfficeRow[] | null>(null);
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [newOffice, setNewOffice] = useState({ code: "", name: "", ministry: "" });
  const [memberIdent, setMemberIdent] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function loadOffices() {
    const [{ data: offs }, { data: perms }] = await Promise.all([
      supabase.from("offices").select("id,code,name,ministry").order("name"),
      supabase.from("permissions").select("key,category,label").order("category"),
    ]);
    setOffices((offs as OfficeRow[]) ?? []);
    setPermissions((perms as PermissionRow[]) ?? []);
    if (!selected && offs && offs.length) setSelected((offs as OfficeRow[])[0].id);
  }
  useEffect(() => {
    loadOffices();
  }, []);

  async function loadOfficeDetail(officeId: string) {
    const [{ data: op }, { data: mem }] = await Promise.all([
      supabase.from("office_permissions").select("permission_key").eq("office_id", officeId),
      supabase.from("office_members")
        .select("id,user_id,title,profiles!inner(citizen_id,full_name)")
        .eq("office_id", officeId).eq("is_active", true),
    ]);
    setGranted(new Set(((op as { permission_key: string }[]) ?? []).map((r) => r.permission_key)));
    const rows = ((mem as unknown as { id: string; user_id: string; title: string | null; profiles: { citizen_id: string; full_name: string | null } }[]) ?? [])
      .map((m) => ({ id: m.id, user_id: m.user_id, title: m.title, citizen_id: m.profiles.citizen_id, full_name: m.profiles.full_name }));
    setMembers(rows);
  }
  useEffect(() => {
    if (selected) loadOfficeDetail(selected);
  }, [selected]);

  async function createOffice() {
    setError(null);
    if (!newOffice.code.trim() || !newOffice.name.trim()) return setError("An office needs a code and a name.");
    const { data, error: e } = await supabase.from("offices")
      .insert({ code: newOffice.code.trim(), name: newOffice.name.trim(), ministry: newOffice.ministry.trim() || null })
      .select("id").single();
    if (e) return setError(e.message);
    setNewOffice({ code: "", name: "", ministry: "" });
    await loadOffices();
    setSelected((data as { id: string }).id);
  }

  async function togglePerm(key: string) {
    if (!selected) return;
    setError(null);
    const has = granted.has(key);
    const next = new Set(granted);
    if (has) next.delete(key); else next.add(key);
    setGranted(next);
    if (has) {
      const { error: e } = await supabase.from("office_permissions").delete().eq("office_id", selected).eq("permission_key", key);
      if (e) setError(e.message);
    } else {
      const { error: e } = await supabase.from("office_permissions").insert({ office_id: selected, permission_key: key });
      if (e) setError(e.message);
    }
  }

  async function addMember() {
    if (!selected) return;
    setError(null);
    const ident = memberIdent.trim();
    if (!ident) return;
    const { data: prof } = await supabase.from("profiles")
      .select("id").or(`citizen_id.eq.${ident},username.eq.${ident}`).maybeSingle();
    if (!prof) return setError("No citizen found with that ID or username.");
    const { error: e } = await supabase.from("office_members")
      .insert({ office_id: selected, user_id: (prof as { id: string }).id });
    if (e) return setError(e.message);
    setMemberIdent("");
    loadOfficeDetail(selected);
  }

  async function removeMember(id: string) {
    await supabase.from("office_members").delete().eq("id", id);
    if (selected) loadOfficeDetail(selected);
  }

  if (offices === null) return <p className="note">Unrolling the organizational ledger…</p>;

  const categories = Array.from(new Set(permissions.map((p) => p.category)));

  return (
    <div className="offices-grid">
      <div className="offices-list">
        <div className="admin-subhead">Offices</div>
        {offices.map((o) => (
          <button
            key={o.id}
            className={`office-item${selected === o.id ? " is-selected" : ""}`}
            onClick={() => setSelected(o.id)}
          >
            {o.name}
            {o.ministry ? <span className="office-min">{o.ministry}</span> : null}
          </button>
        ))}
        <div className="admin-subhead" style={{ marginTop: 14 }}>Establish office</div>
        <input className="admin-inline" placeholder="Code" value={newOffice.code} onChange={(e) => setNewOffice({ ...newOffice, code: e.target.value })} />
        <input className="admin-inline" placeholder="Name" value={newOffice.name} onChange={(e) => setNewOffice({ ...newOffice, name: e.target.value })} />
        <input className="admin-inline" placeholder="Ministry (optional)" value={newOffice.ministry} onChange={(e) => setNewOffice({ ...newOffice, ministry: e.target.value })} />
        <button className="btn btn--stamp" style={{ marginTop: 6 }} onClick={createOffice}>Create</button>
      </div>

      <div className="offices-detail">
        {error ? <p className="note note--error">{error}</p> : null}
        <div className="admin-subhead">Powers granted to this office</div>
        {categories.map((cat) => (
          <div key={cat} className="perm-cat">
            <div className="perm-cat__title">{cat}</div>
            {permissions.filter((p) => p.category === cat).map((p) => (
              <label key={p.key} className="perm-item">
                <input type="checkbox" checked={granted.has(p.key)} onChange={() => togglePerm(p.key)} />
                <span>{p.label}</span>
                <code>{p.key}</code>
              </label>
            ))}
          </div>
        ))}

        <div className="admin-subhead" style={{ marginTop: 14 }}>Officers</div>
        <div className="admin-row">
          <input className="admin-search" placeholder="Citizen ID or username" value={memberIdent} onChange={(e) => setMemberIdent(e.target.value)} />
          <button className="btn" onClick={addMember}>Appoint</button>
        </div>
        <table className="ledger">
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>{m.citizen_id}</td>
                <td>{m.full_name ?? "—"}</td>
                <td style={{ textAlign: "right" }}>
                  <button className="linkish" onClick={() => removeMember(m.id)}>dismiss</button>
                </td>
              </tr>
            ))}
            {members.length === 0 ? <tr><td className="note" style={{ border: 0 }}>No officers appointed.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
