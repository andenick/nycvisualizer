// /observatory/subway — THE SUBWAY DERIVED-STATISTICS SURFACE.
//
// 1.6M subway arrival events -> ~274,000 derived cells over 30 routes, 518 parent
// stations and 10 archive day-folders. Derived 2026-07-25 by
// realtime/derive2/subway_headways.py, and rendered by nothing until this page: the
// subway has been the bus's poor cousin on this site since the bus Observatory shipped.
//
// It is also, as far as we can tell, genuinely new rather than a copy. The MTA's own
// live subway map is retired — new.mta.info/map/live 301s to a 404 and map.mta.info now
// serves static PDFs — so there is no public interactive MTA subway surface to imitate.
//
// ===========================================================================
// THE HONESTY LINE, AND IT GOVERNS EVERY DECISION ON THIS PAGE
// ===========================================================================
// There is NO subway schedule deviation and NO subway bunching here, in any form, under
// any label. Realtime subway `trip_id` does not join GTFS static `trip_id` (0 of 8,040
// exact matches; a suffix join reaches only ~74% of trips), so the subway has no
// schedule denominator at all. The derivation writes `sched_median_headway_s`,
// `headway_deviation_s`, `median_deviation_s`, `bunch_share_lt50_sched`,
// `bunch_share_lt50_obs`, `bunching_index` and `direction_id` as explicit NULLs on 100%
// of cells, and /completeness re-verifies that on every refresh and publishes the
// per-column non-null counts.
//
// Verified against the live derivation before this page was written
// (/api/subwaystats/completeness -> withheld_column_verification):
//     cells_total 274,447 — sched_median_headway_s 0, headway_deviation_s 0,
//     median_deviation_s 0, bunch_share_lt50_sched 0, bunch_share_lt50_obs 0,
//     bunching_index 0, direction_id 0.  all_columns_null: true, leaked_columns: null.
// The same check is re-rendered on this page at runtime, so a reader can audit it
// without taking our word for it, and a producer change would be visible immediately.
//
// AN OBSERVED GAP NEEDS NO SCHEDULE. A deviation or a bunching index does. This page
// therefore never writes "on time", "delay", "adherence", "punctual" or "bunching"
// about the subway, and computes none of them client-side. What it renders is the gap
// between consecutive STOPPED_AT arrival events, which is a measurement, not a verdict.
//
// TWO TRAPS THE BACKEND FOUND, HONOURED HERE:
//   1. `median_dwell_s` is a CENSORED LOWER BOUND (single-poll runs read 0 and are kept
//      in the median). No dwell figure renders without its `dwell_censored_share` — see
//      <Dwell> in SubwayRouteTable, which puts both in one cell so they cannot separate.
//   2. Run times are "observed origin to LAST OBSERVED STOP", not scheduled terminal to
//      terminal. `terminal_station` is the last station we saw, not a station known to
//      be a terminal. The API's own wording is rendered verbatim and not upgraded.
//
// The plan's claim that the subway "survived the 2026-07-21 disk-guard incident intact"
// is FALSE and is not rendered anywhere. The payload's evidence-based
// `disk_guard_incident.verdict` is rendered instead: the suspension hit all eight subway
// feeds identically.
//
// COST: four small server-assembled payloads on mount (routes / completeness / runs /
// profile), one more when a route or station is picked. Every aggregate is computed
// server-side; this page renders tables it was handed and assembles nothing.

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  getStations,
  getSubwayCompleteness,
  getSubwayProfile,
  getSubwayRoutes,
  getSubwayRuns,
  getSubwayStationStats,
  subwayStatsExportUrl,
  type StationInfo,
} from "../lib/api";
import ArkPlotly from "../components/ArkPlotly";
import SubwayRouteTable, {
  count,
  Dwell,
  LineBullet,
  minutes,
  ratio,
  type SubwayStatsRouteRow,
} from "../components/SubwayRouteTable";
import "../styles/subwaystats.css";

