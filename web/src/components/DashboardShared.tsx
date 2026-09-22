import type { ReactNode } from "react";

export function SectionHeading({ title, note, children }: { title: string; note?: string; children?: ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {note && <span className="note">{note}</span>}
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="dashboard-empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
