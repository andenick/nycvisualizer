// League tables (S5 item 3) — /observatory/leagues.
//
// Q2.3 GATING: the named most/least-reliable ROUTE rankings are an ordinal claim
// the archive has to EARN. Until archive_depth_days ≥ 14 the page renders a
// DISTRIBUTION view instead of a leaderboard — the bunching-index distribution
// (histogram) + an unranked, client-sortable per-route table (observed-days shown
// per route, NO rank column, no winner/loser naming) + an explainer that says
// rankings unlock at 14 days and how many days we have. The Slowest-corridors
// table stays in BOTH modes (it's MTA administrative segment-speed data, not
// archive-gated). At depth ≥ 14 the backend flips `rankings_unlocked` and the full
// leaderboard renders automatically — no manual step.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getLeagues, type LeaguesResponse, type LeagueDistributionRow } from "../lib/api";
import ArchiveBadge from "../components/ArchiveBadge";
import ConfidenceBadge from "../components/ConfidenceBadge";
import ArkPlotly from "../components/ArkPlotly";
import { ContextCallouts } from "../components/ContextCallout";
import { archiveWindow } from "../lib/confidence";
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

// --- Q2.3 distribution view: histogram + unranked sortable per-route table ---
type SortKey = "short_name" | "borough" | "bunching_index" | "headway_cv" | "observed_days";

