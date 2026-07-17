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
