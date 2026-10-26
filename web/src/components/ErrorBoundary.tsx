import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** What broke, as the heading says it: "This comparison", "Scenarios". */
  label: string;
  /** A new value (another comparison, another test) clears the error. */
  resetKey?: unknown;
  children: ReactNode;
}

/** Keeps one section's render error inside that section, with what broke and a retry; the rest of the app keeps working. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(previous: Props) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.label} failed to render.`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="dashboard-empty" role="alert">
        <h2>{this.props.label} couldn’t be shown</h2>
        <p>{error.message}</p>
        <p>Everything else still works. Try again, or reload the page if it keeps happening.</p>
        <button className="dashboard-button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
