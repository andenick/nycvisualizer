// BoroughRollups — /api/autostats/boroughs. Natural now that a route's HOME BOROUGH is
// the default colour encoding on the maps: the same seven groups, the same seven colours,
// as a table of what service actually looked like in each.
//
// COLOURS ARE IMPORTED, NEVER RESTATED. `GROUP_COLORS` / `boroughLabel` /
// `BOROUGH_GROUP_ORDER` come from lib/boroughs.ts, the single source of truth that
// site/tools/cvd_check.py reads and dichromat-tests (19/19). A local copy here would drift
// out from under that gate — which is exactly the defect the gate exists to catch.
//
// THE THREE SENTENCES AT THE BOTTOM ARE THE POINT. `borough_note`, `normalisation_note`
// and `rollup_statistic` are rendered verbatim: a route is grouped by its route-ID prefix
// (its home borough, whole length, no per-segment logic), route statistics are normalised
// per route x hour before being rolled up, and a borough number is "the typical route
// here" — not a passenger-weighted average. Without them this table is indefensible.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getBoroughRollups, type BoroughRow, type BoroughsResponse } from "../lib/api";
import { BOROUGH_GROUP_ORDER, GROUP_COLORS, GROUP_COLOR_FALLBACK, boroughLabel } from "../lib/boroughs";
import { AsOfStamp, fmtInt, fmtMin, fmtShare } from "./ArchiveCompletenessBanner";
import "../styles/autostats.css";

const DASH = "—";

