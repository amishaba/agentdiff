import { useEffect, useRef, type ReactNode } from "react";

/**
 * A panel over the right of the page for one row of a table: a header with
 * the row's badge and title, previous/next/close (↑ ↓ or j k, Esc), and a
 * scrolling body. `id` changes when the row does, which moves focus back in.
 */
export function SidePanel({
  id,
  badge,
  title,
  subtitle,
  position,
  noun,
  onPrev,
  onNext,
  onClose,
  footer,
  children,
}: {
  id: string;
  badge?: ReactNode;
  title: string;
  subtitle?: ReactNode;
  /** "2 of 9" */
  position?: string;
  /** What a row is, for the arrow buttons' labels: "test", "scenario". */
  noun: string;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.focus(), [id]);
  return (
    <>
      <div className="drawer-backdrop side-panel-backdrop" onClick={onClose} />
      <aside
        className="drawer side-panel"
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if ((e.key === "ArrowDown" || e.key === "j") && onNext) onNext();
          else if ((e.key === "ArrowUp" || e.key === "k") && onPrev) onPrev();
          else return;
          e.preventDefault();
        }}
      >
        <header className="panel-head">
          <div className="panel-title">
            {badge}
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <div className="panel-nav">
            {position && <span>{position}</span>}
            <button onClick={onPrev} disabled={!onPrev} aria-label={`Previous ${noun}`} title="Previous (↑)">
              ↑
            </button>
            <button onClick={onNext} disabled={!onNext} aria-label={`Next ${noun}`} title="Next (↓)">
              ↓
            </button>
            <button onClick={onClose} aria-label="Close" title="Close (Esc)">
              ×
            </button>
          </div>
        </header>
        <div className="panel-body">{children}</div>
        {footer && <footer className="panel-foot">{footer}</footer>}
      </aside>
    </>
  );
}
