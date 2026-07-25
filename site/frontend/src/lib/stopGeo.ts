// W11 — stop geodesy + the O(1) snap index behind the Planner Workstation's stop
// cards and the measure tool.
//
// TWO HARD RULES, both from `analysis/MEASURE_DISTANCE_DESIGN_20260725.md`:
//
//  1. **Geodesic, never pixels.** A Web-Mercator pixel distance is wrong by ~30 % at
//     NYC's latitude — a silent correctness bug, not a rounding question. Distances
//     here come from a local-radius equirectangular reduction of WGS84 (§ feetBetween),
//     which is exact to well under a foot at stop-spacing scale.
//
//  2. **Static geometry only.** Stop coordinates are uniformly 6 decimal places
//     (measured: 1,825/1,825 Manhattan stops) ≈ 0.3–0.4 ft at NYC latitude. Live
//     vehicle positions carry a ~160–200 ft floor. These two must NEVER be mixed:
//     nothing in this module ever sees a vehicle position.
//
// COST CONTRACT (the W12 freeze is 24 hours old — see CONTINUOUS_STATE.json):
//   * the index is built ONCE per selection change (~2k inserts, from data already in
//     browser memory) and queried in O(1) against 9 neighbouring cells;
//   * nothing here binds an event listener, touches the DOM, or runs per frame.

// ---------------------------------------------------------------------------
// Geodesy
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;
// WGS84
const WGS84_A = 6378137.0; // semi-major axis, metres
const WGS84_E2 = 0.00669437999014; // first eccentricity squared
const M_TO_FT = 1 / 0.3048;
const FT_PER_MILE = 5280;

/**
 * Geodesic distance in FEET between two [lat, lon] points.
 *
 * Local-radius equirectangular reduction: at the midpoint latitude we take WGS84's
 * true meridional radius M and normal radius N, then measure dy = M·dφ and
 * dx = N·cos(φ)·dλ. Over stop-spacing distances (metres to a few miles) this agrees
 * with a full geodesic (Vincenty) to better than 1e-4 %, i.e. far inside the ~0.3 ft
 * precision of the stop coordinates themselves.
 *
 * We do NOT use plain haversine with a mean earth radius: that carries up to ~0.3 %
 * scale error, which is ±22 ft on a 7,500 ft measurement — worse than the data.
 */
export function feetBetween(a: readonly [number, number], b: readonly [number, number]): number {
  const phi = ((a[0] + b[0]) / 2) * RAD;
  const s = Math.sin(phi);
  const w2 = 1 - WGS84_E2 * s * s;
  const w = Math.sqrt(w2);
  const nRad = WGS84_A / w; // normal (prime vertical) radius
  const mRad = (WGS84_A * (1 - WGS84_E2)) / (w2 * w); // meridional radius
  const dy = mRad * (b[0] - a[0]) * RAD;
  const dx = nRad * Math.cos(phi) * (b[1] - a[1]) * RAD;
  return Math.sqrt(dx * dx + dy * dy) * M_TO_FT;
}

/** Cheap squared metric for nearest-neighbour ranking only (never displayed). */
function approxFtSq(alat: number, alon: number, blat: number, blon: number): number {
  const dy = (blat - alat) * 364000; // ft per degree latitude (NYC, ±0.1 %)
  const dx = (blon - alon) * 276000; // ft per degree longitude at 40.75°N
  return dx * dx + dy * dy;
}

/**
 * Round a distance to the nearest 10 ft. A deliberate honesty call: the geometry is
 * good to ~0.4 ft, but a GTFS stop coordinate is ONE surveyed point standing for a
 * ~40-foot bus-stop zone on the street. `7,512 ft` would claim a precision the
 * *concept* cannot carry even though the arithmetic could. `7,510 ft` is honest.
 */
export function round10(ft: number): number {
  return Math.round(ft / 10) * 10;
}

/**
 * Both units at once, feet primary — the majority convention (Google `2.53 mi
 * (4.07 km)`, leaflet-measure `1,374 Feet (0.26 Miles)`, OSM's own scale bar). There
 * is deliberately NO unit toggle: Esri's 13-option unit dropdown is right for a GIS
 * analyst matching a project CRS and wrong for a planner who wants the number.
 * Feet lead because the working unit at stop-spacing scale is feet.
 */
export function fmtDistance(ft: number): string {
  const r = round10(ft);
  const mi = ft / FT_PER_MILE;
  return `${r.toLocaleString()} ft (${mi.toFixed(2)} mi)`;
}

/** Feet only, rounded to 10 — for the compact per-leg labels drawn on the geometry. */
export function fmtFeet(ft: number): string {
  return `${round10(ft).toLocaleString()} ft`;
}

