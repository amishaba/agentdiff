/** Changed prompt lines, removed in red and added in green; `short` keeps each to one line. */
export function DiffLines({ lines, short }: { lines: { sign: "-" | "+"; text: string }[]; short?: boolean }) {
  return (
    <div className={`diff-lines${short ? " short" : ""}`}>
      {lines.map((l, i) => (
        <div key={i} className={l.sign === "-" ? "del" : "add"} title={short ? l.text : undefined}>
          <span aria-hidden="true">{l.sign === "-" ? "−" : "+"}</span>
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  );
}
