// Typed client for the nycvisualizer FastAPI backend.
// The browser talks ONLY to this backend — never to MTA/Socrata directly, and
// never sees any server-side key. Base URL is same-origin by default (dev proxy
// or same host in prod); override with VITE_API_BASE for a split deploy.

import { trackMapError } from "./beacon";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export interface Vehicle {
  vehicle_id: string;
  route_id: string | null;
  trip_id: string | null;
  lat: number;
  lon: number;
  bearing: number | null;
  timestamp: number | null;
  stop_id: string | null;
  direction_id: number | null;
  // Ant Farm v3 (W1-server) additive motion fields — present only where honestly
  // resolvable. shape_id + route_offset_ft let the client glide a bus ALONG its route
  // shape (never straight through blocks); speed_est_fps drives dead-reckoning.
  shape_id?: string | null;
  route_offset_ft?: number | null;
  speed_est_fps?: number | null;
  speed_basis?: "observed" | "segment" | "route" | "default" | string | null;
  // Crowding — A1/B6. Present only on the ~half of the fleet carrying an automatic
  // passenger counter. ABSENT MEANS "NO COUNTER", NEVER "EMPTY BUS": the value 0 does not
  // occur in this feed, so a blank must be rendered as unknown, not as a low load.
  // `occupancy_status` is MTA's 5-bucket rounding; `passenger_count` is the real APC
  // head-count behind it (OneBusAway vehicle extension), capacity is a constant 80.
  occupancy_status?: number | null;
  passenger_count?: number | null;
  passenger_capacity?: number | null;
}

/** GTFS-RT OccupancyStatus in the words a rider would use. Exported so the four vehicle
 *  popups render one vocabulary. `null` is deliberately NOT in this map — absence is
 *  "no counter on this bus", which is a different statement and must be rendered as one. */
export const OCCUPANCY_LABEL: Record<number, string> = {
  0: "empty",
  1: "many seats free",
  2: "a few seats free",
  3: "standing room only",
  4: "crowded — standing only",
  5: "full",
  6: "not taking passengers",
  7: "no data reported",
  8: "not boardable",
};
export const OCCUPANCY_ABSENT =
  "no automatic passenger counter on this bus — about half the fleet has none. " +
  "This is not an empty bus.";

/** One `<br/>`-terminated crowding line for a vehicle popup, matching the four existing
 *  popups' plain-HTML style (they are HTML-string hooks handed to the flow engine, not
 *  React). When the bus does not report, this renders `not captured` CARRYING THE REASON
 *  — a blank line here would read as "empty bus", which is the opposite of the truth. */
export function occupancyLineHtml(v: Vehicle): string {
  const pax = v.passenger_count;
  const cap = v.passenger_capacity;
  const st = v.occupancy_status;
  if (pax == null && st == null) {
    return `Crowding: <span title="${OCCUPANCY_ABSENT}" style="opacity:.65">not captured</span><br/>`;
  }
  const label = st != null ? (OCCUPANCY_LABEL[st] ?? `status ${st}`) : null;
  const head = pax != null ? `~${pax}${cap ? ` of ${cap}` : ""} passengers` : null;
  return `Crowding: ${[head, label].filter(Boolean).join(" · ")}<br/>`;
}
/** Fields the backend adds when it clipped a realtime payload to a viewport.
 *
 *  `count` on a clipped payload is the number of vehicles IN THE WINDOW, not the number
 *  running — presenting it as the latter is how the on-screen bus count came to swing
 *  between the citywide figure and zero while panning. Anything consuming a realtime
 *  payload must check `bbox_filtered` before treating absence as absence of service. */
export interface BBoxClip {
  bbox_filtered?: boolean;
  /** The applied window, [minLon, minLat, maxLon, maxLat]. Absent on the citywide SSE. */
  bbox?: [number, number, number, number];
}
/** Turn a realtime payload into the motion engine's ingest scope. One helper, so no page
 *  has to remember whether it sent a bbox — the server says whether it clipped. */
export const ingestScope = (
  d: BBoxClip,
): { partial: boolean; bbox?: [number, number, number, number] } =>
  d.bbox_filtered && d.bbox ? { partial: true, bbox: d.bbox } : { partial: false };

export interface VehiclesResponse extends BBoxClip {
  as_of: number | null; // epoch seconds of the freshest snapshot
  source: "archive" | "live" | "none";
  count: number;
  stale: boolean;
  vehicles: Vehicle[];
}
export interface RouteInfo {
  route_id: string;
  short_name: string;
  long_name: string;
  color: string; // hex without leading '#'
  borough: string;
}
export interface RouteShape {
  route_id: string;
  polylines: [number, number][][]; // [lat, lon] pairs, one array per shape
  stops: { stop_id: string; stop_name: string; lat: number; lon: number }[];
}
export interface AlertItem {
  id: string;
  header: string;
  description: string;
  routes: string[];
}
export interface AlertsResponse {
  source: "archive" | "live" | "none";
  as_of: number | null;
  alerts: AlertItem[];
}

export interface SubwayTrain {
  trip_id: string;
  route_id: string | null;
  feed: string;
  lat: number;
  lon: number;
  status: "at_station" | "approaching" | "in_transit";
  /** "station" = observed at a station; "interpolated" = honest position estimate. */
  positional_basis: "station" | "interpolated";
  stop_id: string;
  stop_name: string;
  prev_stop_name: string | null;
  timestamp: number | null;
  /** Inter-station track polyline [[lat,lon],…] in travel order (prev→target
   *  station). Present only on interpolated trains; the client lays the train
   *  worm ALONG this and animates the fraction. Absent for at-station trains. */
  seg?: [number, number][];
  /** Fraction (0→1) of `seg` the train has travelled (prev=0, target=1). */
  frac?: number;
  /** How `seg` was derived: "shape" = real GTFS track polyline; "straight" =
   *  a prev→next station glide line (honest fallback when no shape matched).
   *  Added by the backend seg-coverage work; optional for forward-compat. */
  seg_basis?: "shape" | "straight";
}
export interface SubwayResponse extends BBoxClip {
  as_of: number | null;
  source: "archive" | "live" | "mixed" | "none";
  count: number;
  stale: boolean;
  feeds: Record<string, { as_of: number | null; source: string; count: number; stale: boolean }>;
  positional: { station: number; interpolated: number };
  trains: SubwayTrain[];
}
export interface StationInfo {
  id: string;
  name: string;
  lat: number;
  lon: number;
  routes: string[];
}
export interface StationArrivals {
  station_id: string;
  station_name: string | null;
  routes: string[];
  arrivals: { route: string | null; trip_id: string; direction: string; eta_seconds: number }[];
}

// --- Service changes (S8, rides the S3 GTFS diff engine) ---
export interface ServiceChange {
  id: string;
  feed: string;
  route_id: string;
  route_name: string;
  change_type: string;
  borough: string;
  summary: string;
  classification: "temporary" | "persisted";
  is_proof: boolean;
  service_direction: string;
  magnitude: number | null;
  from_ts: string;
  to_ts: string;
  detected_at: string;
  detail: Record<string, unknown>;
}
export interface ChangesResponse {
  total: number;
  page: number;
  page_size: number;
  returned: number;
  counts: {
    detected: number;
    proof_backfill: number;
    temporary: number;
    persisted: number;
  };
  facets: {
    feed: Record<string, number>;
    change_type: Record<string, number>;
    borough: Record<string, number>;
    classification: Record<string, number>;
  };
  detection_began: string;
  changes: ServiceChange[];
}
export interface ChangesFeed {
  title: string;
  generated_at: string;
  detection_began: string;
  count: number;
  total_detected: number;
  note: string;
  changes: ServiceChange[];
}

