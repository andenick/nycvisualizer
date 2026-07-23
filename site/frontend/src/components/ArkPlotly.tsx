// Interactive chart per the Universal Graph Contract (WEBSITE_VISUALIZATION_STANDARD):
// - Download CSV button TOP-RIGHT of every chart
// - legend BELOW the plot (horizontal)
// - one chart per row (block-level section)
// - vendored/bundled plotly (dynamic import of plotly.js-dist-min; no CDN)
import { useEffect, useRef, useState } from "react";

export interface ArkPlotlyProps {
  title: string;
  subtitle?: string;
  /** Plotly traces. */
  data: Record<string, unknown>[];
  layout?: Record<string, unknown>;
  /** Rows for the CSV download (first row keys = header). */
  csvRows: Record<string, string | number | null>[];
  csvName: string;
  /** Source/vintage line shown under the chart. */
  source?: string;
  height?: number;
}

function toCsv(rows: Record<string, string | number | null>[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

export default function ArkPlotly({
  title,
  subtitle,
  data,
  layout,
  csvRows,
  csvName,
  source,
  height = 380,
}: ArkPlotlyProps) {
  const el = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const [failed, setFailed] = useState(false);
  // Q0.6.2: defer the ~1.49MB plotly chunk until the chart is near the viewport.
  // Plotly is already a dynamic import, but this component's draw effect used to
  // run on mount — so a below-the-fold chart (e.g. the landing OMNY chart) still
  // fetched plotly during first paint. Gate the import behind IntersectionObserver
  // so landing first-paint no longer pulls plotly.
  const [visible, setVisible] = useState<boolean>(
    typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    if (visible) return; // already scheduled to draw
    const target = sectionRef.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "250px" },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let node: HTMLDivElement | null = null;
    import("plotly.js-dist-min")
      .then((mod) => {
        const Plotly = (mod as { default?: unknown }).default ?? mod;
        if (disposed || !el.current) return;
        node = el.current;
        const dark =
          window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
        const fg = dark ? "#d5dae2" : "#22272e";
        const grid = dark ? "rgba(160,170,185,0.18)" : "rgba(60,70,85,0.14)";
        (Plotly as { newPlot: (...a: unknown[]) => void }).newPlot(
          node,
          data,
          {
            margin: { t: 12, r: 16, b: 40, l: 52 },
            height,
            paper_bgcolor: "rgba(0,0,0,0)",
            plot_bgcolor: "rgba(0,0,0,0)",
            font: { color: fg, family: "system-ui, sans-serif", size: 13 },
            xaxis: { gridcolor: grid, zerolinecolor: grid },
            yaxis: { gridcolor: grid, zerolinecolor: grid },
            // Contract: legend BELOW the plot.
            legend: { orientation: "h", yanchor: "top", y: -0.18, x: 0 },
            ...layout,
          },
          { displayModeBar: false, responsive: true },
        );
      })
      .catch(() => setFailed(true));
    return () => {
      disposed = true;
      if (node) {
        import("plotly.js-dist-min")
          .then((mod) => {
            const Plotly = (mod as { default?: unknown }).default ?? mod;
            (Plotly as { purge: (n: HTMLDivElement) => void }).purge(node as HTMLDivElement);
          })
          .catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const downloadCsv = () => {
    const blob = new Blob([toCsv(csvRows)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = csvName;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section ref={sectionRef} className="nyc-chart" style={{ margin: "1.6rem 0" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "0.6rem",
          flexWrap: "wrap",
          marginBottom: "0.3rem",
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: "1.05rem" }}>{title}</h3>
          {subtitle && <div style={{ fontSize: "0.82rem", opacity: 0.75 }}>{subtitle}</div>}
        </div>
        {/* Contract: Download CSV top-right */}
        <button
          onClick={downloadCsv}
          style={{
            border: "1px solid var(--ark-border, #d4d8dd)",
            background: "var(--ark-accent-soft, #dbeafe)",
            color: "var(--ark-accent, #2563eb)",
            borderRadius: 8,
            padding: "0.25rem 0.7rem",
            fontSize: "0.8rem",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Download CSV
        </button>
      </div>
      {failed ? (
        <div className="nyc-note">Chart failed to load — the data is still downloadable above.</div>
      ) : (
        // minHeight reserves layout space so the deferred mount doesn't shift the page.
        <div ref={el} style={{ width: "100%", minHeight: height }} />
      )}
      {source && (
        <div style={{ fontSize: "0.74rem", opacity: 0.65, marginTop: "0.2rem" }}>{source}</div>
      )}
    </section>
  );
}
