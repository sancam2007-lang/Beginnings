import { useState } from "react";
import { UsersPanel } from "./UsersPanel";
import { RegionsPanel } from "./RegionsPanel";
import { OfficesPanel } from "./OfficesPanel";
import { TemplatesPanel } from "./TemplatesPanel";
import { ElectionsPanel } from "./ElectionsPanel";
import { EventsPanel } from "./EventsPanel";
import { ReviewPanel } from "./ReviewPanel";
import { MissionsPanel } from "./MissionsPanel";
import { AurorsPanel } from "./AurorsPanel";
import { AnnouncementsPanel } from "./AnnouncementsPanel";

type TabId =
  | "users" | "regions" | "offices" | "templates"
  | "elections" | "events" | "review" | "missions" | "aurors" | "notices";

const TABS: { id: TabId; label: string }[] = [
  { id: "users", label: "Citizens" },
  { id: "regions", label: "Regions" },
  { id: "offices", label: "Offices & Powers" },
  { id: "templates", label: "Forms" },
  { id: "elections", label: "Elections" },
  { id: "events", label: "Events" },
  { id: "review", label: "Submissions" },
  { id: "missions", label: "Missions" },
  { id: "aurors", label: "Aurors" },
  { id: "notices", label: "Notices" },
];

export function AdminBureau() {
  const [tab, setTab] = useState<TabId>("users");
  return (
    <div className="admin-stage">
      <div className="ledger-book">
        <div className="ledger-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`ledger-tab${tab === t.id ? " is-active" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="ledger-page">
          <div className="ledger-crest">Administrative Bureau · Crown Federation</div>
          {tab === "users" ? <UsersPanel /> : null}
          {tab === "regions" ? <RegionsPanel /> : null}
          {tab === "offices" ? <OfficesPanel /> : null}
          {tab === "templates" ? <TemplatesPanel /> : null}
          {tab === "elections" ? <ElectionsPanel /> : null}
          {tab === "events" ? <EventsPanel /> : null}
          {tab === "review" ? <ReviewPanel /> : null}
          {tab === "missions" ? <MissionsPanel /> : null}
          {tab === "aurors" ? <AurorsPanel /> : null}
          {tab === "notices" ? <AnnouncementsPanel /> : null}
        </div>
      </div>
    </div>
  );
}
