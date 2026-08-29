export interface MarkDef { key: string; label: string; src: string; }

export const STAMPS: MarkDef[] = [
  { key: "approved", label: "Approved", src: "/assets/stamps/approved.png" },
  { key: "denied", label: "Denied", src: "/assets/stamps/denied.png" },
  { key: "received", label: "Received", src: "/assets/stamps/received.png" },
  { key: "paid", label: "Paid", src: "/assets/stamps/paid.png" },
  { key: "classified", label: "Classified", src: "/assets/stamps/classified.png" },
  { key: "void", label: "Void", src: "/assets/stamps/void.png" },
  { key: "filed", label: "Filed", src: "/assets/stamps/filed.png" },
];

export const SEALS: MarkDef[] = [
  { key: "red", label: "Red wax", src: "/assets/seals/red.png" },
  { key: "blue", label: "Blue wax", src: "/assets/seals/blue.png" },
  { key: "gold", label: "Gold wax", src: "/assets/seals/gold.png" },
];

// Stamps that drive a real ruling in process_stamps (the rest are decorative).
export const ACTION_STAMPS = new Set(["approved", "denied", "received", "void", "paid", "classified"]);

export interface MarkPlacement {
  id: string; kind: "stamp" | "seal"; key: string;
  x: number; y: number; w: number; h: number; rot?: number;
}

export function markSrc(kind: "stamp" | "seal", key: string): string | undefined {
  return (kind === "stamp" ? STAMPS : SEALS).find((m) => m.key === key)?.src;
}

let SEQ = 0;
export const markId = () => `m${Date.now()}_${SEQ++}`;