export interface ChangesQuery {
  page?: number;
  page_size?: number;
  route?: string;
  change_type?: string;
  borough?: string;
  include_proof?: boolean;
}
export const getChanges = (q: ChangesQuery = {}) => {
  const p = new URLSearchParams();
  if (q.page) p.set("page", String(q.page));
  if (q.page_size) p.set("page_size", String(q.page_size));
  if (q.route) p.set("route", q.route);
  if (q.change_type) p.set("change_type", q.change_type);
  if (q.borough) p.set("borough", q.borough);
  if (q.include_proof) p.set("include_proof", "true");
  const qs = p.toString();
  return getJSON<ChangesResponse>("/api/changes" + (qs ? `?${qs}` : ""));
};
export const getChangesFeed = () => getJSON<ChangesFeed>("/api/changes/feed.json");

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(API_BASE + path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return (await r.json()) as T;
}

// F5/F3: immersive pages send ?bbox=minLon,minLat,maxLon,maxLat on rt POLLS to slim
// the payload to the current viewport (backend filter is strictly additive — a bad or
// absent bbox serves the full payload). SSE is intentionally left unfiltered.
const bboxQuery = (bbox?: string) => (bbox ? `?bbox=${encodeURIComponent(bbox)}` : "");
export const getVehicles = (bbox?: string) =>
  getJSON<VehiclesResponse>("/api/rt/vehicles" + bboxQuery(bbox));
export const getRoutes = () => getJSON<RouteInfo[]>("/api/routes");
export const getRouteShape = (routeId: string) =>
  getJSON<RouteShape>(`/api/routes/${encodeURIComponent(routeId)}`);

// Ant Farm v3 (W1) — the EXACT decimated shape geometry that /api/rt/vehicles'
// route_offset_ft is measured against, with a cumulative offset_ft per vertex, so the
// motion client can place a bus at its route_offset_ft along the identical polyline.
export interface RtShapeDir {
  direction_id: number;
  shape_id: string;
  shape_len_ft: number;
  n_verts: number;
  polyline: [number, number][]; // [lat, lon] decimated verts
  offset_ft: number[]; // cumulative full-shape offset (ft) per vertex; same length as polyline
}
export interface RtRouteShapes {
  route_id: string;
  directions: RtShapeDir[];
}
export const getRouteShapesRT = (routeId: string, direction?: number) => {
  const p = new URLSearchParams();
  p.set("route", routeId);
  if (direction != null) p.set("direction", String(direction));
  return getJSON<RtRouteShapes>("/api/rt/route_shapes?" + p.toString());
};
export const getAlerts = () => getJSON<AlertsResponse>("/api/rt/alerts");
export const getArrivals = (stopId: string) =>
  getJSON<{ stop_id: string; arrivals: { route: string; headsign: string; eta_seconds: number | null; stops_away: number | null }[] }>(
    `/api/stops/${encodeURIComponent(stopId)}/arrivals`,
  );

// ---------------------------------------------------------------------------
// W11 — stop cards + distance ALONG the bus route (/api/stops/*)
//
// Both are FETCH-ON-CLICK, never eager: 57 selected routes is thousands of stops, and
// pre-fetching detail for all of them is the shape of defect this page has already had
// once. `routes` narrows the answer to the planner's current selection.
// ---------------------------------------------------------------------------

export interface StopCardDirection {
  route_id: string;
  direction_id: number | null;
  direction_label: string | null;
  stop_seq: number | null;
  offset_ft: number | null;
  prev_stop_name: string | null;
  prev_spacing_ft: number | null;
  next_stop_name: string | null;
  next_spacing_ft: number | null;
  observed_headway_min: number | null;
  scheduled_headway_min: number | null;
  headway_deviation_min: number | null;
  bunching_index: number | null;
  worst_hour: number | null;
  worst_hour_deviation_min: number | null;
  n_headways: number | null;
  observed_days: number | null;
  preliminary: boolean | null;
}
export interface StopCardSai {
  sai: number | null;
  sai_pctile: number | null;
  sheltered: boolean | null;
  ramps_150ft: number | null;
  sidewalk_sqft_400m: number | null;
  people_400m: number | null;
  jobs_400m: number | null;
  safety: number | null;
  comfort: number | null;
  borough: string | null;
}
export interface StopCardResponse {
  stop_id: string;
  stop_name: string | null;
  borough: string | null;
  directions: StopCardDirection[];
  sai: StopCardSai | null;
  wheelchair_boarding: string | null;
  active_changes: string[] | null;
  /** field name -> why it is absent. Rendered verbatim, never hidden. */
  not_captured: Record<string, string>;
  archive_depth_days: number | null;
  as_of: string | null;
  rounding_ft: number;
}
export const getStopCard = (stopId: string, routes?: string[]) => {
  const p = new URLSearchParams();
  p.set("stop_id", stopId);
  if (routes && routes.length) p.set("routes", routes.join(","));
  return getJSON<StopCardResponse>("/api/stops/card?" + p.toString());
};

export interface AlongLeg {
  from_stop: string;
  to_stop: string;
  from_name: string | null;
  to_name: string | null;
  along_ft: number | null;
  route_id: string | null;
  direction_id: number | null;
  direction_label: string | null;
  stops_between: number | null;
  opposite_direction_ft?: number | null;
  note: string | null;
}
export interface AlongResponse {
  stops: string[];
  stop_names: Record<string, string>;
  legs: AlongLeg[];
  /** Non-null ONLY when one route+direction carries a bus across every leg, in the
   *  direction the stops were picked. Never a sum across different routes. */
  total_along_ft: number | null;
  route_id: string | null;
  direction_id: number | null;
  direction_label: string | null;
  note: string | null;
  opposite_direction_total_ft?: number | null;
  opposite_route_id?: string | null;
  basis: string;
  rounding_ft: number;
}
export const getStopsAlong = (stopIds: string[], routes?: string[]) => {
  const p = new URLSearchParams();
  p.set("stops", stopIds.join(","));
  if (routes && routes.length) p.set("routes", routes.join(","));
  return getJSON<AlongResponse>("/api/stops/along?" + p.toString());
};

export interface WalkResponse {
  from_stop: string;
  to_stop: string;
  walk_ft: number;
  walk_minutes: number;
  straight_ft: number;
  streets: string[];
  engine: string;
  basis: string;
}
/** Walking distance over the real sidewalk network. An EXPLICIT per-leg action: it is a
 *  server round-trip to a routing engine, and a planner asks for it deliberately.
 *  Throws on 503 — the endpoint never substitutes a straight line for a walked route,
 *  and neither does the caller. */
export const getStopsWalk = (fromStop: string, toStop: string) => {
  const p = new URLSearchParams();
  p.set("from_stop", fromStop);
  p.set("to_stop", toStop);
  return getJSON<WalkResponse>("/api/stops/walk?" + p.toString());
};

/** The selection, assembled SERVER-SIDE, as a real table. CSV / XLSX / Parquet — no
 *  JSON, per the estate's download standard. `clipboard` returns tab-separated text for
 *  pasting into an email or a spreadsheet, because a download is the wrong verb for
 *  three stops. */
export const stopsExportUrl = (
  stopIds: string[],
  format: "csv" | "xlsx" | "parquet" | "clipboard",
  routes?: string[],
  table: "stops" | "pairs" = "stops",
) => {
  const p = new URLSearchParams();
  p.set("stops", stopIds.join(","));
  p.set("format", format);
  p.set("table", table);
  if (routes && routes.length) p.set("routes", routes.join(","));
  return API_BASE + "/api/stops/export?" + p.toString();
};
export const getStopsClipboard = async (
  stopIds: string[],
  routes?: string[],
  table: "stops" | "pairs" = "stops",
) => {
  const r = await fetch(stopsExportUrl(stopIds, "clipboard", routes, table));
  if (!r.ok) throw new Error(`export -> HTTP ${r.status}`);
  return r.text();
};

export const getSubway = (bbox?: string) =>
  getJSON<SubwayResponse>("/api/rt/subway" + bboxQuery(bbox));
export const getStations = () => getJSON<StationInfo[]>("/api/stations");
export const getStationArrivals = (stationId: string) =>
  getJSON<StationArrivals>(`/api/stations/${encodeURIComponent(stationId)}/arrivals`);

