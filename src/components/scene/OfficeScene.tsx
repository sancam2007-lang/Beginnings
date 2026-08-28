// The office, drawn in code as pixel art (SVG rects, crisp edges). Structured so
// a real artist's PNG could replace this backdrop later without touching logic.
// `paged` lights the clerk's call bell when the pager is pressed.

export function OfficeScene({ paged }: { paged: boolean }) {
  return (
    <svg
      className="office-svg"
      viewBox="0 0 320 240"
      preserveAspectRatio="xMidYMid meet"
      shapeRendering="crispEdges"
      role="img"
      aria-label="A government clerk seated behind a counter with a document slot."
    >
      {/* ---- Back wall ---- */}
      <rect x="0" y="0" width="320" height="160" fill="#39453f" />
      <rect x="0" y="0" width="320" height="160" fill="#2f3a34" opacity="0.35" />
      {/* wall panel seams */}
      <rect x="0" y="150" width="320" height="4" fill="#232b27" />
      <rect x="0" y="60" width="320" height="2" fill="#313c36" />

      {/* ---- Barred window with a waiting queue ---- */}
      <rect x="34" y="20" width="120" height="86" fill="#232b27" />
      <rect x="38" y="24" width="112" height="78" fill="#7c8a7d" />
      <rect x="38" y="24" width="112" height="30" fill="#94a08f" />
      {/* distant queue silhouette */}
      <rect x="46" y="70" width="10" height="24" fill="#20272300" />
      <g fill="#2b332e">
        <rect x="46" y="72" width="10" height="22" />
        <rect x="44" y="66" width="14" height="8" />
        <rect x="62" y="76" width="9" height="18" />
        <rect x="61" y="70" width="11" height="8" />
        <rect x="78" y="70" width="11" height="24" />
        <rect x="77" y="63" width="13" height="9" />
        <rect x="96" y="75" width="9" height="19" />
        <rect x="112" y="71" width="11" height="23" />
        <rect x="128" y="77" width="10" height="17" />
      </g>
      {/* bars */}
      <g fill="#191d1a">
        <rect x="58" y="24" width="4" height="78" />
        <rect x="82" y="24" width="4" height="78" />
        <rect x="106" y="24" width="4" height="78" />
        <rect x="130" y="24" width="4" height="78" />
        <rect x="38" y="60" width="112" height="4" />
      </g>

      {/* ---- Framed national seal ---- */}
      <rect x="210" y="26" width="72" height="74" fill="#43352a" />
      <rect x="216" y="32" width="60" height="62" fill="#e7dcc0" />
      <circle cx="246" cy="63" r="22" fill="none" stroke="#8f2420" strokeWidth="3" />
      <circle cx="246" cy="63" r="13" fill="none" stroke="#8f2420" strokeWidth="2" />
      <rect x="240" y="57" width="12" height="12" fill="#8f2420" />

      {/* ---- Clerk behind the counter ---- */}
      {/* chair back + coat */}
      <rect x="150" y="96" width="60" height="60" fill="#3b4a41" />
      <rect x="150" y="96" width="60" height="10" fill="#45564b" />
      {/* head */}
      <rect x="168" y="86" width="26" height="26" fill="#b9a189" />
      <rect x="168" y="86" width="26" height="8" fill="#7d6a58" />{/* hair */}
      <rect x="172" y="98" width="4" height="4" fill="#3a2f27" />{/* eyes */}
      <rect x="186" y="98" width="4" height="4" fill="#3a2f27" />
      <rect x="176" y="106" width="10" height="2" fill="#7d6a58" />
      {/* collar */}
      <rect x="170" y="112" width="22" height="6" fill="#e7dcc0" />
      <rect x="179" y="112" width="4" height="14" fill="#8f2420" />{/* tie */}

      {/* call bell on the counter — lights when paged */}
      <rect x="214" y="150" width="14" height="6" fill="#6b6f66" />
      <rect x="217" y="144" width="8" height="8" fill={paged ? "#e7c94a" : "#8a5f2a"} />
      {paged ? <rect x="215" y="140" width="12" height="3" fill="#f2e08a" /> : null}

      {/* ---- Desk / counter (foreground) ---- */}
      <rect x="0" y="156" width="320" height="84" fill="#5a4634" />
      <rect x="0" y="156" width="320" height="8" fill="#6d5741" />
      <rect x="0" y="176" width="320" height="3" fill="#43331f" opacity="0.6" />
      <rect x="0" y="230" width="320" height="10" fill="#3f2f1e" />

      {/* metal document slot */}
      <rect x="96" y="188" width="128" height="14" fill="#20242600" />
      <rect x="96" y="190" width="128" height="12" fill="#8f958f" />
      <rect x="100" y="193" width="120" height="6" fill="#101314" />
      <rect x="100" y="192" width="120" height="2" fill="#c7ccc6" />

      {/* pager / intercom device (the hotspot button is overlaid in the DOM) */}
      <rect x="238" y="176" width="56" height="30" fill="#26262a" />
      <rect x="238" y="176" width="56" height="4" fill="#3a3a40" />
      <g fill="#15151800">
        <rect x="244" y="184" width="24" height="2" fill="#3d3d42" />
        <rect x="244" y="188" width="24" height="2" fill="#3d3d42" />
        <rect x="244" y="192" width="24" height="2" fill="#3d3d42" />
      </g>
      <rect x="274" y="184" width="14" height="14" fill="#8f2420" />
      <rect x="274" y="184" width="14" height="3" fill="#b5433d" />
    </svg>
  );
}
