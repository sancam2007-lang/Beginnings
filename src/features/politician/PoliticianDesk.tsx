import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useDesk } from "../../components/desk/DeskManager";
import { DeskDocument } from "../../components/paper/DeskDocument";
import { useReviewObjects } from "../review/useReviewObjects";
import { NotificationsInbox } from "../civilian/NotificationsInbox";
import { Bulletin } from "../civilian/Bulletin";
import { BillRegister, type Perms } from "./BillRegister";
import { DraftBill } from "./DraftBill";
import { VotingFloor } from "./VotingFloor";
import { FormsOffice } from "../forms/FormsOffice";

export function PoliticianDesk() {
  const desk = useDesk();
  const { docs, isMobile } = useDesk();
  const [perms, setPerms] = useState<Perms>({ create: false, vote: false, manage: false });
  const [canDesign, setCanDesign] = useState(false);

  useEffect(() => {
    (async () => {
      const [c, v, m, d] = await Promise.all([
        supabase.rpc("has_permission", { perm: "bills.create" }),
        supabase.rpc("has_permission", { perm: "bills.vote" }),
        supabase.rpc("has_permission", { perm: "bills.manage" }),
        supabase.rpc("has_permission", { perm: "documents.manage_templates" }),
      ]);
      setPerms({ create: !!c.data, vote: !!v.data, manage: !!m.data });
      setCanDesign(!!d.data);
    })();
  }, []);

  const reviewObjs = useReviewObjects();
  const OBJECTS = [
    { id: "register", glyph: "📜", label: "Bill register", title: "Legislative Register", node: <BillRegister perms={perms} />, folder: true },
    { id: "draft", glyph: "✒️", label: "Draft a bill", title: "Draft a Bill", node: <DraftBill perms={perms} /> },
    { id: "floor", glyph: "🗳️", label: "Voting floor", title: "The Voting Floor", node: <VotingFloor perms={perms} />, folder: true },
    { id: "inbox", glyph: "🗂️", label: "Incoming tray", title: "Correspondence Tray", node: <NotificationsInbox /> },
    { id: "notices", glyph: "📌", label: "Bulletin board", title: "Public Notices", node: <Bulletin /> },
    ...(canDesign ? [{ id: "forms", glyph: "🖋️", label: "Forms office", title: "Forms Office", node: <FormsOffice />, folder: true }] : []),
  ];

  const surface = isMobile && docs.length > 0
    ? <div className="mobile-sheet">{docs.map((d) => <DeskDocument key={d.id} doc={d} />)}</div>
    : <>{docs.map((d) => <DeskDocument key={d.id} doc={d} />)}</>;

  return (
    <div className="desk">
      <div className="desk-tray">
        {[...OBJECTS, ...reviewObjs].map((o) => (
          <button key={o.id} className="desk-object" onClick={() => desk.open(o.id, o.title, o.node, o.folder)}>
            <span className="glyph" aria-hidden>{o.glyph}</span>
            <span className="label">{o.label}</span>
          </button>
        ))}
      </div>
      {surface}
    </div>
  );
}