/** Generic SSE subscription. Returns an unsubscribe fn.
 *  Falls back silently — callers also run a poll timer as a safety net.
 *
 *  Q0.6.5: the native EventSource auto-reconnect is uncontrolled (it retries the
 *  aborted stream on a fixed interval and re-fires onerror in a tight loop,
 *  which is the source of the /api/rt/vehicles/stream ERR_ABORTED churn). We
 *  instead close on error and drive our own BOUNDED EXPONENTIAL backoff back to
 *  SSE (2s → 30s cap), resetting on a good frame, and stop cleanly on
 *  unsubscribe so an unmount can never schedule a reconnect (the mount/unmount
 *  race). Between failures the caller's poll timer covers the gap. */
function streamJSON<T>(path: string, onData: (v: T) => void, onError?: () => void): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let attempt = 0;
  // F5: consecutive-failure counter for the SSE-permanently-down beacon (>5 in a row).
  // Separate from `attempt` so we can fire exactly once per down-episode.
  let consecutiveFail = 0;
  let downBeaconed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const MAX_BACKOFF_MS = 30_000;

  const healthy = () => {
    attempt = 0; // reset backoff
    consecutiveFail = 0;
    downBeaconed = false;
  };

  const connect = () => {
    if (stopped) return;
    try {
      es = new EventSource(API_BASE + path);
    } catch {
      onError?.();
      noteFailure();
      scheduleRetry();
      return;
    }
    es.onopen = () => {
      healthy(); // healthy connection
    };
    es.onmessage = (ev) => {
      healthy(); // a good frame also proves liveness
      try {
        onData(JSON.parse(ev.data) as T);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      // Detach every handler BEFORE closing so the aborted stream can't re-fire
      // onerror in a tight loop (the ERR_ABORTED console churn): one clean close,
      // one bounded retry, and the caller's poll timer covers the gap silently.
      if (es) {
        es.onopen = null;
        es.onmessage = null;
        es.onerror = null;
        es.close();
      }
      es = null;
      onError?.();
      noteFailure();
      scheduleRetry();
    };
  };

  // F5 beacon: SSE permanently down (>5 consecutive failures with no good frame). The
  // caller's 30s poll timer keeps the page live; this only records the degradation.
  const noteFailure = () => {
    consecutiveFail++;
    if (consecutiveFail > 5 && !downBeaconed) {
      downBeaconed = true;
      trackMapError("sse_down:" + path);
    }
  };

  const scheduleRetry = () => {
    if (stopped || retryTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** attempt);
    attempt++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  };

  connect();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (es) {
      // Detach handlers first: an unmount close aborts the in-flight GET; without
      // this, onerror fires during teardown and schedules a doomed reconnect.
      es.onopen = null;
      es.onmessage = null;
      es.onerror = null;
      es.close();
    }
    es = null;
  };
}

export const streamVehicles = (onData: (v: VehiclesResponse) => void, onError?: () => void) =>
  streamJSON<VehiclesResponse>("/api/rt/vehicles/stream", onData, onError);
export const streamSubway = (onData: (v: SubwayResponse) => void, onError?: () => void) =>
  streamJSON<SubwayResponse>("/api/rt/subway/stream", onData, onError);

// ===========================================================================
// Bus Observatory (S5) — /api/obs/*
// CRITICAL: a route_id may contain "+" (the SBS "positive" variant, e.g. "M15+").
// Always pass route ids through encodeObsRoute() so "+" becomes %2B, not a space.
// ===========================================================================

/** Archive-depth honesty metadata attached to every obs payload. */
export interface ObsArchive {
  archive_depth_days: number;
  preliminary: boolean;
  gap_note: string;
  observed_dates: string[];
  dates_used: string[];
}

export interface ObsRouteStats {
  date: string;
  median_headway_s: number | null;
  median_headway_min: number | null;
  bunching_index: number | null;
  sched_median_headway_min: number | null;
  n_headways: number;
  n_stops_observed: number;
  coverage_hours: number;
  preliminary: boolean;
}
export interface ObsRoute {
  route_id: string;
  short_name: string;
  long_name: string;
  borough: string;
  borough_group: string;
  color: string;
  sbs: boolean;
  observed: boolean;
  stats: ObsRouteStats | null;
}
export interface ObsRoutesResponse {
  generated_at: string;
  count: number;
  observed_count: number;
  archive: ObsArchive;
  routes: ObsRoute[];
}

export interface MareyStop {
  stop_id: string;
  name: string;
  offset_ft: number;
  stop_seq: number | null;
}
export interface MareyTrip {
  trip_id: string;
  shape_id?: string;
  live?: boolean;
  series: [number, number][]; // [ts (epoch s, UTC), offset_ft]
}
export interface MareyResponse {
  route: string;
  direction: number;
  date: string;
  window: string;
  window_start_ts: number;
  window_end_ts: number;
  is_today: boolean;
  live_merged: boolean;
  canonical_shape_id: string | null;
  shape_length_ft: number | null;
  stops: MareyStop[];
  observed: MareyTrip[];
  scheduled: MareyTrip[];
  counts: {
    observed_trips: number;
    scheduled_trips: number;
    live_vehicles: number;
    points_total: number;
    stops: number;
  };
  archive: ObsArchive;
  elapsed_ms: number;
  error?: string;
}
export interface MareyStreamPoint {
  trip_id: string;
  vehicle_id: string;
  ts: number;
  offset_ft: number;
}
export interface MareyStreamFrame {
  route: string;
  direction: number;
  as_of: number | null;
  count: number;
  points: MareyStreamPoint[];
}

export interface HeadwaySummaryStop {
  stop_id: string;
  direction_id: number | null;
  stop_name: string | null;
  offset_ft: number | null;
  median_headway_s: number | null;
  median_headway_min: number | null;
  sched_median_headway_s: number | null;
  sched_median_headway_min: number | null;
  bunching_index: number | null;
  max_headway_cv: number | null;
  n_headways: number;
  observed_days: number;
  preliminary: boolean;
}
export interface HeadwaySummaryResponse {
  route: string;
  direction: number | null;
  n_stops: number;
  stops: HeadwaySummaryStop[];
  archive: ObsArchive;
}

export interface HeadwayPoint {
  date: string;
  local_hour: number;
  direction_id?: number | null;
  stop_id?: string;
  stop_name?: string | null;
  median_headway_s: number | null;
  sched_median_headway_s: number | null;
  headway_deviation_s: number | null;
  bunching_index: number | null;
  headway_cv?: number | null;
  n_headways: number;
  preliminary: boolean;
}
export interface HeadwaysResponse {
  route: string;
  stop_id: string | null;
  date_range: string | null;
  grain: "stop_hour" | "route_hour";
  n_points: number;
  series: HeadwayPoint[];
  archive: ObsArchive;
}

export interface DossierMeta {
  route_id: string;
  short_name: string;
  long_name: string;
  borough: string;
  color: string;
  sbs: boolean;
}
export interface RidershipHour {
  hod: number;
  weekday_boardings: number | null;
  weekend_boardings: number | null;
  total_boardings: number | null;
}
export interface SlowSegment {
  from_stop: string;
  to_stop: string;
  wt_speed_mph: number;
  n_trips: number | null;
  seg_miles: number | null;
}
export interface AceInfo {
  ace_enabled: boolean;
  program: string | null;
  implementation_date: string | null;
  violations_total: number;
  first_violation: string | null;
  last_violation: string | null;
  by_year: { year: number; violations: number }[];
}
export interface SaiStats {
  n_stops_matched: number;
  median_composite_sai: number | null;
  pct_sheltered: number | null;
  median_walkshed_population: number | null;
  median_n_routes: number | null;
  median_safety: number | null;
  median_comfort: number | null;
}
export interface StopSpacing {
  shape_id: string;
  n_stops: number;
  median_spacing_ft: number;
  mean_spacing_ft: number;
  min_spacing_ft: number;
  max_spacing_ft: number;
}
export interface ScheduledServiceRow {
  direction_id: number | null;
  period: string;
  span_min: number | null;
  trips: number | null;
  headway_min: number | null;
}
export interface ReliabilitySummary {
  median_headway_s: number | null;
  median_headway_min: number | null;
  sched_median_headway_s: number | null;
  bunching_index: number | null;
  median_deviation_s: number | null;
  n_headways: number;
  n_stops_observed: number;
  observed_days: number;
  preliminary: boolean;
}
export interface DossierResponse {
  route: string;
  meta: DossierMeta;
  generated_at: string;
  ridership_by_hour: RidershipHour[];
  route_peak_speed: { wt_speed_mph: number; n_trips: number | null; borough: string } | null;
  slowest_segments: SlowSegment[];
  ace: AceInfo | null;
  sai_stats: SaiStats | null;
  stop_spacing: StopSpacing | null;
  scheduled_service: ScheduledServiceRow[];
  reliability_summary: ReliabilitySummary | null;
  alerts_active: { id: string; header: string; description: string }[];
  archive: ObsArchive;
  elapsed_ms: number;
}

