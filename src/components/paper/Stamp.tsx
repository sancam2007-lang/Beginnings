export function Stamp({ text, sub }: { text: string; sub?: string }) {
  return (
    <div className="stamp stamp--thud" role="img" aria-label={`Stamped: ${text}`}>
      {text}
      {sub ? <small>{sub}</small> : null}
    </div>
  );
}
