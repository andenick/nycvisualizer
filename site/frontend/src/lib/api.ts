// Typed client for the nycvisualizer FastAPI backend.
// The browser talks ONLY to this backend — never to MTA/Socrata directly, and
// never sees any server-side key. Base URL is same-origin by default (dev proxy
// or same host in prod); override with VITE_API_BASE for a split deploy.

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
}
export interface VehiclesResponse {
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
}
export interface SubwayResponse {
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

export const getVehicles = () => getJSON<VehiclesResponse>("/api/rt/vehicles");
export const getRoutes = () => getJSON<RouteInfo[]>("/api/routes");
export const getRouteShape = (routeId: string) =>
  getJSON<RouteShape>(`/api/routes/${encodeURIComponent(routeId)}`);
export const getAlerts = () => getJSON<AlertsResponse>("/api/rt/alerts");
export const getArrivals = (stopId: string) =>
  getJSON<{ stop_id: string; arrivals: { route: string; headsign: string; eta_seconds: number | null; stops_away: number | null }[] }>(
    `/api/stops/${encodeURIComponent(stopId)}/arrivals`,
  );

export const getSubway = () => getJSON<SubwayResponse>("/api/rt/subway");
export const getStations = () => getJSON<StationInfo[]>("/api/stations");
export const getStationArrivals = (stationId: string) =>
  getJSON<StationArrivals>(`/api/stations/${encodeURIComponent(stationId)}/arrivals`);

/** Generic SSE subscription. Returns an unsubscribe fn.
 *  Falls back silently — callers also run a poll timer as a safety net. */
function streamJSON<T>(path: string, onData: (v: T) => void, onError?: () => void): () => void {
  let es: EventSource | null = null;
  try {
    es = new EventSource(API_BASE + path);
    es.onmessage = (ev) => {
      try {
        onData(JSON.parse(ev.data) as T);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => {
      onError?.();
    };
  } catch {
    onError?.();
  }
  return () => es?.close();
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
  median_headway_min: number | null;
  median_deviation_s: number | null;
  median_abs_deviation_s: number | null;
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
  most_reliable: LeagueReliableRow[];
  least_reliable: LeagueReliableRow[];
  slowest_corridors: LeagueSlowRow[];
  most_improved_vs_schedule: LeagueImprovedRow[];
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

// ===========================================================================
// Live Ops Wall (S6) — /api/wall
// ===========================================================================
export interface WallHotspot {
  lat: number;
  lon: number;
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
    service_ratio: number | null;
    bunching: WallBunching;
    alerts: {
      high: number;
      medium: number;
      low: number;
      total: number;
      as_of: number | null;
      items: WallAlertItem[];
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