export interface LeagueReliableRow {
  route_id: string;
  short_name: string;
  borough: string;
  sbs: boolean;
  observed_days: number;
  n_headways: number;
  bunching_index: number;
  headway_cv?: number | null;
  median_headway_min: number | null;
  median_deviation_s: number | null;
  median_abs_deviation_s: number | null;
}
/** Q2.3 gating: one qualifying route in the unranked bunching distribution
 *  shown until the archive earns the ordinal leaderboards (depth ≥ 14 days). */
export interface LeagueDistributionRow {
  route_id: string;
  short_name: string;
  borough: string;
  sbs: boolean;
  bunching_index: number;
  headway_cv: number | null;
  observed_days: number;
  n_headways: number;
}
export interface LeagueSlowRow {
  route_id: string;
  borough: string;
  from_stop: string;
  to_stop: string;
  wt_speed_mph: number;
  n_trips: number | null;
  seg_miles: number | null;
}
export interface LeagueImprovedRow {
  route_id: string;
  short_name: string;
  borough: string;
  early_abs_dev_s: number;
  late_abs_dev_s: number;
  improvement_s: number;
}
export interface LeaguesResponse {
  generated_at: string;
  criteria: {
    min_observed_days: number;
    min_headways: number;
    note: string;
    excluded_thin_routes: number;
    qualifying_routes: number;
  };
  /** Q2.3: true only at archive depth ≥ 14 days; the frontend renders the
   *  distribution view instead of the ranked boards while this is false. */
  rankings_unlocked: boolean;
  most_reliable: LeagueReliableRow[];
  least_reliable: LeagueReliableRow[];
  slowest_corridors: LeagueSlowRow[];
  most_improved_vs_schedule: LeagueImprovedRow[];
  distribution: LeagueDistributionRow[];
  archive: ObsArchive;
  elapsed_ms: number;
}

/** Encode a route id for a query string, forcing "+" -> %2B (never a space). */
export const encodeObsRoute = (routeId: string) => encodeURIComponent(routeId);

export const getObsRoutes = () => getJSON<ObsRoutesResponse>("/api/obs/routes");

export const getMarey = (
  route: string,
  direction: number,
  window: string,
  date?: string,
  end?: number,
) => {
  const p = new URLSearchParams();
  p.set("route", route); // URLSearchParams encodes "+" as %2B correctly
  p.set("direction", String(direction));
  p.set("window", window);
  if (date) p.set("date", date);
  if (end != null) p.set("end", String(end));
  return getJSON<MareyResponse>("/api/obs/marey?" + p.toString());
};

export const getHeadwaysSummary = (route: string, direction?: number | null) => {
  const p = new URLSearchParams();
  p.set("route", route);
  if (direction != null) p.set("direction", String(direction));
  return getJSON<HeadwaySummaryResponse>("/api/obs/headways/summary?" + p.toString());
};

export const getHeadways = (route: string, stopId?: string, dateRange?: string) => {
  const p = new URLSearchParams();
  p.set("route", route);
  if (stopId) p.set("stop_id", stopId);
  if (dateRange) p.set("date_range", dateRange);
  return getJSON<HeadwaysResponse>("/api/obs/headways?" + p.toString());
};

export const getDossier = (route: string) => {
  const p = new URLSearchParams();
  p.set("route", route);
  return getJSON<DossierResponse>("/api/obs/dossier?" + p.toString());
};

export const getLeagues = () => getJSON<LeaguesResponse>("/api/obs/leagues");

// --- Route adherence (W1 motion model; framed as position-quality) ---
// Share of GPS pings within `onroute_threshold_ft` of the trip's shape, per route.
// The no-route call returns the pooled per-route distribution (routes with >= 500
// pings) in one shot — the workstation right-rail reads it as a route→pct map.
export interface AdherenceRoute {
  route_id: string;
  adherence_pct: number;
  n_pings: number;
  n_trips: number | null;
  median_perp_ft: number | null;
}
export interface AdherenceResponse {
  route: string | null;
  note: string;
  observed_dates: string[];
  gap_note?: string;
  onroute_threshold_ft: number;
  terminal_excluded_ft?: number;
  no_data?: boolean;
  n_routes?: number;
  citywide_adherence_pct?: number | null;
  median_route_adherence_pct?: number | null;
  routes: AdherenceRoute[];
  worst_10?: AdherenceRoute[];
}
export const getAdherence = (route?: string) => {
  const p = new URLSearchParams();
  if (route) p.set("route", route);
  const qs = p.toString();
  return getJSON<AdherenceResponse>("/api/obs/adherence" + (qs ? `?${qs}` : ""));
};

// --- Reliability ribbon (S5/Q1.3) ---
export interface RibbonSegment {
  from_stop: string;
  to_stop: string;
  wt_speed_mph: number;
  /** within-route speed percentile: 0 = slowest segment, 1 = fastest. */
  speed_pctile: number;
  n_trips: number | null;
  seg_miles: number | null;
  borough: string | null;
  coords: [number, number][]; // [[lat,lon],[lat,lon]]
}
export interface RibbonResponse {
  route: string;
  meta: DossierMeta;
  n_segments: number;
  n_placed: number;
  route_median_speed_mph: number | null;
  speed_domain: { basis: string; min_mph: number | null; max_mph: number | null };
  width_basis: "constant_color_only" | string;
  width_note: string;
  color_note: string;
  segments: RibbonSegment[];
  archive: ObsArchive;
  elapsed_ms: number;
}
export const getRibbon = (route: string) => {
  const p = new URLSearchParams();
  p.set("route", route);
  return getJSON<RibbonResponse>("/api/obs/ribbon?" + p.toString());
};

