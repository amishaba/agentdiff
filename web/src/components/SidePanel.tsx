import { useEffect, useRef, type ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

/**
 * A panel over the right of the page for one row of a table: a header with
 * the row's badge and title, previous/next/close (↑ ↓ or j k, Esc), and a
 * scrolling body. `id` changes when the row does, which moves focus back in
 * and scrolls the table's selected row into view. The table stays usable:
 * clicking another row switches to it, clicking anywhere else closes, and
 * closing hands focus back to the row.
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
  const row = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    panel.current?.focus();
    row.current = document.querySelector<HTMLElement>(".rows-open tbody tr.selected");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.current?.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  }, [id]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      const at = e.target instanceof Element ? e.target : null;
      // The page's scrollbar, the panel, a drawer it opened, or a row (which switches the panel) don't close it.
      if (!at || at === document.documentElement) return;
      if (!at.closest(".side-panel, .drawer, .drawer-backdrop, .rows-open tbody tr")) close.current();
    };
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      // Back to the row the panel showed, unless the click that closed it focused something else.
      const link = row.current?.querySelector<HTMLElement>(".row-link");
      if (link?.isConnected && (!document.activeElement || document.activeElement === document.body))
        link.focus({ preventScroll: true });
    };
  }, []);
  return (
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
      <div className="panel-body">
        <ErrorBoundary label={`This ${noun}`} resetKey={id}>
          {children}
        </ErrorBoundary>
      </div>
      {footer && <footer className="panel-foot">{footer}</footer>}
    </aside>
  );
}
