// nycviz-flow — Web-Mercator projection + true-scale geometry (VERBATIM math).
//
// The projector reproduces `map.latLngToLayerPoint` for EPSG:3857 with zero allocation:
// per-frame constants (cA/ccx/cmy/ccy) are configured once from the host's zoom +
// pixelOrigin, then `project(lat, lon)` writes layer-space pixels into `plx`/`ply`. This
// is the exact inline `_project` from VehicleFlowLayer.ts L207-211 / L709-716, isolated
// so it is host-independent and unit-testable against known lat/lng↔pixel fixtures.

import { DEG } from "./constants";

/** Haversine-lite planar distance in meters between two [lat, lon] points.
 *  [VehicleFlowLayer.ts L159-165] */
export function metersBetween(a: [number, number], b: [number, number]): number {
  const R = 6378137;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const latm = (((a[0] + b[0]) / 2) * Math.PI) / 180;
  const dLon = (((b[1] - a[1]) * Math.PI) / 180) * Math.cos(latm);
  return R * Math.sqrt(dLat * dLat + dLon * dLon);
}

/** Web-Mercator ground resolution (meters per CSS pixel) at a latitude + zoom.
 *  [VehicleFlowLayer.ts L167-169] */
export function metersPerPixel(lat: number, zoom: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom + 8);
}

/** Alloc-free inline Web-Mercator projector. Configure once per frame from the host
 *  viewport, then call project() in the hot loop; results land in plx/ply. */
export class Projector {
  // layer-space output of the last project() call (scratch — no Point allocation)
  plx = 0;
  ply = 0;
  // per-frame projection constants: layerX = cA*lon + ccx ; layerY = ccy - cmy*merc(lat)
  private cA = 0;
  private ccx = 0;
  private cmy = 0;
  private ccy = 0;

  /** Recompute the projection constants for this zoom + pixel origin.
   *  [VehicleFlowLayer.ts L881-887] */
  configure(zoom: number, originX: number, originY: number): void {
    const scale = 256 * Math.pow(2, zoom);
    const half = scale * 0.5;
    this.cA = (scale * 0.5 * DEG) / Math.PI;
    this.ccx = half - originX;
    this.cmy = (scale * 0.5) / Math.PI;
    this.ccy = half - originY;
  }

  /** Project [lat, lon] → layer pixels, written to plx/ply. [VehicleFlowLayer.ts L709-716] */
  project(lat: number, lon: number): void {
    let s = Math.sin(lat * DEG);
    if (s > 0.99999) s = 0.99999;
    else if (s < -0.99999) s = -0.99999;
    const merc = 0.5 * Math.log((1 + s) / (1 - s));
    this.plx = this.cA * lon + this.ccx;
    this.ply = this.ccy - this.cmy * merc;
  }
}
