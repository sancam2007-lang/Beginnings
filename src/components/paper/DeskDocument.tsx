import { useRef } from "react";
import { useDesk, type DeskDoc } from "../desk/DeskManager";

/**
 * A printed document. In the office scene papers are "docked" — anchored to the
 * slot's mouth and not freely dragged (keeps them aligned with the slit). The
 * draggable behaviour is retained for non-docked contexts.
 */
export function DeskDocument({ doc, docked = false }: { doc: DeskDoc; docked?: boolean }) {
  const { close, focus, move, isMobile } = useDesk();
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const draggable = !docked && !isMobile;

  function onPointerDown(e: React.PointerEvent) {
    if (!draggable) return;
    focus(doc.id);
    drag.current = { dx: e.clientX - doc.x, dy: e.clientY - doc.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    move(doc.id, e.clientX - drag.current.dx, e.clientY - drag.current.dy);
  }
  function onPointerUp() {
    drag.current = null;
  }

  const style = draggable ? { left: doc.x, top: doc.y, zIndex: doc.z } : { zIndex: doc.z };

  return (
    <article
      className={`paper${docked ? " paper--docked" : ""}${doc.folder ? " paper--folder" : ""}`}
      style={style}
      onPointerDown={() => draggable && focus(doc.id)}
    >
      <header
        className="paper__header"
        style={draggable ? undefined : { cursor: "default" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className="paper__title">{doc.title}</span>
        <button className="paper__file" onClick={() => close(doc.id)} aria-label="File away">
          File away
        </button>
      </header>
      <div className="paper__body">{doc.content}</div>
    </article>
  );
}
