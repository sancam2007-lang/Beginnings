import { useState } from "react";
import { UsersPanel } from "./UsersPanel";
import { RegionsPanel } from "./RegionsPanel";
import { OfficesPanel } from "./OfficesPanel";
import { AnnouncementsPanel } from "./AnnouncementsPanel";

type TabId = "users" | "regions" | "offices" | "notices";

const TABS: { id: TabId; label: string }[] = [
  { id: "users", label: "Citizens" },
  { id: "regions", label: "Regions" },
  { id: "offices", label: "Offices & Powers" },
  { id: "notices", label: "Notices" },
];

export function AdminBureau() {
  const [tab, setTab] = useState<TabId>("users");

  return (
    <div className="admin-stage">
      <div className="ledger-book">
        <div className="ledger-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`ledger-tab${tab === t.id ? " is-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ledger-page">
          <div className="ledger-crest">Administrative Bureau · Crown Federation</div>
          {tab === "users" ? <UsersPanel /> : null}
          {tab === "regions" ? <RegionsPanel /> : null}
          {tab === "offices" ? <OfficesPanel /> : null}
          {tab === "notices" ? <AnnouncementsPanel /> : null}
        </div>
      </div>
    </div>
  );
}
