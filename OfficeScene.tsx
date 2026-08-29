// The office, composited from the real pixel-art assets in /public/assets.
// Layer order (back to front): room, clerk (seated behind the counter),
// desk with props, and the brass document slot. The pager button and the
// printed papers are rendered by Desk.tsx on top, anchored to this same
// fixed 3:2 frame so everything lines up at any size.

export function OfficeScene({ paged }: { paged: boolean }) {
  return (
    <>
      <img className="layer layer-room" src="/assets/room.jpg" alt="" aria-hidden />
      <img
        className={`layer layer-clerk${paged ? " is-attentive" : ""}`}
        src="/assets/clerk.png"
        alt=""
        aria-hidden
      />
      <img className="layer layer-slot" src="/assets/slot.png" alt="" aria-hidden />
    </>
  );
}