function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}
function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
) {
  const blob = new Blob([toCsv(headers, rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const colorOf = (code: string) => GROUP_COLORS[code] ?? GROUP_COLOR_FALLBACK;

function orderRows(rows: BoroughRow[]): BoroughRow[] {
  const rank = (c: string) => {
    const i = BOROUGH_GROUP_ORDER.indexOf(c);
    return i < 0 ? BOROUGH_GROUP_ORDER.length : i;
  };
  return [...rows].sort((a, b) => rank(a.borough_code) - rank(b.borough_code));
}

const routeHref = (routeId: string) => `/observatory/${encodeURIComponent(routeId)}`;

export default function BoroughRollups({
  heading = "Bus service by borough",
}: {
  heading?: string;
}) {
  const [d, setD] = useState<BoroughsResponse | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    getBoroughRollups()
      .then(setD)
      .catch(() => setErr(true));
  }, []);

  if (err) return <div className="nyc-note">Borough rollups temporarily unavailable.</div>;
  if (!d) return null;

  const rows = orderRows(d.boroughs);
  // Q2.3 gate, applied consistently: below the depth that unlocks rankings we still show
  // WHICH routes carry the highest bunched-gap share in each borough — the value is real
  // and it is published per route — but we do not present them as an ORDER. They are
  // listed alphabetically and labelled as unranked, because an ordinal claim over ~6
  // equivalent complete days is an artifact of the window, not a finding.
  const ranked = d.archive?.rankings_unlocked === true;

  const headers = [
    "borough_code",
    "borough",
    "n_routes_total",
    "n_routes_observed",
    "n_routes_qualifying",
    "median_headway_min",
    "sched_median_headway_min",
    "median_headway_cv",
    "median_bunched_gap_share",
    "median_hours_observed_per_route",
  ];
  const csvRows = rows.map((r) => [
    r.borough_code,
    r.borough,
    r.n_routes_total,
    r.n_routes_observed,
    r.n_routes_qualifying,
    r.median_headway_min == null ? "" : r.median_headway_min.toFixed(1),
    r.sched_median_headway_min == null ? "" : r.sched_median_headway_min.toFixed(1),
    r.median_headway_cv == null ? "" : r.median_headway_cv.toFixed(2),
    r.median_bunched_gap_share == null ? "" : r.median_bunched_gap_share.toFixed(2),
    r.median_hours_observed_per_route == null
      ? ""
      : r.median_hours_observed_per_route.toFixed(1),
  ]);

  return (
    <div className="as-block">
      <div className="as-head">
        <h2>{heading}</h2>
        <span style={{ display: "flex", gap: "0.6rem", alignItems: "baseline" }}>
          <AsOfStamp label="derived" iso={d.generated_at} />
          <button
            type="button"
            className="nyc-dl-btn"
            aria-label="Download borough rollups as CSV"
            onClick={() => downloadCsv("bus_borough_rollups.csv", headers, csvRows)}
          >
            Download CSV
          </button>
        </span>
      </div>

      <div className="nyc-table-wrap">
        <table className="nyc-table">
          <thead>
            <tr>
              <th>Borough</th>
              <th style={{ textAlign: "right" }}>Routes in rollup</th>
              <th style={{ textAlign: "right" }}>Typical gap (min)</th>
              <th style={{ textAlign: "right" }}>Scheduled gap (min)</th>
              <th style={{ textAlign: "right" }}>Gap-to-gap CV</th>
              <th style={{ textAlign: "right" }}>Bunched-gap share</th>
              <th style={{ textAlign: "right" }}>Hours observed per route</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.borough_code}>
                <td>
                  <span className="as-boro-name" title={r.borough}>
                    <span className="as-sw" style={{ background: colorOf(r.borough_code) }} />
                    {boroughLabel(r.borough_code)}
                  </span>
                </td>
                <td style={{ textAlign: "right" }}>
                  {fmtInt(r.n_routes_qualifying)}{" "}
                  <span style={{ opacity: 0.6 }}>of {fmtInt(r.n_routes_total)}</span>
                </td>
                <td style={{ textAlign: "right" }}>{fmtMin(r.median_headway_min)}</td>
                <td style={{ textAlign: "right" }}>{fmtMin(r.sched_median_headway_min)}</td>
                <td style={{ textAlign: "right" }}>{fmtShare(r.median_headway_cv)}</td>
                <td style={{ textAlign: "right" }}>{fmtShare(r.median_bunched_gap_share)}</td>
                <td style={{ textAlign: "right" }}>
                  {fmtMin(r.median_hours_observed_per_route)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="as-caption">
        <b>Routes in rollup</b> is the number of routes that cleared the observation floor,
        out of every route the GTFS catalog files under that borough. An empty cell is{" "}
        {DASH} — no qualifying route, not a zero.{" "}
        {d.suppression?.rule ? <>{d.suppression.rule}</> : null}
      </p>

      <h3>
        {ranked
          ? "Highest bunched-gap share in each borough"
          : "Routes carrying the highest bunched-gap share in each borough (unranked)"}
      </h3>
      {!ranked && (
        <p className="as-caption">
          Listed alphabetically, not in order. Naming a worst route is an ordinal claim this
          archive has not earned yet — the same 14-observed-day gate that keeps the league
          tables unranked applies here.
        </p>
      )}
      <ul className="as-bunch-list">
        {rows
          .filter((r) => r.most_bunched_routes?.length)
          .map((r) => {
            const list = ranked
              ? r.most_bunched_routes
              : [...r.most_bunched_routes].sort((a, b) =>
                  a.short_name.localeCompare(b.short_name, undefined, { numeric: true }),
                );
            return (
              <li className="as-bunch-row" key={r.borough_code}>
                <span className="as-boro-name" title={r.borough}>
                  <span className="as-sw" style={{ background: colorOf(r.borough_code) }} />
                  {boroughLabel(r.borough_code)}
                </span>
                <span className="as-bunch-routes">
                  {list.map((x) => (
                    <Link
                      className="as-bunch-route"
                      key={x.route_id}
                      to={routeHref(x.route_id)}
                      title={`${x.n_headways.toLocaleString()} observed gaps over ${x.hours_observed} observed hours`}
                    >
                      {x.short_name}
                      <span>{fmtShare(x.bunched_gap_share)}</span>
                    </Link>
                  ))}
                </span>
              </li>
            );
          })}
      </ul>

      <p className="as-caption">
        <b>Mapping is complete:</b> {fmtInt(d.totals?.n_routes_assigned)} of{" "}
        {fmtInt(d.totals?.n_routes_in_catalog)} routes in the GTFS catalog are assigned to a
        home borough, with {fmtInt(d.totals?.n_routes_unassigned_fallback)} falling back to
        an unknown group{d.totals?.sums_to_catalog ? " — the rollup sums to the catalog" : ""}
        .
      </p>

      {/* The three sentences that make this table defensible — verbatim, in the server's
          own words, never paraphrased. */}
      <p className="as-caption">{d.borough_note}</p>
      <p className="as-caption">{d.normalisation_note}</p>
      <p className="as-caption">{d.rollup_statistic}</p>
    </div>
  );
}
