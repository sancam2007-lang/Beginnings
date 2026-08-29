import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { Perms } from "./BillRegister";

interface Bill { id: string; public_no: string | null; title: string; summary: string | null; }

export function VotingFloor({ perms }: { perms: Perms }) {
  const { profile } = useAuth();
  const [rows, setRows] = useState<Bill[] | null>(null);
  const [tallies, setTallies] = useState<Record<string, { yea: number; nay: number; abstain: number; total: number }>>({});
  const [myVotes, setMyVotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase.from("bills").select("id,public_no,title,summary").eq("status", "voting").order("voting_deadline", { ascending: true, nullsFirst: false });
    const bills = (data as Bill[]) ?? [];
    setRows(bills);
    const tMap: Record<string, { yea: number; nay: number; abstain: number; total: number }> = {};
    const vMap: Record<string, string> = {};
    for (const b of bills) {
      const { data: t } = await supabase.rpc("bill_tally", { p_bill: b.id });
      if (t) tMap[b.id] = t as { yea: number; nay: number; abstain: number; total: number };
      if (profile) {
        const { data: v } = await supabase.from("bill_votes").select("choice").eq("bill_id", b.id).eq("voter_id", profile.id).maybeSingle();
        if (v) vMap[b.id] = (v as { choice: string }).choice;
      }
    }
    setTallies(tMap); setMyVotes(vMap);
  }
  useEffect(() => { load(); }, [profile]);

  async function vote(billId: string, choice: string) {
    setError(null);
    const { error: e } = await supabase.rpc("cast_bill_vote", { p_bill: billId, p_choice: choice });
    if (e) return setError(e.message);
    load();
  }

  if (rows === null) return <p className="note">Calling the chamber to order…</p>;

  return (
    <div>
      <div className="doc-seal">The Voting Floor</div>
      {error ? <p className="note note--error">{error}</p> : null}
      {rows.length === 0 ? <p className="note">No bills are open for a vote.</p> : null}
      {rows.map((b) => {
        const t = tallies[b.id];
        const mine = myVotes[b.id];
        return (
          <div key={b.id} className="mission-card">
            <strong>{b.title}</strong>
            <div className="doc-meta">{b.public_no ?? "—"}</div>
            {b.summary ? <p style={{ margin: "4px 0" }}>{b.summary}</p> : null}
            {t ? <p className="doc-meta">Yea {t.yea} · Nay {t.nay} · Abstain {t.abstain} · {t.total} cast</p> : null}
            {perms.vote ? (
              <div className="btn-row">
                <button className="btn btn--stamp" onClick={() => vote(b.id, "yea")}>Yea</button>
                <button className="btn btn--ghost" onClick={() => vote(b.id, "nay")}>Nay</button>
                <button className="btn btn--ghost" onClick={() => vote(b.id, "abstain")}>Abstain</button>
                {mine ? <span className="note" style={{ margin: 0 }}>You voted {mine}.</span> : null}
              </div>
            ) : <p className="note" style={{ margin: 0 }}>You do not hold a vote in this chamber.</p>}
          </div>
        );
      })}
    </div>
  );
}