/** Cumulative straight-line length (ft) of a chain of [lat, lon] points. */
export function chainFeet(pts: readonly (readonly [number, number])[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += feetBetween(pts[i - 1], pts[i]);
  return total;
}

// ---------------------------------------------------------------------------
// The snap index
// ---------------------------------------------------------------------------

export type StopKind = "bus" | "subway";

/** One DISTINCT snappable stop. The map draws one marker per (route, stop) — 3,193
 *  markers over only 2,033 distinct Bronx stops — so the index is built over stops,
 *  not markers, and carries every route that serves it. */
export interface SnapStop {
  /** Namespaced so a bus stop_id can never collide with a subway station id. */
  key: string;
  stopId: string;
  name: string;
  lat: number;
  lon: number;
  kind: StopKind;
  /** Every selected route/line serving this stop, in selection order. */
  routes: string[];
}

// ~0.0025° cells ≈ 910 ft N–S × 690 ft E–W at NYC latitude. The SHORTER of the two
// (east–west, because a degree of longitude is only cos(40.75°) as long) is what bounds
// correctness: a 3×3 neighbourhood is exhaustive for any radius up to that.
//
// Occupancy check, so the O(1) claim is not a hope: 2,033 distinct Bronx stops over
// ~42 sq mi is roughly one stop per cell, so a query examines ~10 candidates however
// many routes are selected. Cells are sized for correctness first and occupancy second.
const CELL = 0.0025;
/** The exhaustive-search guarantee of a single-ring (3×3) lookup, in feet. */
export const SNAP_MAX_FT = 660;
const CELL_MIN_FT = 690; // east–west cell extent at NYC latitude
const cellKey = (lat: number, lon: number) =>
  Math.round(lat / CELL) * 100000 + Math.round(lon / CELL);

export class StopSnapIndex {
  private grid = new Map<number, SnapStop[]>();
  private byKey = new Map<string, SnapStop>();
  /** Distinct stops indexed (the honest count — not the marker count). */
  readonly size: number = 0;

  constructor(stops: SnapStop[]) {
    for (const s of stops) {
      this.byKey.set(s.key, s);
      const k = cellKey(s.lat, s.lon);
      const bucket = this.grid.get(k);
      if (bucket) bucket.push(s);
      else this.grid.set(k, [s]);
    }
    this.size = this.byKey.size;
  }

  get(key: string): SnapStop | undefined {
    return this.byKey.get(key);
  }

  /**
   * Nearest stop to [lat, lon] within `maxFt`, or null. O(1) at any radius the caller
   * should be using: one ring (9 cells) is exhaustive up to SNAP_MAX_FT, and the ring
   * only widens if a caller asks for more than a cell's worth of reach — which the
   * workstation never does, because it clamps the radius before calling.
   * Ties are broken by `stopId` so the same click always yields the same stop.
   */
  nearest(lat: number, lon: number, maxFt: number): SnapStop | null {
    const li = Math.round(lat / CELL);
    const oi = Math.round(lon / CELL);
    const maxSq = maxFt * maxFt;
    const ring = Math.max(1, Math.ceil(maxFt / CELL_MIN_FT));
    let best: SnapStop | null = null;
    let bestSq = Infinity;
    for (let di = -ring; di <= ring; di++) {
      for (let dj = -ring; dj <= ring; dj++) {
        const bucket = this.grid.get((li + di) * 100000 + (oi + dj));
        if (!bucket) continue;
        for (const s of bucket) {
          const d = approxFtSq(lat, lon, s.lat, s.lon);
          if (d > maxSq) continue;
          if (d < bestSq || (d === bestSq && best && s.stopId < best.stopId)) {
            best = s;
            bestSq = d;
          }
        }
      }
    }
    return best;
  }
}

/** Empty index — the zero-cost state when nothing is selected. */
export const EMPTY_SNAP_INDEX = new StopSnapIndex([]);

/**
 * Add a stop to the persistent selection, or remove it if it is already there, keeping
 * the list at or under `cap` by evicting the OLDEST.
 *
 * Two rules in one function, deliberately:
 *   * click-a-point-to-remove — the strongest convention in the study, reached
 *     independently by Google and MapLibre, and here it doubles as "close this card" so
 *     there is one rule to learn, not two;
 *   * a hard cap with oldest-evicted (decision N9). Unbounded accumulating DOM is the
 *     exact failure mode the workstation freeze was, and this feature does not get to
 *     reintroduce it. The count is always on screen so the eviction is never a surprise.
 */
export function toggleCapped<T extends { key: string }>(prev: T[], item: T, cap: number): T[] {
  const at = prev.findIndex((x) => x.key === item.key);
  if (at >= 0) return prev.filter((x) => x.key !== item.key);
  const next = [...prev, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Build the distinct-stop index from data ALREADY in browser memory: the per-route
 * shape cache the map draws from, plus the subway station catalog. No fetch, no new
 * data, no marker traversal.
 */
export function buildSnapIndex(
  routeOrder: readonly string[],
  shapes: Map<string, { stops: { stop_id: string; stop_name: string; lat: number; lon: number }[] }>,
  lineOrder: readonly string[],
  stations: { id: string; name: string; lat: number; lon: number; routes: string[] }[] | null,
  lineKeyOf: (route: string | null) => string,
): StopSnapIndex {
  const out = new Map<string, SnapStop>();
  for (const routeId of routeOrder) {
    const shape = shapes.get(routeId);
    if (!shape) continue;
    for (const st of shape.stops) {
      const key = "b:" + st.stop_id;
      const cur = out.get(key);
      if (cur) {
        if (!cur.routes.includes(routeId)) cur.routes.push(routeId);
        continue;
      }
      out.set(key, {
        key,
        stopId: st.stop_id,
        name: st.stop_name,
        lat: st.lat,
        lon: st.lon,
        kind: "bus",
        routes: [routeId],
      });
    }
  }
  if (stations && lineOrder.length) {
    const sel = new Set(lineOrder);
    for (const st of stations) {
      const serving = st.routes.filter((r) => sel.has(lineKeyOf(r)));
      if (!serving.length) continue;
      const key = "s:" + st.id;
      if (out.has(key)) continue;
      out.set(key, {
        key,
        stopId: st.id,
        name: st.name,
        lat: st.lat,
        lon: st.lon,
        kind: "subway",
        // every line the station serves, not just the selected ones — a planner
        // needs to know it is a transfer point.
        routes: st.routes.slice(),
      });
    }
  }
  return new StopSnapIndex([...out.values()]);
}
