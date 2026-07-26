// The 30-route subway rollup table for /observatory/subway.
//
// WHAT THIS TABLE IS: observed gaps between STOPPED_AT arrival events, per route.
// WHAT IT IS NOT, and can never become: a deviation, an adherence figure, an "on time"
// share, or a bunching index. Realtime subway trip_id does not join GTFS static
// (0 of 8,040 exact matches), so there is NO schedule denominator for the subway — the
// derivation writes those columns NULL on 100% of cells and the API re-verifies it on
// every refresh. An observed gap needs no schedule; everything else on that list does.
// Nothing here is computed client-side: every number is rendered as handed over.
//
// TWO TRAPS THIS COMPONENT IS BUILT AROUND:
//   1. `median_dwell_s` is a CENSORED LOWER BOUND. Runs caught by a single 30 s poll
//      report 0 and are INCLUDED in the median. The dwell figure and its
//      `dwell_censored_share` therefore share ONE cell — the number is structurally
//      incapable of appearing without the share that qualifies it.
//   2. A suppressed route is NOT a blank and NOT a zero. Its raw counts still render and
//      the server's `suppressed_reason` is printed verbatim across the stat columns.
//
// NO SORTING CONTROLS, deliberately. The payload's own archive stamp says "no ordinal
// ranking of routes or stations is offered anywhere in this module" at this depth; a
// click-to-sort header would be that ranking, built in the browser, one section below
// the statement refusing it. Rows stay in the order the server sent them.

import { subwayColor, subwayLabel, subwayTextColor } from "../lib/subwayColors";

/** One row of /api/subwaystats/routes. Field names mirror the live payload. */
export interface SubwayStatsRouteRow {
  route_id: string;
  suppressed?: boolean;
  /** Server's own words for why the statistics are absent. Rendered verbatim. */
  suppressed_reason?: string;
  n_stations?: number | null;
  n_directions?: number | null;
  n_days_observed?: number | null;
  hours_observed?: number | null;
  n_cells?: number | null;
  n_headways?: number | null;
  n_arrival_events?: number | null;
  n_trips_observed?: number | null;
  feed?: string | null;
  median_headway_min?: number | null;
  headway_cv?: number | null;
  median_dwell_s?: number | null;
  dwell_censored_share?: number | null;
}

const NC = <span className="sws-nc">not captured</span>;

/** Integer count. A null count is `not captured`, never 0. */
export function count(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return NC;
  return <>{Math.round(v).toLocaleString()}</>;
}

/** Minutes, 1 dp — the precision a ~7-day archive earns. */
export function minutes(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return NC;
  return <>{v.toFixed(1)}</>;
}

/** Shares and coefficients of variation, 2 dp. */
export function ratio(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return NC;
  return <>{v.toFixed(2)}</>;
}

/** A dwell figure NEVER renders alone — the censored share travels in the same cell.
 *  Some routes report 0.0 s with a 0.99 censored share: the number is not wrong, but
 *  on its own it is misleading, so it is not possible to render it on its own here. */
export function Dwell({
  seconds,
  censored,
}: {
  seconds: number | null | undefined;
  censored: number | null | undefined;
}) {
  if (seconds == null || !Number.isFinite(seconds)) return NC;
  return (
    <>
      {seconds.toFixed(1)} s
      <br />
      <span className="sws-cens">
        {censored == null || !Number.isFinite(censored) ? (
          <>censored share {NC}</>
        ) : (
          <>{censored.toFixed(2)} censored</>
        )}
      </span>
    </>
  );
}

/** Official MTA line bullet. Used for LINE IDENTITY ONLY — never to encode a
 *  statistic, a rank or a quality. */
export function LineBullet({ route }: { route: string }) {
  return (
    <span
      className="sws-bullet"
      style={{ background: subwayColor(route), color: subwayTextColor(route) }}
      title={`Line ${subwayLabel(route)}`}
    >
      {subwayLabel(route)}
    </span>
  );
}

export default function SubwayRouteTable({ rows }: { rows: SubwayStatsRouteRow[] }) {
  return (
    <div className="nyc-table-wrap">
      <table className="nyc-table">
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col" style={{ textAlign: "right" }}>Stations</th>
            <th scope="col" style={{ textAlign: "right" }}>Arrivals observed</th>
            <th scope="col" style={{ textAlign: "right" }}>Observed gaps</th>
            <th scope="col" style={{ textAlign: "right" }}>Median observed gap (min)</th>
            <th scope="col" style={{ textAlign: "right" }}>Gap CV</th>
            <th scope="col" style={{ textAlign: "right" }}>
              Median dwell — lower bound
            </th>
            <th scope="col" style={{ textAlign: "right" }}>Hours observed</th>
            <th scope="col" style={{ textAlign: "right" }}>Days observed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.route_id}>
              <th scope="row" className="sws-rowhead">
                <LineBullet route={r.route_id} />
              </th>
              <td className="sws-num">{count(r.n_stations)}</td>
              <td className="sws-num">{count(r.n_arrival_events)}</td>
              {r.suppressed ? (
                // Not blanks, not zeros: the server's reason, verbatim, in place of the
                // four statistics it withheld. The raw counts either side still stand.
                <td className="sws-sup" colSpan={4}>
                  {r.suppressed_reason ?? "suppressed by the server, with no reason given"}
                </td>
              ) : (
                <>
                  <td className="sws-num">{count(r.n_headways)}</td>
                  <td className="sws-num">{minutes(r.median_headway_min)}</td>
                  <td className="sws-num">{ratio(r.headway_cv)}</td>
                  <td className="sws-num">
                    <Dwell seconds={r.median_dwell_s} censored={r.dwell_censored_share} />
                  </td>
                </>
              )}
              <td className="sws-num">{count(r.hours_observed)}</td>
              <td className="sws-num">{count(r.n_days_observed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
