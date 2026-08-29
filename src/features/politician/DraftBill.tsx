import { useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { Perms } from "./BillRegister";

export function DraftBill({ perms }: { perms: Perms }) {
  const { profile } = useAuth();
  const [form, setForm] = useState({ title: "", summary: "", committee: "", body: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!perms.create) {
    return (
      <div>
        <div className="doc-seal">Drafting Office</div>
        <p className="note">You must hold a seat in Parliament to draft legislation. Ask an administrator to appoint you to a legislative office.</p>
      </div>
    );
  }

  async function create() {
    if (!profile) return;
    setError(null);
    if (!form.title.trim()) return setError("A bill needs a title.");
    const { error: e } = await supabase.from("bills").insert({
      title: form.title.trim(), summary: form.summary.trim() || null,
      committee: form.committee.trim() || null, body: form.body.trim() || null,
      author_id: profile.id, status: "draft",
    });
    if (e) return setError(e.message);
    setForm({ title: "", summary: "", committee: "", body: "" });
    setDone(true);
  }

  if (done) return (
    <div>
      <div className="doc-seal">Drafting Office</div>
      <p className="note">Your draft is filed. Open it in the Bill Register to introduce it to the floor.</p>
      <div className="btn-row"><button className="btn btn--ghost" onClick={() => setDone(false)}>Draft another</button></div>
    </div>
  );

  return (
    <div>
      <div className="doc-seal">Draft a Bill</div>
      <div className="field"><label>Title</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
      <div className="field"><label>Summary</label><input value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} /></div>
      <div className="field"><label>Committee</label><input value={form.committee} onChange={(e) => setForm({ ...form, committee: e.target.value })} /></div>
      <div className="field"><label>Text of the bill</label><textarea style={{ minHeight: 140 }} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} /></div>
      {error ? <p className="note note--error">{error}</p> : null}
      <div className="btn-row"><button className="btn btn--stamp" onClick={create}>File draft</button></div>
    </div>
  );
}
