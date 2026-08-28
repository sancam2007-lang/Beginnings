import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { Stamp } from "../../components/paper/Stamp";
import type { Office } from "../../lib/types";

export function ContactRep() {
  const { profile } = useAuth();
  const [offices, setOffices] = useState<Office[]>([]);
  const [officeId, setOfficeId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("offices")
      .select("id,code,name,ministry")
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => {
        const list = (data as Office[]) ?? [];
        setOffices(list);
        if (list[0]) setOfficeId(list[0].id);
      });
  }, []);

  async function send() {
    if (!profile) return;
    if (!officeId || !subject.trim() || !body.trim()) {
      setError("Choose a recipient and write a subject and letter.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data: thread, error: tErr } = await supabase
        .from("correspondence_threads")
        .insert({
          subject,
          sender_id: profile.id,
          to_office_id: officeId,
          region_id: profile.home_region_id,
          category: "ministry",
        })
        .select("id,public_no")
        .single();
      if (tErr) throw tErr;
      const t = thread as { id: string; public_no: string };

      const { error: mErr } = await supabase.from("correspondence_messages").insert({
        thread_id: t.id,
        sender_id: profile.id,
        body,
      });
      if (mErr) throw mErr;
      setSent(t.public_no);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the letter.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div style={{ textAlign: "center" }}>
        <div className="doc-seal">Outgoing Mail</div>
        <Stamp text="Posted" />
        <p style={{ marginTop: 18 }}>Your letter is on its way to the ministry.</p>
        <p className="doc-meta">Reference: {sent}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="doc-seal">Office of Correspondence</div>
      <h2 className="doc-h">Address a letter</h2>

      <div className="field">
        <label htmlFor="rep-office">To the office of</label>
        <select id="rep-office" value={officeId} onChange={(e) => setOfficeId(e.target.value)}>
          {offices.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="rep-subject">Regarding</label>
        <input id="rep-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="rep-body">Your letter</label>
        <textarea id="rep-body" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>

      {error ? <p className="note note--error">{error}</p> : null}

      <div className="btn-row">
        <button className="btn btn--stamp" onClick={send} disabled={busy}>
          {busy ? "Sealing…" : "Seal in envelope & post"}
        </button>
      </div>
    </div>
  );
}