// ===========================================================================
// Live Ops Wall (S6) — /api/wall
// ===========================================================================
export interface WallHotspot {
  lat: number;
  lon: number;
  /** Q1.5: both bus positions for the bunching connector line (may be absent on
   *  older cached payloads — fall back to the midpoint dot only). */
  lat_a?: number;
  lon_a?: number;
  lat_b?: number;
  lon_b?: number;
  route: string;
  direction: number;
  severity: "high" | "medium" | "low";
  gap_m: number;
  sched_headway_s: number;
}
export interface WallBunching {
  pairs: number;
  routes_bunching: number;
  routes_running: number;
  pct_routes_bunching: number;
  hotspots: WallHotspot[];
  basis: string;
  nominal_bus_mps: number;
}
export interface WallAlertItem {
  id: string;
  severity: "high" | "medium" | "low";
  header: string;
  routes: string[];
  subway: boolean;
}
export interface WallSubwayLine {
  line: string;
  route_id: string;
  color: string;
  text: string;
  count: number;
  alerted: boolean;
}
export interface WallTrailBin {
  t: string;
  epoch: number | null;
  service_ratio: number | null;
  mean_abs_headway_dev_s: number | null;
  active_bunching_pairs: number | null;
  alerts_total: number | null;
  live: boolean;
}
export interface WallResponse {
  generated_at: number;
  cache_ttl_s: number;
  now: {
    buses: { reporting: number; as_of: number | null; source: string; stale: boolean };
    subway: { trains: number; as_of: number | null; source: string; stale: boolean };
    scheduled_active: number | null;
    scheduled_basis: string;
    scheduled_bin_local_iso: string | null;
    scheduled_cache_built_at: number | null;
    /** Age of the GTFS-static cache backing the service-ratio DENOMINATOR (W6a). */
    scheduled_cache_age_min?: number | null;
    scheduled_cache_stale?: boolean;
    service_ratio: number | null;
    bunching: WallBunching;
    alerts: {
      high: number;
      medium: number;
      low: number;
      total: number;
      as_of: number | null;
      items: WallAlertItem[];
      /** W6a: "live" = fetched from the upstream GTFS-RT alert feeds this request;
       *  "archive" = fell back to the raw JSONL archive; "none" = nothing available. */
      source?: "live" | "archive" | "none";
      /** True when the alert set is older than the staleness threshold. NEVER render a
       *  stale set under a "live" label — this flag exists so the UI cannot. */
      stale?: boolean;
      age_s?: number | null;
      /** What the high/med/low split is actually derived from.
       *  "unclassified"       upstream published no usable signal for ANY alert, so the
       *                       split would be our default wearing MTA's name — the UI
       *                       must say "severity not published" instead.
       *  "gtfs_effect"        GTFS-RT `effect` (never seen on these feeds in practice).
       *  "mercury_alert_type" MTA's own Mercury `alert_type` taxonomy — the real one. */
      severity_basis?: "gtfs_effect" | "unclassified" | "mercury_alert_type";
      unknown_effect?: number;
      /** Alerts carrying NO MTA alert_type — counted in `total` but deliberately not
       *  tiered. The bus alert feed has no Mercury extension, so `high+medium+low` does
       *  NOT sum to `total`, and rendering the three without this reads as a wrong split
       *  rather than a partial one. */
      unclassified?: number;
      /** Per-`alert_type` counts, MTA's own taxonomy verbatim. */
      alert_types?: Record<string, number>;
      typed?: number;
      planned?: number;
      /** How many of `total` the capped ticker is actually showing. */
      items_shown?: number;
      feeds?: Record<string, { as_of: number | null; count: number }>;
    };
  };
  subway_strip: {
    lines: WallSubwayLine[];
    feeds: Record<string, { as_of: number | null; source: string; count: number; stale: boolean }>;
    as_of: number | null;
    source: string;
    stale: boolean;
    total_trains: number;
  };
  trailing3h: {
    bins: WallTrailBin[];
    parquet_last_local_iso: string | null;
    kpi_lag_min?: number | null;
    splice_note: string;
    headway_dev_series: number[];
    headway_dev_last: { value: number; local_iso: string; lag_min: number } | null;
    /** W6a — what the `bins` array ACTUALLY is:
     *  "trailing_3h"           the real last 3 hours (host derives locally);
     *  "last_available_rollup" the newest rollups that exist, which may be many hours
     *                          old (the public box receives derived data once a day);
     *  "none"                  no rollups at all — draw nothing, say so.
     *  Never label the chart "trailing 3 h" unless window_basis says so. */
    window_basis?: "trailing_3h" | "last_available_rollup" | "none";
    window_first_local_iso?: string | null;
    window_last_local_iso?: string | null;
    window_lag_min?: number | null;
    window_span_bins?: number;
    /** Ready-made honest caption for the trend charts. */
    window_label?: string;
  };
  archive: ObsArchive;
  as_of: Record<string, number | string | null>;
}

export const getWall = () => getJSON<WallResponse>("/api/wall");
export const streamWall = (onData: (v: WallResponse) => void, onError?: () => void) =>
  streamJSON<WallResponse>("/api/wall/stream", onData, onError);

// ===========================================================================
// Renter's Map (S7) — /api/renters/*
// Place-and-infrastructure only. NO demographic / protected-class variables in
// any score. Every payload carries an explicit fair-housing disclaimer that the
// UI MUST display. The backend /profile call bundles a fixed 45-min / weekday-8am
// isochrone inline; 30- and 60-min variants are fetched on demand via /api/isochrone.
// ===========================================================================

/** One place-based metric: a citywide percentile + the raw value it ranks.
 *  `higher_is` is the backend's raw semantics ("more" of the thing, or "better"
 *  composite). The UI maps each metric to a good-direction of its own. */
export interface RenterScore {
  percentile: number | null;
  value: number | null;
  label: string;
  higher_is: "more" | "better";
}
export interface RenterScores {
  transit_supply: RenterScore;
  transit_access_sai: RenterScore;
  jobs_45min: RenterScore;
  noise: RenterScore;
  sidewalk_complaints: RenterScore;
  rodent_failures: RenterScore;
  pedestrian_crashes: RenterScore;
  street_trees: RenterScore;
  sidewalk_coverage: RenterScore;
}
export type RenterScoreKey = keyof RenterScores;

export interface RenterStopSubscores {
  safety: number | null;
  comfort: number | null;
  condition: number | null;
  service_intensity: number | null;
  sidewalk_provision: number | null;
  ada_ramp_access: number | null;
}
export interface RenterStop {
  stop_name: string | null;
  borough: string | null;
  n_routes: number | null;
  routes: string[];
  sbs: boolean;
  sai: number | null;
  sai_pctile: number | null;
  subscores: RenterStopSubscores;
  walkshed_population: number | null;
  am_trips: number | null;
  sheltered: boolean | null;
  dist_ft: number | null;
}
export interface RenterBuilding {
  bbl: string | null;
  address: string | null;
  units_res: number | null;
  units_total: number | null;
  year_built: number | null;
  num_floors: number | null;
  owner_name: string | null;
  bldg_class: string | null;
  land_use: string | null;
  dist_ft: number | null;
  hpd_open_violations: {
    total: number;
    class_a: number;
    class_b: number;
    class_c: number;
    class_i: number;
  };
  dob_permits_5y: number;
  dob_last_permit_date: string | null;
  landlord: { owner_name: string | null; portfolio_buildings: number | null } | null;
}
/** Isochrone reference. `geojson` on the live OTP path; `geometry_wkt` on the
 *  approximate res-8 grid fallback (approximate === true). */
export interface RenterIsochrone {
  source: "live_otp" | "precomputed_grid_res8" | "unavailable" | string;
  approximate: boolean;
  geojson?: unknown;
  geometry_wkt?: string;
  note?: string;
  jobs_reachable?: number | null;
  jobs_reachable_pct?: number | null;
}
export interface RenterAddressMeta {
  input: string;
  matched_label: string | null;
  lat: number;
  lon: number;
  bbl: string | null;
  bin: string | null;
  confidence: number | null;
  geocoder: string;
}
export interface RenterProfile {
  error?: string;
  query: {
    lat: number;
    lon: number;
    address: RenterAddressMeta | null;
    h3_res10: string | null;
    grid_cell_exact: boolean;
    populated_cell: boolean;
  };
  scores: RenterScores;
  transit: {
    bus_stops_within_400m: number;
    best_sai_within_400m: number | null;
    scheduled_am_trips_within_400m: number;
    nearest_subway: {
      name: string | null;
      borough: string | null;
      distance_ft: number | null;
      distance_mi: number | null;
    };
    nearest_stops_detail: RenterStop[];
  };
  flood: {
    stormwater_moderate_current: boolean;
    stormwater_extreme_2080: boolean;
    fema_firm_special_flood_hazard: boolean;
    fema_firm_zone: string | null;
    any_flag: boolean;
  };
  buildings_nearby: RenterBuilding[];
  isochrone_45min_8am: RenterIsochrone | null;
  disclaimer: string;
  sources: Record<string, string>;
  elapsed_ms: number;
}

export interface RentersQuery {
  lat?: number;
  lon?: number;
  address?: string;
}
export const getRentersProfile = (q: RentersQuery) => {
  const p = new URLSearchParams();
  if (q.address) p.set("address", q.address);
  else {
    if (q.lat != null) p.set("lat", String(q.lat));
    if (q.lon != null) p.set("lon", String(q.lon));
  }
  return getJSON<RenterProfile>("/api/renters/profile?" + p.toString());
};

/** Standalone transit isochrone (GeoJSON). Used for the 30/60-min on-demand
 *  variants layered over the profile's inline 45-min polygon. 503 -> throws. */
