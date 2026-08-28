import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";

interface AnnouncementRow {
  id: string;
  level: string;
  title: string;
  body: string | null;
  is_pinned: boolean;
  published_at: string;
}

const LEVELS = ["national", "regional", "ministry", "company", "auror", "political", "internal"];

export function AnnouncementsPanel() {
  const [rows, setRows] = useState<AnnouncementRow[] | null>(null);
  const [form, setForm] = useState({ level: "national", title: "", body: "", is_pinned: false });
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase
      .from("announcements")
      .select("id,level,title,body,is_pinned,published_at")
      .order("published_at", { ascending: false });
    setRows((data as AnnouncementRow[]) ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function publish() {
    setError(null);
    if (!form.title.trim()) return setError("A notice needs a title.");
    const { error: e } = await supabase.from("announcements").insert({
      level: form.level,
      title: form.title.trim(),
      body: form.body.trim() || null,
      is_pinned: form.is_pinned,
    });
    if (e) return setError(e.message);
    setForm({ level: "national", title: "", body: "", is_pinned: false });
    load();
  }

  async function remove(id: string) {
    await supabase.from("announcements").delete().eq("id", id);
    setRows((r) => r?.filter((x) => x.id !== id) ?? null);
  }

  if (rows === null) return <p className="note">Reading the bulletin ledger…</p>;

  return (
    <div>
      <div className="admin-subhead">Post a notice</div>
      <div className="admin-row">
        <select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
          {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        <input className="admin-search" placeholder="Headline" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <label className="admin-check"><input type="checkbox" checked={form.is_pinned} onChange={(e) => setForm({ ...form, is_pinned: e.target.checked })} /> pin</label>
      </div>
      <textarea className="admin-textarea" placeholder="Body of the notice…" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
      {error ? <p className="note note--error">{error}</p> : null}
      <div className="admin-row"><button className="btn btn--stamp" onClick={publish}>Post to the board</button></div>

      <div className="admin-subhead" style={{ marginTop: 16 }}>Standing notices</div>
      <table className="ledger">
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td style={{ width: 80 }}>{a.is_pinned ? "★ " : ""}{a.level}</td>
              <td>
                <div>{a.title}</div>
                {a.body ? <div style={{ opacity: 0.7, fontSize: 12 }}>{a.body}</div> : null}
              </td>
              <td style={{ width: 70, textAlign: "right" }}>
                <button className="linkish" onClick={() => remove(a.id)}>rescind</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td className="note" style={{ border: 0 }}>The board is empty.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