// ---------------------------------------------------------------------------
// Payload shapes, mirroring the live /api/subwaystats/* responses.
// ---------------------------------------------------------------------------
interface SwArchive {
  producer?: string;
  archive_day_partitions?: number;
  archive_depth_days?: number;
  archive_first_day?: string;
  archive_last_day?: string;
  preliminary?: boolean;
  preliminary_note?: string;
  arrival_method?: string;
  arrival_method_note?: string;
}
interface SwCoverage {
  equivalent_complete_days_subway?: number;
  equivalent_complete_days_bus_same_rule?: number;
  equivalent_complete_days_all_eight_feeds_worst?: number;
  complete_days?: number;
  complete_day_list?: string[];
  complete_day_rule?: string;
}
interface SwSuppression {
  rule?: string;
  [k: string]: unknown;
}
interface SwRoutesPayload {
  generated_at?: string;
  rollup_statistic?: string;
  dwell_note?: string;
  direction_note?: string;
  suppression?: SwSuppression;
  withheld_here?: string[];
  withheld_reason?: string;
  archive?: SwArchive;
  coverage?: SwCoverage;
  routes: SubwayStatsRouteRow[];
  n_routes?: number;
  n_routes_published?: number;
  n_routes_suppressed?: number;
  totals?: {
    n_stations_distinct?: number;
    n_headways?: number;
    n_arrival_events?: number;
    note?: string;
  };
}
interface SwProfileHour {
  local_hour: number;
  suppressed: boolean;
  suppressed_reason?: string;
  n_headways: number;
  n_cells: number;
  n_days?: number;
  n_arrivals?: number;
  median_headway_min: number | null;
  headway_cv: number | null;
  median_dwell_s: number | null;
  dwell_censored_share: number | null;
  min_hour_poll_coverage?: number | null;
}
interface SwProfilePayload {
  generated_at?: string;
  route: string | null;
  station: string | null;
  direction: string | null;
  note?: string;
  dwell_note?: string;
  direction_note?: string;
  statistic_note?: string;
  suppression?: SwSuppression;
  withheld_reason?: string;
  hours: SwProfileHour[];
  hours_published?: number;
  hours_suppressed?: number;
  n_headways_total?: number;
  n_arrivals_total?: number;
  archive?: SwArchive;
  no_data?: boolean;
  no_data_reason?: string;
}
interface SwRunRow {
  route_id: string;
  suppressed?: boolean;
  suppressed_reason?: string;
  n_trips_in_file?: number;
  n_qualifying_runs?: number;
  qualifying_share?: number | null;
  n_saw_origin?: number;
  n_clipped_at_window_start?: number;
  n_distinct_trips?: number;
  n_days_observed?: number;
  n_directions?: number;
  median_run_time_min?: number | null;
  p25_run_time_min?: number | null;
  p75_run_time_min?: number | null;
  median_stop_sequence_span?: number | null;
}
interface SwRunsPayload {
  generated_at?: string;
  definition?: string;
  honesty_note?: string;
  shuttle_guard_note?: string;
  suppression?: SwSuppression;
  routes: SwRunRow[];
  n_routes?: number;
  n_routes_published?: number;
  n_routes_suppressed?: number;
  guard_verification?: {
    zero_length_flagged_runs?: number;
    same_endpoint_flagged_runs?: number;
    single_station_flagged_runs?: number;
    flagged_runs_total?: number;
    rows_total?: number;
    guard_holds?: boolean;
    rule?: string;
  };
  archive?: SwArchive;
}
interface SwWithheldCheck {
  checked?: boolean;
  checked_at?: string;
  cells_total?: number;
  non_null_count_by_column?: Record<string, number>;
  all_columns_null?: boolean;
  leaked_columns?: string[] | null;
  sched_basis_values?: { sched_basis?: string; bunching_basis?: string; cells?: number }[];
  rule?: string;
}
interface SwNotSupported {
  metric: string;
  status: string;
  reason: string;
  columns_withheld?: string[];
  unblocks_at?: string;
}
interface SwDiskGuard {
  day?: string;
  present?: boolean;
  subway_equivalent_complete_days?: number;
  bus_equivalent_complete_days?: number;
  subway_excluded_utc_hours?: number[];
  subway_feeds_with_missing_hours?: string[];
  verdict?: string;
}
interface SwCompDay {
  archive_day_utc: string;
  complete?: boolean;
  n_feeds_reported?: number;
  equivalent_complete_days_subway_gtfs?: number;
  equivalent_complete_days_worst_feed?: number;
  excluded_local_hours_subway_gtfs?: number[];
  arrival_events_in_day?: number;
  headway_cells_in_day?: number;
}
interface SwCompletenessPayload {
  generated_at?: string;
  headline?: string;
  equivalent_complete_days?: number;
  equivalent_complete_days_method?: string;
  equivalent_complete_days_bus_same_rule?: number;
  comparison_caveat?: string;
  equivalent_complete_days_all_eight_feeds_worst?: number;
  equivalent_complete_days_all_eight_feeds_method?: string;
  complete_days?: number;
  complete_day_list?: string[];
  complete_day_rule?: string;
  feeds_derived_from?: string[];
  usable_hours_rule?: string;
  status_vocabulary?: Record<string, string>;
  exclude_from_stats_note?: string;
  days?: SwCompDay[];
  disk_guard_incident?: SwDiskGuard;
  not_derived_recorded_by_producer?: Record<string, string>;
  withheld_column_verification?: SwWithheldCheck;
  not_supported?: SwNotSupported[];
  archive?: SwArchive;
  coverage?: SwCoverage;
}
interface SwStationRouteRow {
  route_id: string;
  direction: string | null;
  n_headways?: number;
  n_arrivals_in_published_cells?: number;
  hours_observed?: number;
  n_days_observed?: number;
  suppressed?: boolean;
  suppressed_reason?: string;
  median_headway_min?: number | null;
  headway_cv?: number | null;
  median_dwell_s?: number | null;
  dwell_censored_share?: number | null;
}
interface SwStationPayload {
  found?: boolean;
  station_id?: string;
  station_id_note?: string;
  station_name?: string | null;
  /** Server's own NOT CAPTURED sentence when the id has no name. Rendered verbatim. */
  station_name_absent_reason?: string | null;
  routes_serving?: string[];
  directions_observed?: string[];
  feeds?: string[];
  n_cells_total?: number;
  n_headways_total?: number;
  n_arrivals_in_cells_total?: number;
  n_days_observed?: number;
  by_route?: SwStationRouteRow[];
  suppression?: SwSuppression;
  arrivals?: {
    available?: boolean;
    reason?: string;
    n_arrival_events?: number;
    n_trips_observed?: number;
    n_stale_clock_excluded_from_headways?: number;
    stale_clock_share?: number | null;
    n_in_known_poller_gap?: number;
    n_dwell_censored?: number;
    dwell_censored_share?: number | null;
    median_dwell_s_uncensored_only?: number | null;
    median_dwell_s_uncensored_note?: string;
    parent_fold_source?: string;
    parent_fold_source_note?: string;
    first_local_date?: string;
    last_local_date?: string;
  };
}

