export interface BackgroundDef { key: string; label: string; src: string; aspect: number; }

// aspect = width / height, measured from the sliced assets
export const BACKGROUNDS: BackgroundDef[] = [
  { key: "letterhead", label: "Letterhead", src: "/assets/backgrounds/letterhead.png", aspect: 1.4102 },
  { key: "report", label: "Report", src: "/assets/backgrounds/report.png", aspect: 1.2793 },
  { key: "lined", label: "Lined sheet", src: "/assets/backgrounds/lined.png", aspect: 1.4102 },
  { key: "blank", label: "Blank aged", src: "/assets/backgrounds/blank.png", aspect: 1.3281 },
  { key: "grid", label: "Grid", src: "/assets/backgrounds/grid.png", aspect: 0.7502 },
  { key: "ballot", label: "Ballot", src: "/assets/backgrounds/ballot.png", aspect: 0.7421 },
  { key: "certificate", label: "Certificate", src: "/assets/backgrounds/certificate.png", aspect: 0.7621 },
  { key: "receipt", label: "Receipt", src: "/assets/backgrounds/receipt.png", aspect: 0.6862 },
];

export function bgByKey(key: string | null | undefined): BackgroundDef | undefined {
  return BACKGROUNDS.find((b) => b.key === key);
}
