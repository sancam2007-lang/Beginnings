import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Announcement } from "../../lib/types";

export function Bulletin() {
  const [items, setItems] = useState<Announcement[] | null>(null);

  useEffect(() => {
    supabase
      .from("announcements")
      .select("id,level,title,body,is_pinned,published_at")
      .order("is_pinned", { ascending: false })
      .order("published_at", { ascending: false })
      .then(({ data }) => setItems((data as Announcement[]) ?? []));
  }, []);

  if (items === null) return <p className="note">Reading the board…</p>;
  if (items.length === 0) return <p className="note">The board is empty today.</p>;

  return (
    <div>
      <div className="doc-seal">Public Notices</div>
      {items.map((a) => (
        <div key={a.id} style={{ marginBottom: 16 }}>
          <div className="doc-meta">
            {a.is_pinned ? "★ " : ""}{a.level} · {new Date(a.published_at).toLocaleDateString()}
          </div>
          <strong style={{ fontSize: 17 }}>{a.title}</strong>
          {a.body ? <p style={{ margin: "4px 0 0" }}>{a.body}</p> : null}
        </div>
      ))}
    </div>
  );
}