// ---------------------------------------------------------------------------
// The honest "as of" stamp — the OpsWall pattern, unchanged in behaviour: when the
// payload is stale the LABEL IS REPLACED by "STALE — N old". It is never decorated,
// so a fresh-sounding word can never sit on top of an old number.
// ---------------------------------------------------------------------------
function fmtClock(epoch: number | null | undefined): string {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
function fmtAge(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "unknown age";
  const min = seconds / 60;
  if (min < 90) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 36) return `${Math.round(h)} h`;
  return `${(h / 24).toFixed(1)} days`;
}
function Stamp({
  label,
  epoch,
  stale,
  ageS,
}: {
  label: string;
  epoch: number | null | undefined;
  stale?: boolean;
  ageS?: number | null;
}) {
  return (
    <span className={"sws-stamp" + (stale ? " stale" : "")}>
      <span className="dot" />
      {stale ? `STALE — ${fmtAge(ageS)} old` : label} {fmtClock(epoch)}
    </span>
  );
}

/** ISO-8601 -> epoch seconds, or null. */
function epochOf(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t / 1000 : null;
}

/** 2 dp for shares / equivalent-day fractions. The archive is ~7 days deep; a third
 *  decimal would claim a precision the evidence does not carry. */
function two(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : v.toFixed(2);
}

/** CSV / XLSX / Parquet. No JSON — the estate's download standard, and the server
 *  carries provenance INSIDE each file rather than in a sidecar. */
function DownloadRow({
  path,
  params,
  label,
}: {
  path: "profile" | "routes" | "runs";
  params?: Record<string, string | number | undefined>;
  label: string;
}) {
  return (
    <div className="sws-dl">
      <span>{label}</span>
      {(["csv", "xlsx", "parquet"] as const).map((f) => (
        <a
          key={f}
          className="nyc-dl-btn"
          href={subwayStatsExportUrl(path, f, params)}
          download
        >
          {f.toUpperCase()}
        </a>
      ))}
    </div>
  );
}

