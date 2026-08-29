import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../features/auth/AuthProvider";
import { DeskProvider, useDesk } from "./DeskManager";
import { DeskDocument } from "../paper/DeskDocument";
import { IdBooklet } from "../../features/civilian/IdBooklet";
import { Bulletin } from "../../features/civilian/Bulletin";
import { NotificationsInbox } from "../../features/civilian/NotificationsInbox";
import { DocumentRequest } from "../../features/civilian/DocumentRequest";
import { ContactRep } from "../../features/civilian/ContactRep";
import { AdminBureau } from "../../features/admin/AdminBureau";
import { useReviewObjects } from "../../features/review/useReviewObjects";
import { CompanyDesk } from "../../features/company/CompanyDesk";
import { AurorDesk } from "../../features/auror/AurorDesk";
import { PoliticianDesk } from "../../features/politician/PoliticianDesk";

interface DeskObjectDef {
  id: string; glyph: string; label: string; title: string; node: JSX.Element; folder?: boolean;
}
const OBJECTS: DeskObjectDef[] = [
  { id: "id", glyph: "🪪", label: "ID booklet", title: "Citizen Identification", node: <IdBooklet /> },
  { id: "inbox", glyph: "🗂️", label: "Incoming tray", title: "Correspondence Tray", node: <NotificationsInbox /> },
  { id: "board", glyph: "📌", label: "Bulletin board", title: "Public Notices", node: <Bulletin /> },
  { id: "forms", glyph: "📄", label: "Request papers", title: "Government Forms", node: <DocumentRequest />, folder: true },
  { id: "post", glyph: "✉️", label: "Write a letter", title: "Office of Correspondence", node: <ContactRep /> },
];

function Tray({ unread }: { unread: number }) {
  const desk = useDesk();
  const reviewObjs = useReviewObjects();
  const objects = [...OBJECTS, ...reviewObjs];
  return (
    <div className="desk-tray">
      {objects.map((o) => (
        <button key={o.id} className="desk-object" onClick={() => desk.open(o.id, o.title, o.node, o.folder)}>
          <span className="glyph" aria-hidden>{o.glyph}</span>
          <span className="label">{o.label}</span>
          {o.id === "inbox" && unread > 0 ? <span className="count">{unread}</span> : null}
        </button>
      ))}
    </div>
  );
}

function Surface() {
  const { docs, isMobile } = useDesk();
  if (isMobile && docs.length > 0) {
    return <div className="mobile-sheet">{docs.map((d) => <DeskDocument key={d.id} doc={d} />)}</div>;
  }
  return <>{docs.map((d) => <DeskDocument key={d.id} doc={d} />)}</>;
}

function Counter({ unread }: { unread: number }) {
  return (
    <div className="desk">
      <Tray unread={unread} />
      <Surface />
    </div>
  );
}

function Shell() {
  const { profile, signOut } = useAuth();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    async function count() {
      const { count: c } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("is_read", false);
      setUnread(c ?? 0);
    }
    count();
    const channel = supabase
      .channel("tray-notifications")
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, () => count())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const kind = profile?.account_type;
  const subtitle =
    kind === "admin" ? "Administrative Bureau"
    : kind === "company" ? "Chamber of Commerce"
    : kind === "auror" ? "Auror Service"
    : kind === "politician" ? "Parliament"
    : `National Bureau · ${kind} desk`;
  return (
    <div className="office-root">
      <div className="bureau-bar">
        <div>
          <h1>Beginnings</h1>
          <div className="sub">{subtitle}</div>
        </div>
        <div className="spacer" />
        <button className="chip-btn" onClick={signOut}>Leave the office</button>
      </div>
      {kind === "admin" ? <AdminBureau />
        : kind === "company" ? <CompanyDesk />
        : kind === "auror" ? <AurorDesk />
        : kind === "politician" ? <PoliticianDesk />
        : <Counter unread={unread} />}
    </div>
  );
}

export function Desk() {
  return (
    <DeskProvider>
      <Shell />
    </DeskProvider>
  );
}
