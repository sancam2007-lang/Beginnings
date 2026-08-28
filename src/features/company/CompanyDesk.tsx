import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import { useDesk } from "../../components/desk/DeskManager";
import { DeskDocument } from "../../components/paper/DeskDocument";
import { NotificationsInbox } from "../civilian/NotificationsInbox";
import { Bulletin } from "../civilian/Bulletin";
import { CompanyOffice } from "./CompanyOffice";
import { CompanyMembers } from "./CompanyMembers";
import { CompanyLedger } from "./CompanyLedger";
import { CompanyAssets } from "./CompanyAssets";
import { CompanyFilings } from "./CompanyFilings";
import type { Region } from "../../lib/types";

interface CompanyLite { id: string; name: string; public_no: string; }

export function CompanyDesk() {
  const { profile } = useAuth();
  const [company, setCompany] = useState<CompanyLite | null | undefined>(undefined);

  const resolve = useCallback(async () => {
    if (!profile) return;
    const { data: owned } = await supabase.from("companies").select("id,name,public_no").eq("owner_id", profile.id).limit(1);
    if (owned && owned.length) return setCompany(owned[0] as CompanyLite);
    const { data: mem } = await supabase.from("company_members").select("company_id").eq("user_id", profile.id).eq("is_active", true).limit(1);
    if (mem && mem.length) {
      const { data: co } = await supabase.from("companies").select("id,name,public_no").eq("id", (mem[0] as { company_id: string }).company_id).maybeSingle();
      return setCompany((co as CompanyLite) ?? null);
    }
    setCompany(null);
  }, [profile]);

  useEffect(() => { resolve(); }, [resolve]);

  if (company === undefined) return <div className="desk"><p className="center-wait" style={{ color: "var(--paper)" }}>Opening the company office…</p></div>;
  if (company === null) return <div className="desk"><RegisterCard onDone={resolve} /></div>;
  return <CompanyTray company={company} />;
}

function CompanyTray({ company }: { company: CompanyLite }) {
  const desk = useDesk();
  const { docs, isMobile } = useDesk();

  const OBJECTS = [
    { id: "office", glyph: "🏢", label: "Company office", title: `${company.name}`, node: <CompanyOffice companyId={company.id} /> },
    { id: "people", glyph: "👥", label: "Personnel", title: "Personnel Register", node: <CompanyMembers companyId={company.id} /> },
    { id: "ledger", glyph: "📒", label: "Ledger", title: "Company Ledger", node: <CompanyLedger companyId={company.id} /> },
    { id: "assets", glyph: "📦", label: "Asset register", title: "Asset Register", node: <CompanyAssets companyId={company.id} />, folder: true },
    { id: "file", glyph: "📑", label: "File paperwork", title: "Government Filings", node: <CompanyFilings companyId={company.id} />, folder: true },
    { id: "inbox", glyph: "🗂️", label: "Incoming tray", title: "Correspondence Tray", node: <NotificationsInbox /> },
    { id: "board", glyph: "📌", label: "Bulletin board", title: "Public Notices", node: <Bulletin /> },
  ];

  const surface = isMobile && docs.length > 0
    ? <div className="mobile-sheet">{docs.map((d) => <DeskDocument key={d.id} doc={d} />)}</div>
    : <>{docs.map((d) => <DeskDocument key={d.id} doc={d} />)}</>;

  return (
    <div className="desk">
      <div className="desk-tray">
        {OBJECTS.map((o) => (
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

function RegisterCard({ onDone }: { onDone: () => void }) {
  const { profile } = useAuth();
  const [regions, setRegions] = useState<Region[]>([]);
  const [form, setForm] = useState({ name: "", industry: "", region_id: "", description: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.from("regions").select("id,code,name").order("name").then(({ data }) => setRegions((data as Region[]) ?? []));
  }, []);

  async function register() {
    if (!profile) return;
    setError(null);
    if (!form.name.trim()) return setError("Your company needs a name.");
    setBusy(true);
    const { error: e } = await supabase.from("companies").insert({
      name: form.name.trim(), owner_id: profile.id, industry: form.industry.trim() || null,
      region_id: form.region_id || null, description: form.description.trim() || null,
    });
    setBusy(false);
    if (e) return setError(e.message);
    onDone();
  }

  return (
    <div className="paper" style={{ position: "relative", margin: "40px auto", left: 0, top: 0 }}>
      <div className="paper__header"><span className="paper__title">Business Registration</span></div>
      <div className="paper__body">
        <div className="doc-seal">Register a Company · Crown Federation</div>
        <p className="doc-meta">You are not yet associated with a company. File a registration to open your business.</p>
        <div className="field"><label>Company name</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="field"><label>Industry</label><input value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} /></div>
        <div className="field"><label>Registered region</label>
          <select value={form.region_id} onChange={(e) => setForm({ ...form, region_id: e.target.value })}>
            <option value="">—</option>
            {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Description</label><textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
        {error ? <p className="note note--error">{error}</p> : null}
        <div className="btn-row"><button className="btn btn--stamp" onClick={register} disabled={busy}>{busy ? "Filing…" : "Register company"}</button></div>
      </div>
    </div>
  );
}