/** A server sentence, rendered verbatim. Never paraphrased, never trimmed. */
function Verbatim({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return <p className="nyc-note">{children}</p>;
}

const HOURS_24 = Array.from({ length: 24 }, (_, i) => i);

export default function SubwayStatsPage() {
  const [routes, setRoutes] = useState<SwRoutesPayload | null>(null);
  const [comp, setComp] = useState<SwCompletenessPayload | null>(null);
  const [runs, setRuns] = useState<SwRunsPayload | null>(null);
  const [profile, setProfile] = useState<SwProfilePayload | null>(null);
  const [station, setStation] = useState<SwStationPayload | null>(null);
  const [catalog, setCatalog] = useState<StationInfo[]>([]);

  const [route, setRoute] = useState<string>("");
  const [direction, setDirection] = useState<string>("");
  const [stationId, setStationId] = useState<string>("");

  const [errRoutes, setErrRoutes] = useState(false);
  const [errComp, setErrComp] = useState(false);
  const [errRuns, setErrRuns] = useState(false);
  const [errProfile, setErrProfile] = useState(false);
  const [errStation, setErrStation] = useState(false);
  // Re-render once a minute so the "as of" stamp ages truthfully while the page is open.
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    getSubwayRoutes()
      .then((d) => setRoutes(d as unknown as SwRoutesPayload))
      .catch(() => setErrRoutes(true));
    getSubwayCompleteness()
      .then((d) => setComp(d as unknown as SwCompletenessPayload))
      .catch(() => setErrComp(true));
    getSubwayRuns()
      .then((d) => setRuns(d as unknown as SwRunsPayload))
      .catch(() => setErrRuns(true));
    // Station labels come from the GTFS static catalog. The derivation observed more
    // parent stations than the catalog names (see the picker note) — a failure here
    // costs the picker, never the statistics.
    getStations()
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, []);

  // First published route becomes the default selection once the rollup lands.
  useEffect(() => {
    if (route || !routes?.routes?.length) return;
    const first = routes.routes.find((r) => !r.suppressed) ?? routes.routes[0];
    if (first) setRoute(first.route_id);
  }, [routes, route]);

  useEffect(() => {
    if (!route) return;
    setErrProfile(false);
    setProfile(null);
    getSubwayProfile({
      route,
      direction: direction || undefined,
      station: stationId || undefined,
    })
      .then((d) => setProfile(d as unknown as SwProfilePayload))
      .catch(() => setErrProfile(true));
  }, [route, direction, stationId]);

  useEffect(() => {
    if (!stationId) {
      setStation(null);
      setErrStation(false);
      return;
    }
    setErrStation(false);
    setStation(null);
    getSubwayStationStats(stationId)
      .then((d) => setStation(d as unknown as SwStationPayload))
      .catch(() => setErrStation(true));
  }, [stationId]);

  const stationOptions = useMemo(() => {
    const forRoute = route
      ? catalog.filter((s) => (s.routes ?? []).includes(route))
      : catalog;
    return [...forRoute].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  }, [catalog, route]);

  // If the picked station does not serve the newly picked route, drop it rather than
  // silently querying a route/station pair with no cells.
  useEffect(() => {
    if (!stationId || !route || !catalog.length) return;
    const s = catalog.find((c) => c.id === stationId);
    if (s && !(s.routes ?? []).includes(route)) setStationId("");
  }, [route, stationId, catalog]);

  const archive = routes?.archive ?? comp?.archive;
  const coverage = routes?.coverage ?? comp?.coverage;
  const genEpoch = epochOf(routes?.generated_at ?? comp?.generated_at);
  const ageS = genEpoch == null ? null : Date.now() / 1000 - genEpoch;
  const check = comp?.withheld_column_verification;
  const leaked = check?.all_columns_null === false;

  return (
    <div>
      <h1 style={{ margin: "0.6rem 0 0.2rem" }}>Subway: the gaps we observed</h1>

      <div className="sws-stamps">
        <Stamp
          label="derived"
          epoch={genEpoch}
          stale={ageS != null && ageS > 3600}
          ageS={ageS}
        />
        {archive?.preliminary && <span className="sws-prelim">Preliminary</span>}
        {archive?.archive_first_day && (
          <span>
            archive {archive.archive_first_day} → {archive.archive_last_day}
            {archive.archive_day_partitions != null &&
              ` · ${archive.archive_day_partitions} day-folders`}
          </span>
        )}
        {coverage?.equivalent_complete_days_subway != null && (
          <span>
            {two(coverage.equivalent_complete_days_subway)} equivalent complete days
          </span>
        )}
      </div>

      <p className="lede" style={{ maxWidth: "72ch" }}>
        Every figure on this page is the <strong>observed gap</strong> between one train
        arriving at a platform and the next one — measured from the arrival events in our
        own archive, at 30-second polling. Nothing here is compared against a timetable,
        because for the subway we do not have one that joins: the realtime feed&rsquo;s
        train ids and the published schedule&rsquo;s train ids do not match, so there is
        no denominator to divide by. That is a real limit, not a caveat we are burying —
        it is the second section of this page. For the bus network, where the schedule
        does join, the <Link to="/observatory">Bus Observatory</Link> answers the
        on-schedule question directly.
      </p>
      {archive?.preliminary_note && <Verbatim>{archive.preliminary_note}</Verbatim>}
      {archive?.arrival_method_note && <Verbatim>{archive.arrival_method_note}</Verbatim>}

      {/* =====================================================================
          WHAT IS NOT COMPUTED — deliberately the FIRST thing after the lede.
          On a page where every number is an observation with no schedule behind
          it, showing what we refuse to compute is not a footnote, it is the
          point. The verification table below is the machine-checked proof.
          ===================================================================== */}
      <section className="nyc-section">
        <h2>What is not computed here — and why</h2>

        <div className={"sws-callout" + (leaked ? " alarm" : "")}>
          <h3>No subway schedule denominator exists</h3>
          <p>{routes?.withheld_reason ?? profile?.withheld_reason ?? ""}</p>
          {routes?.withheld_here?.length ? (
            <p className="sws-cols">
              columns withheld: {routes.withheld_here.join(", ")}
            </p>
          ) : null}
          {leaked && (
            <p>
              <strong>
                The producer has changed: one or more of those columns is no longer null
                {check?.leaked_columns?.length
                  ? ` (${check.leaked_columns.join(", ")})`
                  : ""}
                . This page still does not render them, and will not until the change is
                reviewed.
              </strong>
            </p>
          )}
        </div>

        {errComp && (
          <div className="nyc-note">
            The completeness payload is unavailable, so the withheld-column verification
            and the archive depth below cannot be shown. Nothing on this page substitutes
            for them.
          </div>
        )}

        {check && (
          <>
            <h3 style={{ fontSize: "1rem", marginBottom: "0.2rem" }}>
              Withheld-column verification
            </h3>
            <p style={{ fontSize: "0.85rem", opacity: 0.85, margin: "0 0 0.3rem" }}>
              Re-run by the API on every refresh over all{" "}
              {check.cells_total?.toLocaleString() ?? "—"} cells
              {check.checked_at ? ` (checked ${check.checked_at})` : ""}. Every count must
              be zero.
            </p>
            <div className="nyc-table-wrap">
              <table className="nyc-table">
                <thead>
                  <tr>
                    <th scope="col">Column</th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Non-null cells
                    </th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Share of {check.cells_total?.toLocaleString() ?? "—"}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(check.non_null_count_by_column ?? {}).map(([col, n]) => (
                    <tr key={col}>
                      <th scope="row" className="sws-cols">
                        {col}
                      </th>
                      <td className="sws-num">{count(n)}</td>
                      <td className="sws-num">
                        {check.cells_total ? two((n / check.cells_total) * 100) + "%" : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {check.sched_basis_values?.length ? (
              <p style={{ fontSize: "0.82rem", opacity: 0.85 }}>
                {check.sched_basis_values.map((b, i) => (
                  <span key={i} className="sws-cols">
                    sched_basis = {b.sched_basis} · bunching_basis = {b.bunching_basis} ·{" "}
                    {b.cells?.toLocaleString()} cells
                  </span>
                ))}
              </p>
            ) : null}
            {check.rule && <Verbatim>{check.rule}</Verbatim>}
          </>
        )}

        {comp?.not_supported?.length ? (
          <>
            <h3 style={{ fontSize: "1rem", marginTop: "1.2rem" }}>
              Metrics this platform will not publish for the subway
            </h3>
            <div className="sws-grid">
              {comp.not_supported.map((ns) => (
                <div className="sws-card" key={ns.metric}>
                  <span className="sws-status">{ns.status}</span>
                  <h4>{ns.metric}</h4>
                  <p>{ns.reason}</p>
                  {ns.columns_withheld?.length ? (
                    <p className="sws-cols">withheld: {ns.columns_withheld.join(", ")}</p>
                  ) : null}
                  {ns.unblocks_at && (
                    <p>
                      <em>Unblocks at:</em> {ns.unblocks_at}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : null}

        {comp?.not_derived_recorded_by_producer && (
          <>
            <h3 style={{ fontSize: "1rem" }}>Recorded as not derived by the producer</h3>
            <dl className="sws-kv">
              {Object.entries(comp.not_derived_recorded_by_producer).map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt className="sws-cols">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </section>

      {/* =====================================================================
          THE ROUTE TABLE — 30 lines
          ===================================================================== */}
      <section className="nyc-section">
        <h2>
          Every line, as observed{" "}
          {routes?.n_routes != null && (
            <span style={{ opacity: 0.6, fontWeight: 400 }}>({routes.n_routes})</span>
          )}
        </h2>
        {errRoutes && <div className="nyc-note">The route rollup is unavailable.</div>}
        {!routes && !errRoutes && <p className="nyc-note">Loading the route rollup…</p>}
        {routes && (
          <>
            <p style={{ fontSize: "0.9rem", maxWidth: "74ch" }}>
              {routes.n_routes_published} of {routes.n_routes} lines clear the publish
              floor; {routes.n_routes_suppressed} do not and are shown with the
              server&rsquo;s reason in place of the statistics it withheld —{" "}
              <strong>never as a blank or a zero</strong>. Line colours are the
              MTA&rsquo;s own and mark line identity only; they encode nothing about the
              numbers.
            </p>
            <SubwayRouteTable rows={routes.routes} />
            <DownloadRow path="routes" label="Download this table:" />
            {routes.totals && (
              <dl className="sws-kv">
                <dt>Distinct parent stations</dt>
                <dd>{routes.totals.n_stations_distinct?.toLocaleString() ?? "—"}</dd>
                <dt>Observed gaps</dt>
                <dd>{routes.totals.n_headways?.toLocaleString() ?? "—"}</dd>
                <dt>Arrival events</dt>
                <dd>{routes.totals.n_arrival_events?.toLocaleString() ?? "—"}</dd>
              </dl>
            )}
            {routes.totals?.note && <Verbatim>{routes.totals.note}</Verbatim>}
            {routes.rollup_statistic && <Verbatim>{routes.rollup_statistic}</Verbatim>}
            {routes.suppression?.rule && <Verbatim>{routes.suppression.rule}</Verbatim>}
            {routes.dwell_note && <Verbatim>{routes.dwell_note}</Verbatim>}
            {routes.direction_note && <Verbatim>{routes.direction_note}</Verbatim>}
          </>
        )}
      </section>

      {/* =====================================================================
          TIME-OF-DAY PROFILE
          ===================================================================== */}
      <section className="nyc-section">
        <h2>Across the day</h2>

        <div className="sws-controls">
          <label className="sws-field">
            <span>Line</span>
            <select value={route} onChange={(e) => setRoute(e.target.value)}>
              {(routes?.routes ?? []).map((r) => (
                <option key={r.route_id} value={r.route_id}>
                  {r.route_id}
                  {r.suppressed ? " (below publish floor)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="sws-field">
            <span>Direction</span>
            <select value={direction} onChange={(e) => setDirection(e.target.value)}>
              <option value="">Both, pooled</option>
              <option value="N">N</option>
              <option value="S">S</option>
            </select>
          </label>
          <label className="sws-field">
            <span>Station (optional)</span>
            <select value={stationId} onChange={(e) => setStationId(e.target.value)}>
              <option value="">All stations on this line</option>
              {stationOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.id})
                </option>
              ))}
            </select>
          </label>
        </div>
        <p style={{ fontSize: "0.78rem", opacity: 0.72, maxWidth: "74ch" }}>
          The station list is built from the GTFS static station catalog ({catalog.length}{" "}
          stations). The derivation observed{" "}
          {routes?.totals?.n_stations_distinct ?? "—"} distinct parent stations, so a
          handful it saw are not named by that catalog and are not in this list; the API
          returns them with the station label marked <em>not captured</em>.
        </p>

        {errProfile && (
          <div className="nyc-note">The time-of-day profile is unavailable for this
            selection.</div>
        )}
        {!profile && !errProfile && route && (
          <p className="nyc-note">Loading the profile for {route}…</p>
        )}
        {profile?.no_data && <Verbatim>{profile.no_data_reason}</Verbatim>}

        {profile && !profile.no_data && (
          <>
            <ArkPlotly
              title={`Typical observed gap between trains — line ${profile.route ?? route}`}
              // Kept SHORT on purpose: ArkPlotly lays the header out as a flex row and a
              // long subtitle takes the whole width, wrapping the contract-mandated
              // top-right Download CSV button onto its own line. The detail lives in the
              // caption below the chart instead, where length costs nothing.
              subtitle={
                `${profile.direction ?? "both directions"} · ` +
                `${profile.station ? "one station" : "all stations"}`
              }
              data={[
                {
                  type: "bar",
                  name: "median observed gap (min)",
                  x: profile.hours.map((h) => h.local_hour),
                  y: profile.hours.map((h) =>
                    h.suppressed ? null : h.median_headway_min,
                  ),
                  marker: { color: "#2563eb" },
                },
              ]}
              layout={{
                xaxis: {
                  title: { text: "local hour" },
                  dtick: 2,
                  range: [-0.6, 23.6],
                },
                yaxis: { title: { text: "minutes" }, rangemode: "tozero" },
              }}
              csvRows={profile.hours.map((h) => ({
                route_id: profile.route,
                station_id: profile.station,
                direction: profile.direction,
                local_hour: h.local_hour,
                suppressed: h.suppressed ? "yes" : "no",
                suppressed_reason: h.suppressed_reason ?? "",
                median_observed_gap_min: h.suppressed ? null : h.median_headway_min,
                gap_cv: h.suppressed ? null : h.headway_cv,
                median_dwell_s_lower_bound: h.suppressed ? null : h.median_dwell_s,
                dwell_censored_share: h.suppressed ? null : h.dwell_censored_share,
                n_observed_gaps: h.n_headways,
                n_cells: h.n_cells,
                n_days: h.n_days ?? null,
              }))}
              csvName={`subway_observed_gap_by_hour_${profile.route ?? "all"}.csv`}
              height={340}
              source={profile.statistic_note}
            />
            <p style={{ fontSize: "0.82rem", opacity: 0.85, maxWidth: "74ch" }}>
              Line {profile.route ?? route}, {profile.hours_published ?? 0} of 24 local
              hours published and {profile.hours_suppressed ?? 0} suppressed below the
              publish floor (the suppressed hours are listed underneath with the
              server&rsquo;s reason for each). Every bar is the gap we observed between one
              train and the next — <strong>not</strong> a comparison against a timetable,
              because for the subway there is none to compare against.
            </p>

            <div className="nyc-table-wrap">
              <table className="nyc-table">
                <thead>
                  <tr>
                    <th scope="col">Local hour</th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Median observed gap (min)
                    </th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Gap CV
                    </th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Median dwell — lower bound
                    </th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Observed gaps
                    </th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Cells
                    </th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Days
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {HOURS_24.map((hh) => {
                    const h = profile.hours.find((x) => x.local_hour === hh);
                    if (!h) return null;
                    return (
                      <tr key={hh}>
                        <th scope="row" className="sws-rowhead">
                          {String(hh).padStart(2, "0")}:00
                        </th>
                        {h.suppressed ? (
                          <td className="sws-sup" colSpan={3}>
                            {h.suppressed_reason ??
                              "suppressed by the server, with no reason given"}
                          </td>
                        ) : (
                          <>
                            <td className="sws-num">{minutes(h.median_headway_min)}</td>
                            <td className="sws-num">{ratio(h.headway_cv)}</td>
                            <td className="sws-num">
                              <Dwell
                                seconds={h.median_dwell_s}
                                censored={h.dwell_censored_share}
                              />
                            </td>
                          </>
                        )}
                        <td className="sws-num">{count(h.n_headways)}</td>
                        <td className="sws-num">{count(h.n_cells)}</td>
                        <td className="sws-num">{count(h.n_days)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <DownloadRow
              path="profile"
              label="Download this profile:"
              params={{
                route: profile.route ?? undefined,
                direction: profile.direction ?? undefined,
                station: profile.station ?? undefined,
              }}
            />
            {profile.note && <Verbatim>{profile.note}</Verbatim>}
            {profile.direction_note && <Verbatim>{profile.direction_note}</Verbatim>}
            {profile.suppression?.rule && <Verbatim>{profile.suppression.rule}</Verbatim>}
          </>
        )}
      </section>

      {/* =====================================================================
          STATION DETAIL (only when a station is picked)
          ===================================================================== */}
      {stationId && (
        <section className="nyc-section">
          <h2>Station detail</h2>
          {errStation && (
            <div className="nyc-note">
              No subway headway cells for parent station id <code>{stationId}</code> in
              this archive window (the API answered 404). Platform-level ids are folded
              into their parent, so an id with a trailing N or S will not resolve here.
            </div>
          )}
          {!station && !errStation && <p className="nyc-note">Loading station…</p>}
          {station?.found && (
            <>
              <h3 style={{ marginBottom: "0.1rem" }}>
                {station.station_name ?? <span className="sws-nc">not captured</span>}{" "}
                <span style={{ opacity: 0.55, fontWeight: 400 }}>({station.station_id})</span>
              </h3>
              {/* The server's own NOT CAPTURED sentence, verbatim. The row is never
                  dropped for want of a label — ~0.6% of cells carry no station name. */}
              {station.station_name_absent_reason && (
                <Verbatim>{station.station_name_absent_reason}</Verbatim>
              )}
              <dl className="sws-kv">
                <dt>Lines serving</dt>
                <dd>{station.routes_serving?.join(", ") || "—"}</dd>
                <dt>Directions observed</dt>
                <dd>{station.directions_observed?.join(", ") || "—"}</dd>
                <dt>Feeds</dt>
                <dd className="sws-cols">{station.feeds?.join(", ") || "—"}</dd>
                <dt>Observed gaps</dt>
                <dd>{station.n_headways_total?.toLocaleString() ?? "—"}</dd>
                <dt>Days observed</dt>
                <dd>{station.n_days_observed ?? "—"}</dd>
              </dl>

              <div className="nyc-table-wrap">
                <table className="nyc-table">
                  <thead>
                    <tr>
                      <th scope="col">Line</th>
                      <th scope="col">Direction</th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Median observed gap (min)
                      </th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Gap CV
                      </th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Median dwell — lower bound
                      </th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Observed gaps
                      </th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Hours
                      </th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Days
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(station.by_route ?? []).map((r, i) => (
                      <tr key={r.route_id + "-" + (r.direction ?? "") + "-" + i}>
                        <th scope="row" className="sws-rowhead">
                          <LineBullet route={r.route_id} />
                        </th>
                        <td>{r.direction ?? <span className="sws-nc">not captured</span>}</td>
                        {r.suppressed ? (
                          <td className="sws-sup" colSpan={3}>
                            {r.suppressed_reason ??
                              "suppressed by the server, with no reason given"}
                          </td>
                        ) : (
                          <>
                            <td className="sws-num">{minutes(r.median_headway_min)}</td>
                            <td className="sws-num">{ratio(r.headway_cv)}</td>
                            <td className="sws-num">
                              <Dwell
                                seconds={r.median_dwell_s}
                                censored={r.dwell_censored_share}
                              />
                            </td>
                          </>
                        )}
                        <td className="sws-num">{count(r.n_headways)}</td>
                        <td className="sws-num">{count(r.hours_observed)}</td>
                        <td className="sws-num">{count(r.n_days_observed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {station.arrivals?.available && (
                <dl className="sws-kv">
                  <dt>Arrival events</dt>
                  <dd>{station.arrivals.n_arrival_events?.toLocaleString() ?? "—"}</dd>
                  <dt>Trips observed</dt>
                  <dd>{station.arrivals.n_trips_observed?.toLocaleString() ?? "—"}</dd>
                  <dt>Dwell-censored share</dt>
                  <dd>{two(station.arrivals.dwell_censored_share)}</dd>
                  <dt>Median dwell, uncensored runs only</dt>
                  <dd>
                    {station.arrivals.median_dwell_s_uncensored_only == null
                      ? "—"
                      : `${station.arrivals.median_dwell_s_uncensored_only.toFixed(1)} s`}
                  </dd>
                  <dt>Excluded for a stale clock</dt>
                  <dd>
                    {station.arrivals.n_stale_clock_excluded_from_headways?.toLocaleString() ??
                      "—"}{" "}
                    ({two(station.arrivals.stale_clock_share)} share)
                  </dd>
                  <dt>Inside a known poller gap</dt>
                  <dd>{station.arrivals.n_in_known_poller_gap?.toLocaleString() ?? "—"}</dd>
                  <dt>Platform-to-parent fold</dt>
                  <dd className="sws-cols">{station.arrivals.parent_fold_source ?? "—"}</dd>
                </dl>
              )}
              {station.arrivals?.median_dwell_s_uncensored_note && (
                <Verbatim>{station.arrivals.median_dwell_s_uncensored_note}</Verbatim>
              )}
              {station.arrivals?.parent_fold_source_note && (
                <Verbatim>{station.arrivals.parent_fold_source_note}</Verbatim>
              )}
              {station.station_id_note && <Verbatim>{station.station_id_note}</Verbatim>}
              {station.suppression?.rule && <Verbatim>{station.suppression.rule}</Verbatim>}
            </>
          )}
        </section>
      )}

      {/* =====================================================================
          RUN TIMES — origin to LAST OBSERVED STOP. Not terminal to terminal.
          ===================================================================== */}
      <section className="nyc-section">
        <h2>Observed origin-to-last-stop run times</h2>
        {errRuns && <div className="nyc-note">Run times are unavailable.</div>}
        {!runs && !errRuns && <p className="nyc-note">Loading run times…</p>}
        {runs && (
          <>
            <p style={{ fontSize: "0.9rem", maxWidth: "74ch" }}>
              {runs.n_routes_published} of {runs.n_routes} lines hold enough qualifying
              runs to publish a figure; {runs.n_routes_suppressed} do not.
            </p>
            {runs.honesty_note && <Verbatim>{runs.honesty_note}</Verbatim>}
            <div className="nyc-table-wrap">
              <table className="nyc-table">
                <thead>
                  <tr>
                    <th scope="col">Line</th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Median run time (min)
                    </th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      p25–p75 (min)
                    </th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Median stop-sequence span
                    </th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Qualifying runs
                    </th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Qualifying share
                    </th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Days
                    </th>
                    <th scope="col" style={{ textAlign: "right" }}>
                      Directions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runs.routes.map((r) => (
                    <tr key={r.route_id}>
                      <th scope="row" className="sws-rowhead">
                        <LineBullet route={r.route_id} />
                      </th>
                      {r.suppressed ? (
                        <td className="sws-sup" colSpan={3}>
                          {r.suppressed_reason ??
                            "suppressed by the server, with no reason given"}
                        </td>
                      ) : (
                        <>
                          <td className="sws-num">{minutes(r.median_run_time_min)}</td>
                          <td className="sws-num">
                            {r.p25_run_time_min == null || r.p75_run_time_min == null ? (
                              <span className="sws-nc">not captured</span>
                            ) : (
                              `${r.p25_run_time_min.toFixed(1)}–${r.p75_run_time_min.toFixed(1)}`
                            )}
                          </td>
                          <td className="sws-num">{minutes(r.median_stop_sequence_span)}</td>
                        </>
                      )}
                      <td className="sws-num">{count(r.n_qualifying_runs)}</td>
                      <td className="sws-num">{ratio(r.qualifying_share)}</td>
                      <td className="sws-num">{count(r.n_days_observed)}</td>
                      <td className="sws-num">{count(r.n_directions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DownloadRow path="runs" label="Download run times:" />
            <p style={{ fontSize: "0.8rem", opacity: 0.8, maxWidth: "74ch" }}>
              The fastest and slowest single runs per line are in the download rather than
              this table: at this archive depth the extremes are dominated by trips we
              lost sight of and trips that lingered in the feed, so p25–p75 is the spread
              worth reading. The total dwell inside a run is also in the download and is
              deliberately not shown here, because the payload carries no censored share
              beside it and a dwell figure without one is misleading.
            </p>
            {runs.definition && <Verbatim>{runs.definition}</Verbatim>}
            {runs.shuttle_guard_note && <Verbatim>{runs.shuttle_guard_note}</Verbatim>}
            {runs.guard_verification && (
              <dl className="sws-kv">
                <dt>Zero-length flagged runs</dt>
                <dd>{runs.guard_verification.zero_length_flagged_runs ?? "—"}</dd>
                <dt>Same-endpoint flagged runs</dt>
                <dd>{runs.guard_verification.same_endpoint_flagged_runs ?? "—"}</dd>
                <dt>Single-station flagged runs</dt>
                <dd>{runs.guard_verification.single_station_flagged_runs ?? "—"}</dd>
                <dt>Flagged runs / rows</dt>
                <dd>
                  {runs.guard_verification.flagged_runs_total?.toLocaleString() ?? "—"} of{" "}
                  {runs.guard_verification.rows_total?.toLocaleString() ?? "—"}
                </dd>
                <dt>Guard holds</dt>
                <dd>{runs.guard_verification.guard_holds ? "yes" : "no"}</dd>
              </dl>
            )}
            {runs.guard_verification?.rule && (
              <Verbatim>{runs.guard_verification.rule}</Verbatim>
            )}
            {runs.suppression?.rule && <Verbatim>{runs.suppression.rule}</Verbatim>}
          </>
        )}
      </section>

      {/* =====================================================================
          ARCHIVE DEPTH + THE 2026-07-21 DISK-GUARD SUSPENSION
          ===================================================================== */}
      <section className="nyc-section">
        <h2>How deep the subway archive actually is</h2>
        {comp?.headline && (
          <p style={{ fontSize: "0.95rem", maxWidth: "74ch" }}>{comp.headline}</p>
        )}
        {comp && (
          <>
            <dl className="sws-kv">
              <dt>Equivalent complete days (subway_gtfs)</dt>
              <dd>{two(comp.equivalent_complete_days)}</dd>
              <dt>Same rule, bus feed</dt>
              <dd>{two(comp.equivalent_complete_days_bus_same_rule)}</dd>
              <dt>Worst of all eight subway feeds</dt>
              <dd>{two(comp.equivalent_complete_days_all_eight_feeds_worst)}</dd>
              <dt>Genuinely complete days</dt>
              <dd>
                {comp.complete_days ?? "—"}
                {comp.complete_day_list?.length
                  ? ` — ${comp.complete_day_list.join(", ")}`
                  : ""}
              </dd>
              <dt>Feeds derived from</dt>
              <dd className="sws-cols">{comp.feeds_derived_from?.join(", ") ?? "—"}</dd>
            </dl>
            {comp.equivalent_complete_days_method && (
              <Verbatim>{comp.equivalent_complete_days_method}</Verbatim>
            )}
            {comp.comparison_caveat && <Verbatim>{comp.comparison_caveat}</Verbatim>}
            {comp.complete_day_rule && <Verbatim>{comp.complete_day_rule}</Verbatim>}
            {comp.usable_hours_rule && <Verbatim>{comp.usable_hours_rule}</Verbatim>}
            {comp.exclude_from_stats_note && <Verbatim>{comp.exclude_from_stats_note}</Verbatim>}

            {comp.days?.length ? (
              <div className="nyc-table-wrap">
                <table className="nyc-table">
                  <thead>
                    <tr>
                      <th scope="col">Archive day (UTC)</th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Equivalent complete days
                      </th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Worst feed
                      </th>
                      <th scope="col">Complete?</th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Excluded local hours
                      </th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Arrival events
                      </th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Headway cells
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {comp.days.map((d) => (
                      <tr key={d.archive_day_utc}>
                        <th scope="row" className="sws-rowhead">
                          {d.archive_day_utc}
                        </th>
                        <td className="sws-num">
                          {two(d.equivalent_complete_days_subway_gtfs)}
                        </td>
                        <td className="sws-num">
                          {two(d.equivalent_complete_days_worst_feed)}
                        </td>
                        <td>{d.complete ? "complete" : "incomplete"}</td>
                        <td className="sws-num">
                          {d.excluded_local_hours_subway_gtfs?.length ?? 0}
                        </td>
                        <td className="sws-num">{count(d.arrival_events_in_day)}</td>
                        <td className="sws-num">{count(d.headway_cells_in_day)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {comp.status_vocabulary && (
              <dl className="sws-kv">
                {Object.entries(comp.status_vocabulary).map(([k, v]) => (
                  <div key={k} style={{ display: "contents" }}>
                    <dt className="sws-cols">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            )}

            {/* The payload's own evidence-based verdict on 2026-07-21, rendered whole.
                The subway did NOT come through that suspension intact. */}
            {comp.disk_guard_incident?.present && (
              <div className="sws-callout">
                <h3>The {comp.disk_guard_incident.day} disk-guard suspension</h3>
                <p>{comp.disk_guard_incident.verdict}</p>
                <dl className="sws-kv">
                  <dt>Subway equivalent complete days</dt>
                  <dd>{two(comp.disk_guard_incident.subway_equivalent_complete_days)}</dd>
                  <dt>Bus equivalent complete days</dt>
                  <dd>{two(comp.disk_guard_incident.bus_equivalent_complete_days)}</dd>
                  <dt>Subway feeds with missing hours</dt>
                  <dd className="sws-cols">
                    {comp.disk_guard_incident.subway_feeds_with_missing_hours?.join(", ") ??
                      "—"}
                  </dd>
                  <dt>Subway hours excluded (UTC)</dt>
                  <dd>
                    {comp.disk_guard_incident.subway_excluded_utc_hours?.length ?? 0} of 24
                  </dd>
                </dl>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