export const getIsochrone = (
  lat: number,
  lon: number,
  minutes: number,
  depart = "weekday_8am",
) => {
  const p = new URLSearchParams();
  p.set("lat", String(lat));
  p.set("lon", String(lon));
  p.set("minutes", String(minutes));
  p.set("depart", depart);
  return getJSON<{ type: string; features?: unknown[]; [k: string]: unknown }>(
    "/api/isochrone?" + p.toString(),
  );
};

/** SSE for live Marey tail. Returns an unsubscribe fn; callers also run a poll
 *  timer as a safety net (streamJSON here fails silently on unsupported envs). */
export const streamMarey = (
  route: string,
  direction: number,
  onData: (f: MareyStreamFrame) => void,
  onError?: () => void,
) => {
  const p = new URLSearchParams();
  p.set("route", route);
  p.set("direction", String(direction));
  return streamJSON<MareyStreamFrame>("/api/obs/marey/stream?" + p.toString(), onData, onError);
};

// ===========================================================================
// AUTO-STATS  (/api/autostats/*) — derived, plain-language bus statistics.
//
// These endpoints have existed and returned real data since 2026-07-25 with NO frontend
// consumer at all. Every one of them aggregates SERVER-SIDE and returns a finished,
// small payload: the client renders a table it was handed and never assembles one from
// data it had to hold (W13.2). Cost is O(views), never O(stops).
//
// There is deliberately NO day-of-week and NO week-over-week endpoint. The archive holds
// one observation per weekday and the single Tuesday is ~82% missing, so any weekday
// effect is confounded 1:1 with the calendar date. `/completeness` publishes the
// `not_supported` list with the reason for each, and it is worth rendering.
// ===========================================================================

/** The honesty stamp that rides on every derived payload. Depth counts QUALIFYING
 *  service days, not `date=` directories. */
export interface ArchiveMeta {
  archive_depth_days: number;
  qualifying_days: number;
  qualifying_dates: string[];
  partition_days: number;
  non_qualifying_days: number;
  excluded_dates: { date: string; reason: string; detail: string }[];
  preliminary: boolean;
  rankings_unlocked: boolean;
  depth_basis: string;
  gap_note?: string;
  depth_criteria?: Record<string, number | string>;
}
export interface CoverageStamp {
  archive_day_directories: number;
  equivalent_complete_days: number;
  complete_days: number;
  complete_day_list: string[];
  complete_day_rule: string;
  depth_note: string;
  excluded_local_hours_by_day?: Record<string, number[]>;
}
export interface RouteMeta {
  route_id: string;
  short_name: string;
  long_name: string;
  color: string;
  borough_code: string | null;
  borough: string;
  borough_basis: string;
}

// ---- /api/autostats/completeness -----------------------------------------
export interface CompletenessHour {
  rows: number;
  coverage_pct: number;
  status: "ok" | "partial" | "missing" | "known_gap" | "in_progress";
}
export interface CompletenessDay {
  archive_day_utc: string;
  hours: Record<string, CompletenessHour>;
  status_counts: Record<string, number>;
  coverage_pct_mean: number;
  equivalent_complete_days: number;
  complete: boolean;
  excluded_local_hours: number[];
  known_gaps: { start?: string; end?: string; reason?: string }[];
}
export interface CompletenessResponse {
  generated_at: string;
  feed: string;
  headline: string;
  equivalent_complete_days: number;
  equivalent_complete_days_method: string;
  complete_days: number;
  complete_day_list: string[];
  complete_day_rule: string;
  status_vocabulary: Record<string, string>;
  days: CompletenessDay[];
  not_supported?: { metric: string; status: string; reason: string; unblocks_at: string }[];
  archive?: ArchiveMeta;
  coverage?: CoverageStamp;
}
export const getCompleteness = () =>
  getJSON<CompletenessResponse>("/api/autostats/completeness");

// ---- /api/autostats/profile ----------------------------------------------
// The strongest evidence base on the platform: 619,814 published cells at
// route x direction x stop x hour. Hours are POOLED ACROSS DATES into 24 local-hour
// buckets — it is explicitly not a weekday profile, and the payload says so.
export interface ProfileHour {
  local_hour: number;
  suppressed: boolean;
  suppressed_reason?: string;
  n_headways: number;
  n_cells: number;
  n_days: number;
  n_routes?: number;
  n_stops?: number;
  median_headway_s: number | null;
  median_headway_min: number | null;
  sched_median_headway_min?: number | null;
  observed_over_scheduled?: number | null;
  median_headway_deviation_s?: number | null;
  headway_cv: number | null;
  bunched_gap_share: number | null;
}
export interface ProfileResponse {
  route: string | null;
  borough_code: string | null;
  borough: string | null;
  direction: number | null;
  grain: string;
  note: string;
  borough_note: string | null;
  suppression: { rule: string; [k: string]: number | string };
  hours: ProfileHour[];
  hours_published: number;
  hours_suppressed: number;
  n_headways_total: number;
  worst_hour: ProfileHour | null;
  best_hour: ProfileHour | null;
  archive: ArchiveMeta;
  coverage: CoverageStamp;
}
export const getProfile = (opts: { route?: string; borough?: string; direction?: number }) => {
  const p = new URLSearchParams();
  if (opts.route) p.set("route", opts.route);
  if (opts.borough) p.set("borough", opts.borough);
  if (opts.direction != null) p.set("direction", String(opts.direction));
  const qs = p.toString();
  return getJSON<ProfileResponse>("/api/autostats/profile" + (qs ? `?${qs}` : ""));
};

// ---- /api/autostats/boroughs ---------------------------------------------
export interface BoroughRow {
  borough_code: string;
  borough: string;
  n_routes_total: number;
  n_routes_observed: number;
  n_routes_qualifying: number;
  route_ids: string[];
  median_headway_min: number | null;
  sched_median_headway_min: number | null;
  median_headway_cv: number | null;
  median_bunched_gap_share: number | null;
  median_headway_deviation_s: number | null;
  median_hours_observed_per_route: number | null;
  most_bunched_routes: {
    route_id: string;
    short_name: string;
    bunched_gap_share: number;
    hours_observed: number;
    n_headways: number;
  }[];
}
export interface BoroughsResponse {
  generated_at: string;
  borough_basis: string;
  borough_note: string;
  normalisation_note: string;
  rollup_statistic: string;
  totals: {
    n_routes_in_catalog: number;
    n_routes_assigned: number;
    n_routes_unassigned_fallback: number;
    sums_to_catalog: boolean;
    by_borough: Record<string, number>;
  };
  suppression: { rule: string; [k: string]: number | string };
  boroughs: BoroughRow[];
  archive: ArchiveMeta;
  coverage: CoverageStamp;
}
export const getBoroughRollups = () => getJSON<BoroughsResponse>("/api/autostats/boroughs");

// ---- /api/autostats/route/{id}/slowspots ---------------------------------
// ⚠️ NAMED `SlowSpot*`, NOT `Slow*`. `SlowSegment` is ALREADY declared above for the
// route dossier, with a different shape (`wt_speed_mph`). Two `interface SlowSegment`
// declarations in one module do not collide — TypeScript MERGES them — so a second
// declaration here would silently produce a type demanding the union of both field sets
// while the endpoint emits only one. tsc stays green and every consumer reading the
// wrong spelling gets `undefined` at runtime. Distinct names instead.
//
// Field names below are taken from the live payload, not assumed.
export interface SlowSpotSegment {
  from_stop: string;
  to_stop: string;
  /** Trip-weighted peak through-speed. Named as the source names it. */
  wt_speed_mph: number | null;
  n_trips: number | null;
  seg_miles: number | null;
  /** 0 at this route's slowest segment, 1 at its fastest. */
  speed_pctile_within_route?: number | null;
  /** This segment's speed as a share of the route's own median. */
  vs_route_median?: number | null;
  coords?: number[][] | null;
}
export interface SlowSpotBin {
  direction_id: number | null;
  seg_bin: number;
  offset_from_ft: number;
  offset_to_ft: number;
  n_observations: number;
  from_stop: string | null;
  to_stop: string | null;
  stops_in_bin: number;
  /** The bin sits past the end of the shape most trips use, so no stop name attaches. */
  beyond_labelling_shape: boolean;
  suppressed: boolean;
  median_speed_fps: number | null;
  median_speed_mph: number | null;
  vs_route_median: number | null;
}
export interface SlowSpotsResponse {
  route: string;
  meta: RouteMeta;
  generated_at: string;
  route_median_speed_mph: number | null;
  route_observed_median_speed_mph: number | null;
  route_observed_n: number | null;
  stop_pair_segments: {
    source: string;
    method: string;
    n_segments: number;
    slowest_10: SlowSpotSegment[];
    segments: SlowSpotSegment[];
  };
  observed_half_mile_bins: {
    source: string;
    method: string;
    caveat: string;
    seg_bin_ft: number;
    n_bins: number;
    n_bins_published: number;
    n_bins_suppressed: number;
    min_observations: number;
    slowest_10: SlowSpotBin[];
    bins: SlowSpotBin[];
  };
  archive: ArchiveMeta;
  coverage: CoverageStamp;
}
export const getSlowSpots = (routeId: string) =>
  getJSON<SlowSpotsResponse>(
    `/api/autostats/route/${encodeURIComponent(routeId)}/slowspots`,
  );

