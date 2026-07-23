// A small error boundary so a single chart/canvas fault (e.g. a transient
// 0-sized layout tick in the Marey canvas) degrades to an inline notice instead
// of unmounting the whole page. Carson D5 — no render race may blank a route.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  label?: string; // what failed, e.g. "Marey diagram"
}
interface State {
  failed: boolean;
}

export default class ChartErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep a console trace for diagnostics; never rethrow.
    console.warn(`[ChartErrorBoundary] ${this.props.label ?? "chart"} failed`, error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="chart-error" role="status">
          <p>
            The {this.props.label ?? "chart"} could not be drawn just now. The rest of the
            page is unaffected — try reloading or adjusting the window.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
