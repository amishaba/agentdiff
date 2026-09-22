import type { ReactNode } from "react";

/** A headline number with its label and a line of context; `children` (a bar, a legend) go under the number. */
export function StatTile({
  label,
  value,
  sub,
  children,
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  children?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <div className="stat-value">{value}</div>
      {children}
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}
