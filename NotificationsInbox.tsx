import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { NotificationRow } from "../../lib/types";

export function NotificationsInbox() {
  const [items, setItems] = useState<NotificationRow[] | null>(null);

  async function load() {
    const { data } = await supabase
      .from("notifications")
      .select("id,kind,title,body,link_type,link_id,is_read,created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    setItems((data as NotificationRow[]) ?? []);
  }

  async function markRead(id: string) {
    await supabase.from("notifications").update({ is_read: true }).eq("id", id);
    setItems((prev) => prev?.map((n) => (n.id === id ? { ...n, is_read: true } : n)) ?? null);
  }

  useEffect(() => {
    load();
  }, []);

  if (items === null) return <p className="note">Opening the tray…</p>;
  if (items.length === 0) return <p className="note">No correspondence in your tray.</p>;

  return (
    <div>
      <div className="doc-seal">Incoming Tray</div>
      <table className="ledger">
        <tbody>
          {items.map((n) => (
            <tr key={n.id} className={n.is_read ? "" : "unread"}>
              <td>
                <div>{n.title}</div>
                {n.body ? <div style={{ opacity: 0.7, fontSize: 12 }}>{n.body}</div> : null}
                <div style={{ opacity: 0.6, fontSize: 11 }}>
                  {new Date(n.created_at).toLocaleString()}
                </div>
              </td>
              <td style={{ width: 90, textAlign: "right" }}>
                {n.is_read ? (
                  <span style={{ opacity: 0.5, fontSize: 11 }}>read</span>
                ) : (
                  <button className="linkish" onClick={() => markRead(n.id)}>
                    mark read
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
