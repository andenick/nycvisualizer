// Lazy, LRU-bounded cache of route SHAPE geometry for the Ant Farm v3 motion model.
//
// The motion client (VehicleFlowLayer) glides each bus ALONG its route shape from the
// backend's `route_offset_ft` (distance travelled, in feet). To place a bus at an offset
// it needs the polyline the offset is measured against + a cumulative-offset array for an
// O(log n) offset→point lookup. That geometry comes from /api/rt/route_shapes (one small
// call per route, covering all its directions).
//
// This cache:
//   * keys stored geometry by shape_id (the field each bus carries), so a bus resolves its
//     own shape directly regardless of which direction/route variant it's on;
//   * fetches lazily, ONCE per route, deduped, and only for routes that are actually visible
//     (the layer calls ensure() for the shape_ids it sees this snapshot);
//   * is LRU-bounded — but sized for the WHOLE live fleet, not one viewport. The ant-farm
//     ingests EVERY vehicle each snapshot (not just on-screen ones) and calls ensure() for
//     each, so a viewport-sized cap (the old 50) thrashed hard: the NYC bus fleet spans ~550
//     distinct shape_ids across ~285 routes, so 50 evicted ~90% of shapes every snapshot,
//     bouncing buses OFF the shape path onto the straight glide — which defeated the whole
//     dead-reckoning model (no continuous motion → the synchronized poll pulse survived) and
//     starved the between-tick predErr ring. Sizing the cap above the fleet's shape count
//     keeps every bus stably dead-reckoning along its shape. Each shape is tiny (~20-90
//     decimated vertices ≈ ~2 KB), so the full fleet resident is ~1-2 MB, and each route is
//     fetched ONCE instead of re-fetched on every eviction (fewer requests, not more).
//     (motion-continuity study C1, 2026-07-24)
//
// Never throws to callers: a failed fetch clears the route's in-flight flag so a later
// snapshot retries; buses whose shape isn't loaded yet keep the straight glide meanwhile.

import { getRouteShapesRT } from "./api";

export interface OffsetPoly {
  /** decimated [lat, lon] vertices */
  pts: [number, number][];
  /** cumulative full-shape offset (ft) at each vertex — parallel to `pts` */
  cumFt: number[];
  /** total shape length (ft) */
  lenFt: number;
}

const LRU_MAX = 1200; // > the ~550-shape live fleet, with headroom for trip/shape churn (~2 MB)

export class RouteShapeCache {
  // Map preserves insertion order → we use it as an LRU (re-insert on touch, evict oldest).
  private _byShape = new Map<string, OffsetPoly>();
  // routeId → "pending" while a fetch is in flight, or the shape_ids it produced (done).
  private _routeState = new Map<string, "pending" | string[]>();

  /** Currently-cached geometry for a shape_id, or undefined. LRU-touches on hit. */
  get(shapeId: string | null | undefined): OffsetPoly | undefined {
    if (!shapeId) return undefined;
    const p = this._byShape.get(shapeId);
    if (p) {
      this._byShape.delete(shapeId);
      this._byShape.set(shapeId, p); // move to most-recent
    }
    return p;
  }

  /** Ensure `routeId`'s shapes are loaded. Idempotent + deduped; fire-and-forget. Re-fetches
   *  a route whose shapes were LRU-evicted so an evicted-then-revisited route recovers. */
  ensure(routeId: string | null | undefined): void {
    if (!routeId) return;
    const st = this._routeState.get(routeId);
    if (st === "pending") return;
    if (Array.isArray(st) && st.every((sid) => this._byShape.has(sid))) return; // done + present
    this._routeState.set(routeId, "pending");
    getRouteShapesRT(routeId)
      .then((r) => {
        const ids: string[] = [];
        for (const d of r.directions) {
          if (!d.shape_id || !d.polyline?.length || !d.offset_ft?.length) continue;
          if (d.polyline.length !== d.offset_ft.length) continue; // contract guard
          this._put(d.shape_id, { pts: d.polyline, cumFt: d.offset_ft, lenFt: d.shape_len_ft });
          ids.push(d.shape_id);
        }
        this._routeState.set(routeId, ids);
      })
      .catch(() => {
        this._routeState.delete(routeId); // allow a later snapshot to retry
      });
  }

  private _put(shapeId: string, poly: OffsetPoly): void {
    if (this._byShape.has(shapeId)) this._byShape.delete(shapeId);
    this._byShape.set(shapeId, poly);
    while (this._byShape.size > LRU_MAX) {
      const oldest = this._byShape.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this._byShape.delete(oldest);
    }
  }

  /** Diagnostic (for the ?perf hook). */
  stats() {
    return { shapes: this._byShape.size, routes: this._routeState.size, max: LRU_MAX };
  }
}

/** Binary-search a cumulative-offset array for the vertex pair bracketing `off` and
 *  linearly interpolate the [lat, lon] point at that offset. O(log n). */
export function pointAtOffset(poly: OffsetPoly, off: number): [number, number] {
  const { pts, cumFt } = poly;
  const n = pts.length;
  if (n === 1 || off <= cumFt[0]) return pts[0];
  const total = cumFt[n - 1];
  if (off >= total) return pts[n - 1];
  let lo = 0,
    hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cumFt[mid] <= off) lo = mid;
    else hi = mid;
  }
  const seg = cumFt[hi] - cumFt[lo] || 1;
  const t = (off - cumFt[lo]) / seg;
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t];
}
