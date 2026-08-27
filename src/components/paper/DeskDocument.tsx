import { useRef } from "react";
import { useDesk, type DeskDoc } from "../desk/DeskManager";

export function DeskDocument({ doc }: { doc: DeskDoc }) {
  const { close, focus, move, isMobile } = useDesk();
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  function onPointerDown(e: React.PointerEvent) {
    if (isMobile) return;
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

  const style = isMobile
    ? undefined
    : { left: doc.x, top: doc.y, zIndex: doc.z };

  return (
    <article
      className={`paper${doc.folder ? " paper--folder" : ""}`}
      style={style}
      onPointerDown={() => !isMobile && focus(doc.id)}
    >
      <header
        className="paper__header"
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
