// League tables (S5 item 3) — /observatory/leagues. Most/least reliable routes,
// slowest corridors, and most-improved-vs-schedule, each with its exclusion
// criteria stated up front (thin/gap-dominated routes are excluded, and the
// whole board is PRELIMINARY until the archive reaches 14-day depth).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getLeagues, type LeaguesResponse } from "../lib/api";
import ArchiveBadge from "../components/ArchiveBadge";
import ObsSubnav from "../components/ObsSubnav";

const href = (routeId: string) => `/observatory/${encodeURIComponent(routeId)}`;

// Client-side CSV export so every league table is downloadable (Carson
// DOWNLOAD_AND_FORMATS / TABLE_RENDERING — every data table gets a CSV).
function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}
function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const blob = new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function PanelHead({ title, onDownload }: { title: string; onDownload: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "0.5rem" }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <button type="button" className="nyc-dl-btn" onClick={onDownload} aria-label={`Download ${title} as CSV`}>
        Download CSV
      </button>
    </div>
  );
}

export default function LeaguesPage() {
  const [d, setD] = useState<LeaguesResponse | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    getLeagues().then(setD).catch(() => setErr(true));
  }, []);

  if (err) return <div className="nyc-note">League tables temporarily unavailable.</div>;
  if (!d) return <div className="nyc-note">Loading league tables…</div>;

  return (
    <div>
      <ObsSubnav />
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 style={{ margin: "0.4rem 0" }}>Reliability leagues</h1>
        <span className="nyc-pill live" style={{ padding: "0.2rem 0.6rem" }}>Live</span>
      </div>

      <ArchiveBadge archive={d.archive} />

      <p className="nyc-note" style={{ borderLeftColor: "#d97706" }}>
        <strong>Exclusion criteria.</strong> {d.criteria.note} A route needs at least{" "}
        <strong>{d.criteria.min_observed_days} observed days</strong> and{" "}
        <strong>{d.criteria.min_headways} total observed headways</strong> to qualify.{" "}
        {d.criteria.qualifying_routes} routes qualify; {d.criteria.excluded_thin_routes} are excluded as
        thin/gap-dominated.
      </p>

      <div className="obs-leagues-grid">
        <section className="obs-panel">
          <PanelHead title="Most reliable" onDownload={() => downloadCsv(
            "nyc_leagues_most_reliable.csv",
            ["rank", "route_id", "short_name", "borough", "bunching_index", "median_headway_min", "observed_days"],
            d.most_reliable.map((r, i) => [i + 1, r.route_id, r.short_name, r.borough, r.bunching_index, r.median_headway_min, r.observed_days]),
          )} />
          <div className="obs-subtle">lowest bunching index (steadiest gaps)</div>
          <div className="nyc-table-wrap">
            <table className="nyc-table">
              <thead><tr><th>#</th><th>Route</th><th>Borough</th><th style={{ textAlign: "right" }}>Bunching</th><th style={{ textAlign: "right" }}>Median headway (min)</th><th style={{ textAlign: "right" }}>Days</th></tr></thead>
              <tbody>
                {d.most_reliable.map((r, i) => (
                  <tr key={r.route_id}>
                    <td>{i + 1}</td>
                    <td><Link to={href(r.route_id)}>{r.short_name}</Link>{r.sbs && !r.short_name.toUpperCase().includes("SBS") && <span className="obs-chip-sbs" style={{ marginLeft: 6 }}>SBS</span>}</td>
                    <td>{r.borough}</td>
                    <td style={{ textAlign: "right" }}>{r.bunching_index.toFixed(3)}</td>
                    <td style={{ textAlign: "right" }}>{r.median_headway_min ?? "—"}</td>
                    <td style={{ textAlign: "right" }}>{r.observed_days}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="obs-panel">
          <PanelHead title="Least reliable" onDownload={() => downloadCsv(
            "nyc_leagues_least_reliable.csv",
            ["rank", "route_id", "short_name", "borough", "bunching_index", "median_headway_min", "observed_days"],
            d.least_reliable.map((r, i) => [i + 1, r.route_id, r.short_name, r.borough, r.bunching_index, r.median_headway_min, r.observed_days]),
          )} />
          <div className="obs-subtle">highest bunching index (most uneven gaps)</div>
          <div className="nyc-table-wrap">
            <table className="nyc-table">
              <thead><tr><th>#</th><th>Route</th><th>Borough</th><th style={{ textAlign: "right" }}>Bunching</th><th style={{ textAlign: "right" }}>Median headway (min)</th><th style={{ textAlign: "right" }}>Days</th></tr></thead>
              <tbody>
                {d.least_reliable.map((r, i) => (
                  <tr key={r.route_id}>
                    <td>{i + 1}</td>
                    <td><Link to={href(r.route_id)}>{r.short_name}</Link>{r.sbs && !r.short_name.toUpperCase().includes("SBS") && <span className="obs-chip-sbs" style={{ marginLeft: 6 }}>SBS</span>}</td>
                    <td>{r.borough}</td>
                    <td style={{ textAlign: "right" }}>{r.bunching_index.toFixed(3)}</td>
                    <td style={{ textAlign: "right" }}>{r.median_headway_min ?? "—"}</td>
                    <td style={{ textAlign: "right" }}>{r.observed_days}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="obs-panel">
          <PanelHead title="Slowest corridors" onDownload={() => downloadCsv(
            "nyc_leagues_slowest_corridors.csv",
            ["rank", "route_id", "from_stop", "to_stop", "wt_speed_mph", "n_trips"],
            d.slowest_corridors.map((r, i) => [i + 1, r.route_id, r.from_stop, r.to_stop, r.wt_speed_mph, r.n_trips]),
          )} />
          <div className="obs-subtle">weighted peak speed, slowest 25 segments citywide</div>
          <div className="nyc-table-wrap">
            <table className="nyc-table">
              <thead><tr><th>#</th><th>Route</th><th>Segment</th><th style={{ textAlign: "right" }}>Speed (mph)</th><th style={{ textAlign: "right" }}>Trips</th></tr></thead>
              <tbody>
                {d.slowest_corridors.map((r, i) => (
                  <tr key={`${r.route_id}-${i}`}>
                    <td>{i + 1}</td>
                    <td><Link to={href(r.route_id)}>{r.route_id}</Link></td>
                    <td style={{ fontSize: "0.82rem" }}>{r.from_stop} → {r.to_stop}</td>
                    <td style={{ textAlign: "right" }}>{r.wt_speed_mph}</td>
                    <td style={{ textAlign: "right" }}>{r.n_trips?.toLocaleString() ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {d.most_improved_vs_schedule.length > 0 && (
          <section className="obs-panel">
            <PanelHead title="Most improved vs schedule" onDownload={() => downloadCsv(
              "nyc_leagues_most_improved.csv",
              ["rank", "route_id", "short_name", "borough", "early_avg_deviation_s", "late_avg_deviation_s", "improvement_s"],
              d.most_improved_vs_schedule.map((r, i) => [i + 1, r.route_id, r.short_name, r.borough, r.early_abs_dev_s, r.late_abs_dev_s, r.improvement_s]),
            )} />
            <div className="obs-subtle">largest drop in mean absolute deviation, first half vs second half of the archive</div>
            <div className="nyc-table-wrap">
              <table className="nyc-table">
                <thead><tr><th>#</th><th>Route</th><th>Borough</th><th style={{ textAlign: "right" }}>Early avg. deviation (s)</th><th style={{ textAlign: "right" }}>Late avg. deviation (s)</th><th style={{ textAlign: "right" }}>Improvement (s)</th></tr></thead>
                <tbody>
                  {d.most_improved_vs_schedule.map((r, i) => (
                    <tr key={r.route_id}>
                      <td>{i + 1}</td>
                      <td><Link to={href(r.route_id)}>{r.short_name}</Link></td>
                      <td>{r.borough}</td>
                      <td style={{ textAlign: "right" }}>{r.early_abs_dev_s}</td>
                      <td style={{ textAlign: "right" }}>{r.late_abs_dev_s}</td>
                      <td style={{ textAlign: "right", color: r.improvement_s > 0 ? "#1a7f37" : "#dc2626" }}>{r.improvement_s > 0 ? "+" : ""}{r.improvement_s}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      <p className="nyc-note" style={{ fontSize: "0.76rem" }}>
        Generated {new Date(d.generated_at).toLocaleString([], { timeZone: "America/New_York" })} in {d.elapsed_ms} ms.
      </p>
    </div>
  );
}
