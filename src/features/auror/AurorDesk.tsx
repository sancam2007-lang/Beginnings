import { useDesk } from "../../components/desk/DeskManager";
import { DeskDocument } from "../../components/paper/DeskDocument";
import { useReviewObjects } from "../review/useReviewObjects";
import { NotificationsInbox } from "../civilian/NotificationsInbox";
import { Bulletin } from "../civilian/Bulletin";
import { AgentFile } from "./AgentFile";
import { MissionBoard } from "./MissionBoard";
import { MyMissions } from "./MyMissions";

export function AurorDesk() {
  const desk = useDesk();
  const { docs, isMobile } = useDesk();

  const reviewObjs = useReviewObjects();
  const OBJECTS = [
    { id: "file", glyph: "🗄️", label: "Agent file", title: "Auror Service Record", node: <AgentFile /> },
    { id: "board", glyph: "📋", label: "Mission board", title: "Mission Board", node: <MissionBoard />, folder: true },
    { id: "mine", glyph: "🎯", label: "My missions", title: "Your Assignments", node: <MyMissions />, folder: true },
    { id: "inbox", glyph: "🗂️", label: "Incoming tray", title: "Correspondence Tray", node: <NotificationsInbox /> },
    { id: "notices", glyph: "📌", label: "Bulletin board", title: "Public Notices", node: <Bulletin /> },
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
