import { useEffect, useRef } from "react";

export interface Box { x: number; y: number; w: number; h: number }
type Mode = "move" | "resize";

// Generic drag/resize over a canvas element. Reports fractional (0..1) updates.
export function useCanvasDrag(
  canvasRef: React.RefObject<HTMLElement>,
  apply: (id: string, box: Partial<Box>) => void,
  getBox: (id: string) => Box | undefined,
) {
  const drag = useRef<{ mode: Mode; id: string; offX: number; offY: number } | null>(null);

  useEffect(() => {
    function move(e: PointerEvent) {
      const d = drag.current; if (!d || !canvasRef.current) return;
      const r = canvasRef.current.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      const b = getBox(d.id); if (!b) return;
      if (d.mode === "move") {
        apply(d.id, {
          x: Math.min(Math.max(fx - d.offX, 0), 1 - b.w),
          y: Math.min(Math.max(fy - d.offY, 0), 1 - b.h),
        });
      } else {
        apply(d.id, {
          w: Math.min(Math.max(fx - b.x, 0.03), 1 - b.x),
          h: Math.min(Math.max(fy - b.y, 0.02), 1 - b.y),
        });
      }
    }
    function up() { drag.current = null; }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [canvasRef, apply, getBox]);

  function startMove(e: React.PointerEvent, id: string) {
    e.stopPropagation();
    const b = getBox(id); if (!b || !canvasRef.current) return;
    const r = canvasRef.current.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    drag.current = { mode: "move", id, offX: fx - b.x, offY: fy - b.y };
  }
  function startResize(e: React.PointerEvent, id: string) {
    e.stopPropagation();
    drag.current = { mode: "resize", id, offX: 0, offY: 0 };
  }
  return { startMove, startResize };
}
