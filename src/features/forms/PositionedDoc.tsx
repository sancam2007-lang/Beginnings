import { useLayoutEffect, useRef, useState } from "react";
import type { TemplateField } from "../../lib/types";
import { bgByKey } from "./backgrounds";
import { markSrc, type MarkPlacement } from "./marks";

// True when a template is a designed (positioned) form rather than a stacked one.
export function isPositioned(bgKey: string | null | undefined, fields: TemplateField[]): boolean {
  return !!bgByKey(bgKey) && fields.some((f) => f.pos_x != null && f.pos_y != null);
}

function choicesOf(f: TemplateField): string[] {
  const c = (f.options as { choices?: unknown })?.choices;
  return Array.isArray(c) ? (c as string[]) : [];
}

export function PositionedDoc({
  backgroundKey, fields, values, onChange, readOnly = false, marks = [],
}: {
  backgroundKey: string | null | undefined;
  fields: TemplateField[];
  values: Record<string, string>;
  onChange?: (key: string, v: string) => void;
  readOnly?: boolean;
  marks?: MarkPlacement[];
}) {
  const bg = bgByKey(backgroundKey);
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(700);

  useLayoutEffect(() => {
    function measure() { if (ref.current) setH(ref.current.getBoundingClientRect().height); }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [backgroundKey]);

  return (
    <div
      ref={ref}
      className="posdoc"
      style={{ aspectRatio: String(bg?.aspect ?? 0.75), backgroundImage: bg ? `url("${bg.src}")` : undefined }}
    >
      {fields.filter((f) => f.pos_x != null).map((f) => {
        const style: React.CSSProperties = {
          left: `${(f.pos_x ?? 0) * 100}%`, top: `${(f.pos_y ?? 0) * 100}%`,
          width: `${(f.width ?? 0.3) * 100}%`, height: `${(f.height ?? 0.05) * 100}%`,
          fontSize: `${(f.font_size ?? 0.03) * h}px`,
        };
        const v = values[f.key] ?? "";
        return (
          <div key={f.id} className="posfield" style={style}>
            {readOnly
              ? <ReadValue field={f} value={v} />
              : <FillInput field={f} value={v} onChange={onChange} choices={choicesOf(f)} />}
          </div>
        );
      })}
      {marks.map((m) => (
        <img
          key={m.id}
          className="posmark"
          src={markSrc(m.kind, m.key)}
          alt=""
          style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%`, transform: `rotate(${m.rot ?? 0}deg)` }}
        />
      ))}
    </div>
  );
}

function ReadValue({ field, value }: { field: TemplateField; value: string }) {
  if (field.field_type === "declaration" || field.field_type === "checkbox") {
    return <span className="posval">{value === "true" ? "\u2713" : ""}</span>;
  }
  return <span className="posval">{value}</span>;
}

function FillInput({ field, value, onChange, choices }: {
  field: TemplateField; value: string; onChange?: (k: string, v: string) => void; choices: string[];
}) {
  const set = (v: string) => onChange?.(field.key, v);
  switch (field.field_type) {
    case "declaration":
    case "checkbox":
      return <input className="posin posin--check" type="checkbox" checked={value === "true"} onChange={(e) => set(e.target.checked ? "true" : "")} />;
    case "long_text":
      return <textarea className="posin posin--area" value={value} onChange={(e) => set(e.target.value)} placeholder={field.label} />;
    case "dropdown":
    case "radio":
      return (
        <select className="posin" value={value} onChange={(e) => set(e.target.value)}>
          <option value="">{field.label}</option>
          {choices.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      );
    default: {
      const type = field.field_type === "date" ? "date" : (field.field_type === "number" || field.field_type === "currency") ? "number" : "text";
      return <input className="posin" type={type} value={value} onChange={(e) => set(e.target.value)} placeholder={field.label} />;
    }
  }
}
