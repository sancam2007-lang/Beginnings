import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";

export interface Perms { create: boolean; vote: boolean; manage: boolean; }

const NEXT: Record<string, string[]> = {
  introduced: ["committee_review", "debate", "withdrawn"],
  committee_review: ["debate", "rejected", "withdrawn"],
  debate: ["voting", "committee_review", "withdrawn"],
  voting: ["passed", "rejected"],
  passed: ["executive_review", "enacted", "archived"],
  executive_review: ["enacted", "vetoed"],
  rejected: ["archived", "draft"],
  vetoed: ["archived", "debate"],
  enacted: ["archived"],
  withdrawn: ["archived"],
};
const WITHDRAWABLE = ["draft", "introduced", "committee_review", "debate"];

interface Bill { id: string; public_no: string | null; title: string; status: string; author_id: string; }

export function BillRegister({ perms }: { perms: Perms }) {
  const [rows, setRows] = useState<Bill[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase.from("bills").select("id,public_no,title,status,author_id").order("created_at", { ascending: false });
    setRows((data as Bill[]) ?? []);
  }
  useEffect(() => { load(); }, []);

  if (sel) return <BillDetail billId={sel} perms={perms} onBack={() => { setSel(null); load(); }} />;
  if (rows === null) return <p className="note">Opening the legislative register…</p>;

  return (
    <div>
      <div className="doc-seal">Legislative Register</div>
      {rows.length === 0 ? <p className="note">No bills on record.</p> : (
        <table className="ledger"><tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td>{b.title}<div style={{ opacity: 0.6, fontSize: 12 }}>{b.public_no ?? "draft"}</div></td>
              <td>{b.status}</td>
              <td style={{ textAlign: "right" }}><button className="linkish" onClick={() => setSel(b.id)}>open</button></td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}

function BillDetail({ billId, perms, onBack }: { billId: string; perms: Perms; onBack: () => void }) {
  const { profile } = useAuth();
  const [bill, setBill] = useState<{ id: string; public_no: string | null; title: string; summary: string | null; body: string | null; status: string; author_id: string; committee: string | null } | null>(null);
  const [amendments, setAmendments] = useState<{ id: string; seq: number; text: string; status: string }[]>([]);
  const [tally, setTally] = useState<{ yea: number; nay: number; abstain: number; total: number } | null>(null);
  const [myVote, setMyVote] = useState<string | null>(null);
  const [amendText, setAmendText] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data: b } = await supabase.from("bills").select("id,public_no,title,summary,body,status,author_id,committee").eq("id", billId).maybeSingle();
    setBill(b as typeof bill);
    const { data: am } = await supabase.from("bill_amendments").select("id,seq,text,status").eq("bill_id", billId).order("seq");
    setAmendments((am as { id: string; seq: number; text: string; status: string }[]) ?? []);
    const { data: t } = await supabase.rpc("bill_tally", { p_bill: billId });
    setTally((t as { yea: number; nay: number; abstain: number; total: number }) ?? null);
    if (profile) {
      const { data: v } = await supabase.from("bill_votes").select("choice").eq("bill_id", billId).eq("voter_id", profile.id).maybeSingle();
      setMyVote((v as { choice: string } | null)?.choice ?? null);
    }
  }
  useEffect(() => { load(); }, [billId]);

  async function transition(to: string) {
    setError(null);
    const { error: e } = await supabase.rpc("bill_transition", { p_bill: billId, p_to: to, p_comment: null });
    if (e) return setError(e.message);
    load();
  }
  async function cosponsor() {
    setError(null);
    const { error: e } = await supabase.from("bill_sponsors").insert({ bill_id: billId, user_id: profile?.id, role: "cosponsor" });
    if (e) return setError(e.message);
    load();
  }
  async function propose() {
    if (!amendText.trim()) return;
    setError(null);
    const { error: e } = await supabase.from("bill_amendments").insert({ bill_id: billId, proposed_by: profile?.id, text: amendText.trim(), seq: amendments.length + 1 });
    if (e) return setError(e.message);
    setAmendText(""); load();
  }
  async function vote(choice: string) {
    setError(null);
    const { error: e } = await supabase.rpc("cast_bill_vote", { p_bill: billId, p_choice: choice });
    if (e) return setError(e.message);
    load();
  }

  if (!bill) return <p className="note">Retrieving the bill…</p>;
  const isAuthor = bill.author_id === profile?.id;
  const manageStates = perms.manage ? (NEXT[bill.status] ?? []) : [];

  return (
    <div>
      <button className="linkish" onClick={onBack}>‹ back to register</button>
      <div className="doc-seal" style={{ marginTop: 8 }}>Bill of the Federation</div>
      <h2 className="doc-h">{bill.title}</h2>
      <div className="doc-meta">{bill.public_no ?? "draft"} · {bill.status}{bill.committee ? ` · ${bill.committee}` : ""}</div>
      {bill.summary ? <p style={{ fontStyle: "italic" }}>{bill.summary}</p> : null}
      {bill.body ? <p style={{ whiteSpace: "pre-wrap" }}>{bill.body}</p> : null}

      {error ? <p className="note note--error">{error}</p> : null}

      {/* Voting */}
      {bill.status === "voting" && perms.vote ? (
        <>
          <div className="admin-subhead" style={{ marginTop: 10 }}>Cast your vote {myVote ? `(currently: ${myVote})` : ""}</div>
          <div className="btn-row">
            <button className="btn btn--stamp" onClick={() => vote("yea")}>Yea</button>
            <button className="btn btn--ghost" onClick={() => vote("nay")}>Nay</button>
            <button className="btn btn--ghost" onClick={() => vote("abstain")}>Abstain</button>
          </div>
        </>
      ) : null}
      {tally ? <p className="doc-meta">Roll call — Yea {tally.yea} · Nay {tally.nay} · Abstain {tally.abstain} · {tally.total} cast</p> : null}

      {/* Author + manager actions */}
      <div className="btn-row">
        {isAuthor && perms.create && bill.status === "draft" ? <button className="btn btn--stamp" onClick={() => transition("introduced")}>Introduce</button> : null}
        {isAuthor && perms.create && WITHDRAWABLE.includes(bill.status) ? <button className="btn btn--ghost" onClick={() => transition("withdrawn")}>Withdraw</button> : null}
        {perms.create && !isAuthor && bill.status !== "draft" ? <button className="btn" onClick={cosponsor}>Co-sponsor</button> : null}
        {manageStates.map((s) => <button key={s} className="btn btn--ghost" onClick={() => transition(s)}>{s}</button>)}
      </div>

      {/* Amendments */}
      <div className="admin-subhead" style={{ marginTop: 12 }}>Amendments</div>
      {amendments.map((a) => <div key={a.id} style={{ marginBottom: 6 }}><strong>#{a.seq}</strong> ({a.status}) — {a.text}</div>)}
      {amendments.length === 0 ? <p className="note">No amendments proposed.</p> : null}
      {perms.create ? (
        <>
          <textarea className="admin-textarea" placeholder="Propose an amendment…" value={amendText} onChange={(e) => setAmendText(e.target.value)} />
          <div className="btn-row"><button className="btn" onClick={propose}>Propose amendment</button></div>
        </>
      ) : null}
    </div>
  );
}
