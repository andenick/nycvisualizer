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
          <h3 style={{ marginTop: 0 }}>Most reliable</h3>
          <div className="obs-subtle">lowest bunching index (steadiest gaps)</div>
          <div className="nyc-table-wrap">
            <table className="nyc-table">
              <thead><tr><th>#</th><th>Route</th><th>Borough</th><th style={{ textAlign: "right" }}>Bunching</th><th style={{ textAlign: "right" }}>Med. hw (min)</th><th style={{ textAlign: "right" }}>Days</th></tr></thead>
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
          <h3 style={{ marginTop: 0 }}>Least reliable</h3>
          <div className="obs-subtle">highest bunching index (most uneven gaps)</div>
          <div className="nyc-table-wrap">
            <table className="nyc-table">
              <thead><tr><th>#</th><th>Route</th><th>Borough</th><th style={{ textAlign: "right" }}>Bunching</th><th style={{ textAlign: "right" }}>Med. hw (min)</th><th style={{ textAlign: "right" }}>Days</th></tr></thead>
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
          <h3 style={{ marginTop: 0 }}>Slowest corridors</h3>
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
            <h3 style={{ marginTop: 0 }}>Most improved vs schedule</h3>
            <div className="obs-subtle">largest drop in mean |deviation|, first half vs second half of the archive</div>
            <div className="nyc-table-wrap">
              <table className="nyc-table">
                <thead><tr><th>#</th><th>Route</th><th>Borough</th><th style={{ textAlign: "right" }}>Early |dev| (s)</th><th style={{ textAlign: "right" }}>Late |dev| (s)</th><th style={{ textAlign: "right" }}>Improvement (s)</th></tr></thead>
                <tbody>
                  {d.most_improved_vs_schedule.map((r, i) => (
                    <tr key={r.route_id}>
                      <td>{i + 1}</td>
                      <td><Link to={href(r.route_id)}>{r.short_name}</Link></td>
                      <td>{r.borough}</td>
                      <td style={{ textAlign: "right" }}>{r.early_abs_dev_s}</td>
                      <td style={{ textAlign: "right" }}>{r.late_abs_dev_s}</td>
                      <td style={{ textAlign: "right", color: r.improvement_s > 0 ? "#16a34a" : "#dc2626" }}>{r.improvement_s > 0 ? "+" : ""}{r.improvement_s}</td>
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
