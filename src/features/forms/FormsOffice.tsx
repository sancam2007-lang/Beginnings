import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { TemplateDesigner } from "./TemplateDesigner";
import { bgByKey } from "./backgrounds";

interface Row { id: string; code: string; name: string; kind: string; is_active: boolean; background_key: string | null; }

export function FormsOffice() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [editing, setEditing] = useState<string | null | undefined>(undefined); // undefined=list, null=new, string=edit id
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase.from("document_templates")
      .select("id,code,name,kind,is_active,background_key").order("name");
    setRows((data as Row[]) ?? []);
  }
  useEffect(() => { load(); }, []);

  async function retire(r: Row) {
    setRows((p) => p?.map((x) => (x.id === r.id ? { ...x, is_active: !x.is_active } : x)) ?? null);
    await supabase.from("document_templates").update({ is_active: !r.is_active }).eq("id", r.id);
  }
  async function del(r: Row) {
    setError(null);
    const { error: e } = await supabase.from("document_templates").delete().eq("id", r.id);
    if (e) return setError(`"${r.name}" can't be deleted — it has submissions on file. Retire it instead.`);
    load();
  }

  if (editing !== undefined) {
    return <TemplateDesigner templateId={editing} onClose={() => { setEditing(undefined); load(); }} />;
  }
  if (rows === null) return <p className="note">Opening the forms office…</p>;

  return (
    <div>
      <div className="doc-seal">Forms Office</div>
      <div className="btn-row"><button className="btn btn--stamp" onClick={() => setEditing(null)}>+ Design a new form</button></div>
      {error ? <p className="note note--error">{error}</p> : null}
      <table className="ledger">
        <thead><tr><th>Form</th><th>Background</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}<div style={{ opacity: 0.6, fontSize: 12 }}>{r.code} · {r.kind}</div></td>
              <td>{bgByKey(r.background_key)?.label ?? "—"}</td>
              <td>{r.is_active ? "active" : "retired"}</td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                <button className="linkish" onClick={() => setEditing(r.id)}>edit</button>{" · "}
                <button className="linkish" onClick={() => retire(r)}>{r.is_active ? "retire" : "restore"}</button>{" · "}
                <button className="linkish" onClick={() => del(r)}>delete</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td className="note" style={{ border: 0 }}>No forms yet.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