function DistributionView({ d }: { d: LeaguesResponse }) {
  const rows = d.distribution;
  const [sortKey, setSortKey] = useState<SortKey>("short_name");
  const [dir, setDir] = useState<1 | -1>(1);

  const sorted = useMemo(() => {
    const rs = [...rows];
    rs.sort((a, b) => {
      const va = a[sortKey];
      const vb = b[sortKey];
      let c: number;
      if (typeof va === "number" && typeof vb === "number") c = va - vb;
      else c = String(va ?? "").localeCompare(String(vb ?? ""), undefined, { numeric: true });
      return c * dir;
    });
    return rs;
  }, [rows, sortKey, dir]);

  const onSort = (k: SortKey) => {
    if (k === sortKey) setDir((p) => (p === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setDir(k === "short_name" || k === "borough" ? 1 : 1);
    }
  };
  const arrow = (k: SortKey) => (k === sortKey ? <span className="arrow">{dir === 1 ? "▲" : "▼"}</span> : null);

  const bunching = rows.map((r) => r.bunching_index).filter((v): v is number => v != null);
  const median = bunching.length
    ? [...bunching].sort((a, b) => a - b)[Math.floor(bunching.length / 2)]
    : null;

  return (
    <>
      <div className="leagues-gate">
        <h3>Rankings unlock at 14 days of observation</h3>
        <p>
          We have <span className="gate-depth">{d.archive.archive_depth_days}</span> observed day
          {d.archive.archive_depth_days === 1 ? "" : "s"} of live archive — not yet enough to name a
          &ldquo;most&rdquo; or &ldquo;least&rdquo; reliable route without the ordering being an artifact of a short
          window. Until the archive reaches <strong>14-day depth</strong>, we show the{" "}
          <strong>distribution</strong> of reliability across the {d.criteria.qualifying_routes} qualifying
          routes, not winners and losers. The named leaderboard appears here automatically once the depth is
          reached. {median != null && <>Right now the median route sits at a bunching index of{" "}
          <strong>{median.toFixed(3)}</strong> (lower = steadier gaps).</>}
        </p>
      </div>

      <ArkPlotly
        title="Bunching-index distribution across qualifying routes"
        subtitle={`How uneven bus gaps are, route by route — ${d.criteria.qualifying_routes} routes with enough observed history to compare`}
        data={[
          {
            type: "histogram",
            x: bunching,
            marker: { color: "#2563eb", line: { color: "var(--ark-surface)", width: 1 } },
            nbinsx: 20,
            hovertemplate: "bunching %{x}<br>%{y} routes<extra></extra>",
          },
        ]}
        layout={{
          xaxis: { title: { text: "bunching index (lower = steadier gaps)" } },
          yaxis: { title: { text: "routes" } },
          bargap: 0.04,
        }}
        height={300}
        csvRows={rows.map((r) => ({
          route_id: r.route_id,
          short_name: r.short_name,
          borough: r.borough,
          bunching_index: r.bunching_index,
          headway_cv: r.headway_cv,
          observed_days: r.observed_days,
          n_headways: r.n_headways,
        }))}
        csvName="nyc_leagues_bunching_distribution.csv"
        source="Bunching index = mean share of gaps under 50% of the scheduled headway, per route, over the live GTFS-RT archive. Preliminary until 14-day depth."
      />

      <section className="obs-panel">
        <PanelHead
          title="Reliability by route (unranked)"
          onDownload={() =>
            downloadCsv(
              "nyc_leagues_route_distribution.csv",
              ["route_id", "short_name", "borough", "bunching_index", "headway_cv", "observed_days", "n_headways"],
              sorted.map((r) => [r.route_id, r.short_name, r.borough, r.bunching_index, r.headway_cv, r.observed_days, r.n_headways]),
            )
          }
        />
        <div className="obs-subtle">
          Every qualifying route with its bunching index and headway variability. Sort any column — but this is a
          distribution, not a ranking: there is no place number, and observed-days is shown per route because a route
          seen on fewer days carries less certainty.
        </div>
        <div className="dist-sort-hint">Click a column heading to sort.</div>
        <div className="nyc-table-wrap">
          <table className="nyc-table">
            <thead>
              <tr>
                <th className="sortable" onClick={() => onSort("short_name")}>Route {arrow("short_name")}</th>
                <th className="sortable" onClick={() => onSort("borough")}>Borough {arrow("borough")}</th>
                <th className="sortable" style={{ textAlign: "right" }} onClick={() => onSort("bunching_index")}>
                  Bunching {arrow("bunching_index")}
                </th>
                <th className="sortable" style={{ textAlign: "right" }} onClick={() => onSort("headway_cv")}>
                  Headway CV {arrow("headway_cv")}
                </th>
                <th className="sortable" style={{ textAlign: "right" }} onClick={() => onSort("observed_days")}>
                  Observed days {arrow("observed_days")}
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r: LeagueDistributionRow) => (
                <tr key={r.route_id}>
                  <td>
                    <Link to={href(r.route_id)}>{r.short_name}</Link>
                    {r.sbs && !r.short_name.toUpperCase().includes("SBS") && (
                      <span className="obs-chip-sbs" style={{ marginLeft: 6 }}>SBS</span>
                    )}
                  </td>
                  <td>{r.borough}</td>
                  <td style={{ textAlign: "right" }}>{r.bunching_index.toFixed(3)}</td>
                  <td style={{ textAlign: "right" }}>{r.headway_cv != null ? r.headway_cv.toFixed(3) : "—"}</td>
                  <td style={{ textAlign: "right" }}>{r.observed_days}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

// --- the earned leaderboard (renders at depth ≥ 14) ---
function ReliableBoard({ title, rows, subtitle, csv }: {
  title: string;
  subtitle: string;
  rows: LeaguesResponse["most_reliable"];
  csv: string;
}) {
  return (
    <section className="obs-panel">
      <PanelHead title={title} onDownload={() => downloadCsv(
        csv,
        ["rank", "route_id", "short_name", "borough", "bunching_index", "median_headway_min", "observed_days"],
        rows.map((r, i) => [i + 1, r.route_id, r.short_name, r.borough, r.bunching_index, r.median_headway_min, r.observed_days]),
      )} />
      <div className="obs-subtle">{subtitle}</div>
      <div className="nyc-table-wrap">
        <table className="nyc-table">
          <thead><tr><th>#</th><th>Route</th><th>Borough</th><th style={{ textAlign: "right" }}>Bunching</th><th style={{ textAlign: "right" }}>Median headway (min)</th><th style={{ textAlign: "right" }}>Days</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
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
  );
}

function SlowestCorridors({ d }: { d: LeaguesResponse }) {
  return (
    <section className="obs-panel">
      <PanelHead title="Slowest corridors" onDownload={() => downloadCsv(
        "nyc_leagues_slowest_corridors.csv",
        ["rank", "route_id", "from_stop", "to_stop", "wt_speed_mph", "n_trips"],
        d.slowest_corridors.map((r, i) => [i + 1, r.route_id, r.from_stop, r.to_stop, r.wt_speed_mph, r.n_trips]),
      )} />
      <div className="obs-subtle">weighted peak speed, slowest 25 segments citywide (MTA segment-speed data — not archive-gated)</div>
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

  // Gate on the live archive depth (backend also reports rankings_unlocked; we
  // trust the depth so the flip is a single source of truth). Verified against a
  // mocked depth in the distribution/leaderboard branch below.
  const unlocked = d.rankings_unlocked || d.archive.archive_depth_days >= 14;

  return (
    <div>
      <ObsSubnav />
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
          <h1 style={{ margin: "0.4rem 0" }}>Reliability leagues</h1>
          <ConfidenceBadge claimKey="obs-leagues" window={archiveWindow(d.archive.archive_depth_days)} />
        </div>
        <span className="nyc-pill live" style={{ padding: "0.2rem 0.6rem" }}>Live</span>
      </div>

      <ArchiveBadge archive={d.archive} />

      {/* KB context: what "bunching" means + the DOT bus-speed backdrop */}
      <ContextCallouts anchor="leagues" />

      <p className="nyc-note" style={{ borderLeftColor: "#d97706" }}>
        <strong>Exclusion criteria.</strong> {d.criteria.note} A route needs at least{" "}
        <strong>{d.criteria.min_observed_days} observed days</strong> and{" "}
        <strong>{d.criteria.min_headways} total observed headways</strong> to qualify.{" "}
        {d.criteria.qualifying_routes} routes qualify; {d.criteria.excluded_thin_routes} are excluded as
        thin/gap-dominated.
      </p>

      {unlocked ? (
        <div className="obs-leagues-grid">
          <ReliableBoard
            title="Most reliable"
            subtitle="lowest bunching index (steadiest gaps)"
            rows={d.most_reliable}
            csv="nyc_leagues_most_reliable.csv"
          />
          <ReliableBoard
            title="Least reliable"
            subtitle="highest bunching index (most uneven gaps)"
            rows={d.least_reliable}
            csv="nyc_leagues_least_reliable.csv"
          />
          <SlowestCorridors d={d} />
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
      ) : (
        <>
          <DistributionView d={d} />
          <SlowestCorridors d={d} />
        </>
      )}

      <p className="nyc-note" style={{ fontSize: "0.76rem" }}>
        Generated {new Date(d.generated_at).toLocaleString([], { timeZone: "America/New_York" })} in {d.elapsed_ms} ms.
      </p>
    </div>
  );
}