// ---- /api/autostats/route/{id}/today -------------------------------------
export interface RouteTodayResponse {
  route: string;
  meta: RouteMeta;
  date: string;
  verdict: string | null;
  verdict_rule?: string;
  headline?: string;
  n_headways?: number;
  [k: string]: unknown;
}
export const getRouteToday = (routeId: string, date?: string) => {
  const p = new URLSearchParams();
  if (date) p.set("date", date);
  const qs = p.toString();
  return getJSON<RouteTodayResponse>(
    `/api/autostats/route/${encodeURIComponent(routeId)}/today` + (qs ? `?${qs}` : ""),
  );
};

// ---- /api/autostats/ladder — THE ROUTE LADDER ----------------------------
// An ordered stop list with live buses interleaved at their true along-route position.
// Bunching becomes legible AT A GLANCE with no statistic to defend — two vehicle rows
// between the same pair of stops. Pure rendering of data already held.
//
// Per direction, NEVER averaged across directions: the two directions of a route do not
// even use the same stops.
export interface LadderOccupancy {
  captured: boolean;
  not_captured?: string;
  status: number | null;
  status_label: string | null;
  passenger_count: number | null;
  passenger_capacity: number | null;
  load_pct: number | null;
  basis?: string;
}
export interface LadderVehicle {
  vehicle_id: string;
  trip_id: string | null;
  route_offset_ft: number;
  frac_along_route: number | null;
  after_stop_index: number;
  between: {
    prev_stop_id: string | null;
    prev_stop_name: string | null;
    next_stop_id: string | null;
    next_stop_name: string | null;
  };
  distance_to_next_stop_ft: number | null;
  distance_to_next_stop_miles: number | null;
  stops_away_from_next_stop: number | null;
  /** MTA Bus Time's own degrading vocabulary: "at stop" / "approaching" /
   *  "< 1 stop away" / "N stops away" / "N.N miles away". Beyond 2 stops the stop count
   *  is DELIBERATELY dropped for a mileage. */
  presentable_distance: string;
  bearing: number | null;
  timestamp: number | null;
  age_s: number | null;
  speed_est_mph: number | null;
  speed_basis: string | null;
  eta_next_stop_min_est: number | null;
  gap_to_vehicle_ahead_ft: number | null;
  gap_to_vehicle_behind_ft: number | null;
  bunched_with: string[];
  /** Crowding where the bus reports it. `captured:false` carries the REASON — at ~50%
   *  fleet coverage a blank must never read as "empty bus". */
  occupancy: LadderOccupancy;
  /** MTA's OWN schedule deviation for this trip (GTFS-RT TripUpdate.delay), seconds,
   *  positive = late. NOT this platform's reconstructed adherence — `mta_delay_basis`
   *  names it so the two can never be confused. null = not published for this trip
   *  right now, which is NOT the same as on time. */
  mta_delay_s: number | null;
  mta_delay_min: number | null;
  mta_delay_basis: string | null;
  mta_delay_absent_reason: string | null;
}
export interface LadderStop {
  index: number;
  stop_id: string;
  stop_name: string;
  stop_seq: number;
  offset_ft: number;
  /** Surveyed coordinates, joined server-side, so a ladder row is the SAME entity as a
   *  stop dot on the map and clicking it does the same thing. */
  lat: number | null;
  lon: number | null;
  spacing_from_prev_ft: number | null;
  vehicles_after_this_stop: string[];
  next_vehicle: {
    vehicle_id: string;
    distance_ft: number;
    distance_miles: number;
    stops_away: number;
    presentable_distance: string;
    eta_min_est: number | null;
    eta_basis: string | null;
  } | null;
}
export interface LadderDirection {
  direction_id: number;
  shape_id: string;
  shape_length_ft: number | null;
  n_stops: number;
  n_vehicles: number;
  n_bunched_pairs: number;
  bunched_pairs: {
    leader_vehicle_id: string;
    follower_vehicle_id: string;
    gap_ft: number;
    gap_miles: number;
    between_stops: (string | null)[];
  }[];
  stops: LadderStop[];
  vehicles: LadderVehicle[];
}
export interface LadderResponse {
  route: string;
  meta: RouteMeta;
  generated_at: string;
  error?: string;
  live: {
    as_of: number | null;
    age_s: number | null;
    source: string;
    stale: boolean;
    vehicles_on_route: number;
    vehicles_placed_on_ladder: number;
    /** Buses whose along-shape offset was WITHHELD (GPS off the shape, or a backward
     *  jump). Counted here, never guessed onto the ladder. */
    vehicles_unplaced: number;
    unplaced_reason: string;
  };
  crowding: {
    vehicles_on_ladder: number;
    vehicles_reporting_occupancy: number;
    vehicles_reporting_headcount: number;
    coverage_pct: number | null;
    median_passengers: number | null;
    not_captured_note: string;
  };
  mta_delay: {
    vehicles_with_published_delay: number;
    coverage_pct: number | null;
    median_delay_s: number | null;
    median_delay_min: number | null;
    source: string;
    as_of: number | null;
    stale: boolean;
    basis: string;
    basis_note: string;
    absent_note: string;
  };
  directions: LadderDirection[];
  direction_labelling: string;
  vocabulary: Record<string, string>;
  vocabulary_note: string;
  eta_note: string;
  bunching_note: string;
  archive: ArchiveMeta;
  coverage: CoverageStamp;
}
export const getLadder = (routeId: string, direction?: number) => {
  const p = new URLSearchParams();
  p.set("route", routeId);
  if (direction != null) p.set("direction", String(direction));
  return getJSON<LadderResponse>("/api/autostats/ladder?" + p.toString());
};

