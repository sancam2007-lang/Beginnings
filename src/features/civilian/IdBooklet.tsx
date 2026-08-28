import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../auth/AuthProvider";
import type { Region } from "../../lib/types";

export function IdBooklet() {
  const { profile } = useAuth();
  const [region, setRegion] = useState<Region | null>(null);

  useEffect(() => {
    if (!profile?.home_region_id) return;
    supabase
      .from("regions")
      .select("id,code,name")
      .eq("id", profile.home_region_id)
      .maybeSingle()
      .then(({ data }) => setRegion((data as Region) ?? null));
  }, [profile?.home_region_id]);

  if (!profile) return <p className="note">Your record could not be loaded.</p>;

  return (
    <div>
      <div className="doc-seal">Registry of Citizens · Beginnings</div>
      <h2 className="doc-h">{profile.full_name ?? "Unnamed Citizen"}</h2>
      <table className="ledger">
        <tbody>
          <tr><th>Citizen ID</th><td>{profile.citizen_id}</td></tr>
          <tr><th>Classification</th><td>{profile.account_type}</td></tr>
          <tr><th>Home region</th><td>{region ? region.name : "Unregistered"}</td></tr>
          <tr><th>Occupation</th><td>{profile.occupation ?? "—"}</td></tr>
          <tr><th>Standing</th><td>{profile.status}</td></tr>
          <tr>
            <th>Registered</th>
            <td>{new Date(profile.registered_at).toLocaleDateString()}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
