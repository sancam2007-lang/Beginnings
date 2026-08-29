import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { ReviewInbox } from "./ReviewInbox";
import { OutgoingTray } from "./OutgoingTray";
import { ReviewArchive } from "./ReviewArchive";

export interface DeskObjectDef {
  id: string; glyph: string; label: string; title: string; node: JSX.Element; folder?: boolean;
}

const REVIEW_PERMS = ["documents.approve", "business.tax_review", "business.permit_review", "documents.issue"];

// Returns review-desk objects if the current user can rule on any documents,
// otherwise an empty array (so ordinary citizens never see them).
export function useReviewObjects(): DeskObjectDef[] {
  const [objs, setObjs] = useState<DeskObjectDef[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc("my_review_queue");
      const queue = (data as unknown[]) ?? [];
      let canReview = queue.length > 0;
      if (!canReview) {
        for (const p of REVIEW_PERMS) {
          const { data: h } = await supabase.rpc("has_permission", { perm: p });
          if (h) { canReview = true; break; }
        }
      }
      if (!canReview) { setObjs([]); return; }
      setObjs([
        { id: "review-in", glyph: "📥", label: `Review inbox${queue.length ? ` (${queue.length})` : ""}`, title: "Documents Awaiting Ruling", node: <ReviewInbox />, folder: true },
        { id: "review-out", glyph: "📤", label: "Outgoing tray", title: "Processed Documents", node: <OutgoingTray /> },
        { id: "archive", glyph: "🗄️", label: "Records archive", title: "Records Archive", node: <ReviewArchive /> },
      ]);
    })();
  }, []);

  return objs;
}