// ---- /api/autostats/spacing — CORRIDOR STOP SPACING ----------------------
// Measuring two stops answers one question; seeing every consecutive gap along a route
// at once answers the question underneath it — where is this route's spacing wrong?
//
// STATIC GEOMETRY. Not limited by archive depth, and genuinely precise (surveyed stop
// coordinates, ~0.3-0.4 ft) unlike anything derived from live vehicle positions.
export interface SpacingGap {
  index: number;
  from_stop_id: string;
  from_stop_name: string;
  from_stop_seq: number;
  to_stop_id: string;
  to_stop_name: string;
  to_stop_seq: number;
  from_offset_ft: number | null;
  to_offset_ft: number | null;
  spacing_ft: number | null;
  spacing_miles: number;
  deviation_from_median_ft?: number | null;
  /** Distribution-relative, against THIS direction's own gaps — never an external
   *  spacing standard, which this platform does not hold. */
  flag?: "long" | "short" | "typical" | "not_flagged";
}
export interface SpacingDirection {
  direction_id: number;
  shape_id: string;
  shape_length_ft: number | null;
  n_stops: number;
  stats: {
    n_gaps: number;
    median_ft?: number | null;
    median_miles?: number | null;
    mean_ft?: number | null;
    min_ft?: number | null;
    max_ft?: number | null;
    p10_ft?: number | null;
    q1_ft?: number | null;
    q3_ft?: number | null;
    p90_ft?: number | null;
    iqr_ft?: number | null;
    total_ft?: number | null;
    total_miles?: number | null;
  };
  fences: {
    rule: string;
    min_gaps_to_flag: number;
    applied: boolean;
    short_below_ft?: number | null;
    short_fence_note?: string | null;
    long_above_ft?: number | null;
    not_applied_reason?: string;
  };
  flag_counts: Record<string, number>;
  longest: SpacingGap[];
  shortest: SpacingGap[];
  gaps: SpacingGap[];
}
export interface SpacingResponse {
  route: string;
  meta: RouteMeta;
  generated_at: string;
  error?: string;
  basis: string;
  method: string;
  per_direction_note: string;
  precision_note: string;
  depth_note: string;
  directions: SpacingDirection[];
}
export const getSpacing = (routeId: string, direction?: number) => {
  const p = new URLSearchParams();
  p.set("route", routeId);
  if (direction != null) p.set("direction", String(direction));
  return getJSON<SpacingResponse>("/api/autostats/spacing?" + p.toString());
};
/** Server-assembled table of every consecutive gap. CSV / XLSX / Parquet — no JSON,
 *  per the estate's download standard. Provenance travels INSIDE the file. */
export const spacingExportUrl = (
  routeId: string,
  format: "csv" | "xlsx" | "parquet",
  direction?: number,
) => {
  const p = new URLSearchParams();
  p.set("route", routeId);
  p.set("format", format);
  if (direction != null) p.set("direction", String(direction));
  return API_BASE + "/api/autostats/spacing?" + p.toString();
};

// ===========================================================================
// SUBWAY DERIVED STATISTICS  (/api/subwaystats/*)
//
// 250k+ derived cells over 30 routes and 518 stations, from gaps between observed
// STOPPED_AT arrival events. Derived 2026-07-25, read by nothing until now.
//
// THE HONESTY LINE, and it is absolute: there is NO subway schedule deviation and NO
// subway bunching here, because realtime subway `trip_id` does not join GTFS static
// (0 of 8,040 exact matches). The derivation writes those columns NULL on 100% of cells
// and the API re-verifies that on every refresh. An OBSERVED GAP needs no schedule; a
// deviation or a bunching index does. Never label one as the other.
// ===========================================================================
export interface SubwayProfileHour {
  local_hour: number;
  suppressed: boolean;
  suppressed_reason?: string;
  n_headways: number;
  n_cells: number;
  n_days?: number;
  median_headway_s: number | null;
  median_headway_min: number | null;
  headway_cv: number | null;
  median_dwell_s: number | null;
  /** Share of dwell observations that are censored lower bounds (single-poll runs). A
   *  dwell median without this beside it is misleading. */
  dwell_censored_share: number | null;
}
export interface SubwayProfileResponse {
  route: string | null;
  station: string | null;
  direction: string | null;
  grain: string;
  note: string;
  suppression: Record<string, number | string>;
  hours: SubwayProfileHour[];
  hours_published: number;
  hours_suppressed: number;
  n_headways_total: number;
  archive: Record<string, unknown>;
  coverage: Record<string, unknown>;
  [k: string]: unknown;
}
export const getSubwayProfile = (opts: {
  route?: string;
  station?: string;
  direction?: string;
}) => {
  const p = new URLSearchParams();
  if (opts.route) p.set("route", opts.route);
  if (opts.station) p.set("station", opts.station);
  if (opts.direction) p.set("direction", opts.direction);
  const qs = p.toString();
  return getJSON<SubwayProfileResponse>("/api/subwaystats/profile" + (qs ? `?${qs}` : ""));
};
// Field names taken FROM the live payload, not assumed. (An earlier draft of this type
// guessed `n_published` / `n_suppressed` / `n_arrivals`; the endpoint emits
// `n_routes_published` / `n_routes_suppressed` / `n_arrival_events`. TypeScript cannot
// catch a key that is merely absent at runtime, so a guessed name reads `undefined`
// forever and silently renders a blank.)
export interface SubwayRouteRow {
  route_id: string;
  feed?: string;
  suppressed?: boolean;
  suppressed_reason?: string;
  n_stations: number | null;
  n_cells: number | null;
  n_headways: number | null;
  n_arrival_events: number | null;
  n_arrival_events_note?: string;
  n_arrivals_in_published_cells?: number | null;
  n_trips_observed?: number | null;
  n_days_observed?: number | null;
  n_directions?: number | null;
  median_headway_min: number | null;
  headway_cv: number | null;
  /** A CENSORED LOWER BOUND — never render it without `dwell_censored_share`. */
  median_dwell_s: number | null;
  dwell_censored_share: number | null;
  hours_observed: number | null;
}
export interface SubwayRoutesResponse {
  routes: SubwayRouteRow[];
  mode: string;
  n_routes: number;
  n_routes_published: number;
  n_routes_suppressed: number;
  rollup_statistic: string;
  dwell_note: string;
  direction_note: string;
  withheld_here?: unknown;
  withheld_reason: string;
  suppression: Record<string, number | string>;
  totals?: Record<string, unknown>;
  archive: Record<string, unknown>;
  [k: string]: unknown;
}
export const getSubwayRoutes = () => getJSON<SubwayRoutesResponse>("/api/subwaystats/routes");
export const getSubwayCompleteness = () =>
  getJSON<Record<string, unknown>>("/api/subwaystats/completeness");
export const getSubwayStationStats = (stationId: string) =>
  getJSON<Record<string, unknown>>(
    `/api/subwaystats/station/${encodeURIComponent(stationId)}`,
  );
export const getSubwayRuns = (route?: string) => {
  const p = new URLSearchParams();
  if (route) p.set("route", route);
  const qs = p.toString();
  return getJSON<Record<string, unknown>>("/api/subwaystats/runs" + (qs ? `?${qs}` : ""));
};
/** Server-assembled table for any subwaystats surface. No JSON download. */
export const subwayStatsExportUrl = (
  path: "profile" | "routes" | "runs",
  format: "csv" | "xlsx" | "parquet",
  params: Record<string, string | number | undefined> = {},
) => {
  const p = new URLSearchParams();
  p.set("format", format);
  for (const [k, v] of Object.entries(params)) if (v != null) p.set(k, String(v));
  return API_BASE + `/api/subwaystats/${path}?` + p.toString();
};

// ===========================================================================
// /api/rt/delay — MTA'S OWN schedule deviation (GTFS-RT TripUpdate.delay).
//
// The agency publishes trip-level adherence directly, at ~100% coverage on the bus
// tripUpdates feed, and this platform discarded all of it until now. It is NOT the
// derived adherence statistic: `basis` is on the payload so a consumer cannot conflate
// them, and a trip with no published delay is COUNTED as absent, never defaulted to 0.
// ===========================================================================
export interface DelayRouteRow {
  route_id: string;
  n_trips: number;
  median_delay_s: number | null;
  median_delay_min: number | null;
  share_late: number;
}
export interface TripDelaySummary {
  as_of: number | null;
  age_s: number | null;
  source: "archive" | "live" | "none";
  stale: boolean;
  basis: string;
  basis_note: string;
  absent_note: string;
  trips_with_delay: number;
  trips_seen: number;
  trips_without_delay: number;
  coverage_pct: number | null;
  median_delay_s: number | null;
  median_delay_min: number | null;
  p10_delay_s: number | null;
  p90_delay_s: number | null;
  min_delay_s: number | null;
  max_delay_s: number | null;
  share_late: number | null;
  share_early: number | null;
  share_more_than_10_min_late: number | null;
  very_late_threshold_s: number;
  route_ranking_rule: string;
  min_route_trips: number;
  routes_ranked: number;
  latest_routes: DelayRouteRow[];
  earliest_routes: DelayRouteRow[];
  unavailable_reason?: string;
}
export const getTripDelay = (top = 10) =>
  getJSON<TripDelaySummary>(`/api/rt/delay?top=${top}`);
