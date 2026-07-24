// nycviz-flow — shape/offset geometry: cumulative-length walks along polylines.
//
// Two offset→point walks power the ant farm's "along the real track/road" motion:
//   * pointAtDist  — walk a subway inter-station worm segment by METERS   [VehicleFlowLayer L171-185]
//   * pointAtOffset — walk a bus route shape by FEET (lives in lib/shapeCache, re-exported here)
// Both binary-search a cumulative-length array (O(log n)) and linearly interpolate the
// bracketing vertex pair. buildSegCum builds the meters-cumulative array for a worm.

import { metersBetween } from "./project";
export { pointAtOffset } from "../lib/shapeCache";
export type { OffsetPoly } from "../lib/shapeCache";

/** Point at cumulative distance `d` along `pts`, using the parallel cumulative array
 *  `cum`. Clamps to the endpoints outside [0, total]. [VehicleFlowLayer.ts L171-185] */
export function pointAtDist(pts: [number, number][], cum: number[], d: number): [number, number] {
  const total = cum[cum.length - 1];
  if (d <= 0) return pts[0];
  if (d >= total) return pts[pts.length - 1];
  let lo = 0,
    hi = cum.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (d - cum[lo]) / seg;
  return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t];
}

/** Cumulative meters-length array + total for a worm segment polyline.
 *  [VehicleFlowLayer.ts L520-528] */
export function buildSegCum(seg: [number, number][]): { cum: number[]; len: number } {
  const cum = [0];
  let len = 0;
  for (let i = 1; i < seg.length; i++) {
    len += metersBetween(seg[i - 1], seg[i]);
    cum.push(len);
  }
  return { cum, len };
}
