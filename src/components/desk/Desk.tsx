import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../features/auth/AuthProvider";
import { DeskProvider, useDesk } from "./DeskManager";
import { DeskDocument } from "../paper/DeskDocument";
import { OfficeScene } from "../scene/OfficeScene";
import { CIVILIAN_CLERK, type ServiceId } from "../../features/clerk/dialogue";
import { playPager, playPrinter, setMuted, isMuted } from "../../lib/sound";
import { IdBooklet } from "../../features/civilian/IdBooklet";
import { Bulletin } from "../../features/civilian/Bulletin";
import { NotificationsInbox } from "../../features/civilian/NotificationsInbox";
import { DocumentRequest } from "../../features/civilian/DocumentRequest";
import { ContactRep } from "../../features/civilian/ContactRep";

const SERVICES: Record<ServiceId, { title: string; render: () => JSX.Element; folder?: boolean }> = {
  id: { title: "Citizen Identification", render: () => <IdBooklet /> },
  notices: { title: "Public Notices", render: () => <Bulletin /> },
  tray: { title: "Correspondence Tray", render: () => <NotificationsInbox /> },
  forms: { title: "Government Forms", render: () => <DocumentRequest />, folder: true },
  letter: { title: "Office of Correspondence", render: () => <ContactRep /> },
};

function Counter({ unread }: { unread: number }) {
  const desk = useDesk();
  const [paged, setPaged] = useState(false);
  const node = CIVILIAN_CLERK.root;

  function page() {
    playPager();
    setPaged(true);
  }

  function choose(service: ServiceId) {
    const s = SERVICES[service];
    playPrinter();
    desk.open(service, s.title, s.render(), s.folder);
    setPaged(false);
  }

  return (
    <div className="stage">
      <div className="office">
        <OfficeScene paged={paged} />

        {/* Pager device hotspot (overlaid on the drawn device) */}
        <button
          className={`pager-hotspot${paged ? " is-active" : ""}`}
          onClick={page}
          aria-label="Press the pager to call the secretary"
        >
          {unread > 0 ? <span className="pager-lamp">{unread}</span> : null}
        </button>

        {!paged ? (
          <div className="pager-hint">Press the pager to call the secretary</div>
        ) : null}

        {/* Clerk dialogue */}
        {paged ? (
          <div className="dialogue" role="dialog" aria-label="Secretary">
            <div className="dialogue__speaker">{node.speaker}</div>
            <p className="dialogue__text">&laquo;{node.text}&raquo;</p>
            <ul className="dialogue__opts">
              {node.options.map((o, i) => {
                const isTray = o.action.type === "service" && o.action.service === "tray";
                const label = isTray && unread > 0 ? `${o.label} (${unread})` : o.label;
                return (
                  <li key={i}>
                    <button
                      className="dialogue__opt"
                      onClick={() => {
                        if (o.action.type === "service") choose(o.action.service);
                        else setPaged(false);
                      }}
                    >
                      <span className="caret">&rsaquo;</span> {label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {/* Printed papers land on the desk */}
        <PapersLayer />
      </div>
    </div>
  );
}

function PapersLayer() {
  const { docs, isMobile } = useDesk();
  if (isMobile && docs.length > 0) {
    return (
      <div className="mobile-sheet">
        {docs.map((d) => (
          <DeskDocument key={d.id} doc={d} />
        ))}
      </div>
    );
  }
  return (
    <>
      {docs.map((d) => (
        <DeskDocument key={d.id} doc={d} />
      ))}
    </>
  );
}

function Shell() {
  const { profile, signOut } = useAuth();
  const [unread, setUnread] = useState(0);
  const [muted, setMutedState] = useState(isMuted());

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

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
  }

  return (
    <div className="office-root">
      <div className="bureau-bar">
        <div>
          <h1>Beginnings</h1>
          <div className="sub">National Bureau &middot; {profile?.account_type} desk</div>
        </div>
        <div className="spacer" />
        <button className="chip-btn" onClick={toggleMute} aria-pressed={muted}>
          {muted ? "Sound off" : "Sound on"}
        </button>
        <button className="chip-btn" onClick={signOut}>Leave the office</button>
      </div>
      <Counter unread={unread} />
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
