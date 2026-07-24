// Self-hosted basemap for Leaflet — NO CDN (D3 rule) on the PRIMARY path.
//
// Primary path: a NYC-extent Protomaps vector basemap (.pmtiles), extracted from
// OpenStreetMap and served from /basemap/nyc-basemap.pmtiles in this app's own
// public tree. protomaps-leaflet reads the .pmtiles directly (HTTP range requests
// against our own origin) — no tile server, no third-party host.
//
// Fallback path (F5 reliability): OSM raster tiles. This DOES hit a third-party host
// and therefore is a deliberate DEGRADED-MODE exception to the no-CDN rule — it must
// never be the shipped default. It engages ONLY when the primary vector basemap is
// provably broken (empty paint rules OR >30% tile errors in the first 15s), so the
// page shows a real map instead of a blank void. When it engages we surface a visible
// "simplified basemap" chip. `VITE_BASEMAP_MODE=raster-todo` also forces it from the
// start (manual escape hatch). The raster codepath is referenced from the runtime guard
// below, so it is NOT tree-shaken out of the build (the F5 fix).
import L from "leaflet";
import { leafletLayer } from "protomaps-leaflet";

const BASEMAP_URL = import.meta.env.VITE_BASEMAP_URL ?? "/basemap/nyc-basemap.pmtiles";
const BASEMAP_MODE = import.meta.env.VITE_BASEMAP_MODE ?? "pmtiles";

export const NYC_CENTER: L.LatLngExpression = [40.7128, -73.98];
export const NYC_BOUNDS: L.LatLngBoundsExpression = [
  [40.45, -74.3],
  [40.95, -73.65],
];

export interface BasemapInfo {
  mode: "pmtiles" | "raster";
  attribution: string;
  vintageNote: string;
  /** true once the reliability guard has swapped to the raster fallback. */
  fallbackEngaged?: boolean;
  /** why the fallback engaged (for telemetry): empty_paint_rules | tile_errors_NN | zero_tiles. */
  reason?: string;
}

/** Guard callbacks the map components pass so they can react to a degraded basemap
 *  (update the legend vintage note, fire the F5 client-error beacon). All optional. */
export interface BasemapGuardHooks {
  /** logical page path (for the beacon), e.g. location.pathname. */
  page?: string;
  /** the guard swapped to the raster fallback — pass the new info + reason. */
  onFallback?: (info: BasemapInfo, reason: string) => void;
  /** no basemap pixels detected after ~10s (beacon-only signal; may precede a swap). */
  onZeroTiles?: (detail: string) => void;
}

const RASTER_INFO: BasemapInfo = {
  mode: "raster",
  attribution: "© OpenStreetMap contributors",
  vintageNote: "Basemap: OSM raster tiles (simplified fallback — primary vector basemap unavailable)",
  fallbackEngaged: true,
};
const PMTILES_INFO: BasemapInfo = {
  mode: "pmtiles",
  attribution: "© OpenStreetMap · Protomaps",
  vintageNote: "Basemap: Protomaps/OSM vector (self-hosted pmtiles, NYC extent)",
};

/** Current map viewport as a `minLon,minLat,maxLon,maxLat` bbox string for the rt
 *  poll endpoints (F5/F3 payload slimming). Slightly padded so units just outside the
 *  edge don't pop in/out on tiny pans. */
export function bboxParam(map: L.Map, pad = 0.12): string {
  const b = map.getBounds().pad(pad);
  const sw = b.getSouthWest();
  const ne = b.getNorthEast();
  return `${sw.lng.toFixed(4)},${sw.lat.toFixed(4)},${ne.lng.toFixed(4)},${ne.lat.toFixed(4)}`;
}

/** Add the OSM raster fallback tile layer. Referenced from the runtime guard so the
 *  raster codepath stays in the production bundle (it used to be tree-shaken). */
function addRasterLayer(map: L.Map): L.TileLayer {
  return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors (simplified fallback basemap)",
  }).addTo(map);
}

function showChip(map: L.Map, className: string, text: string): void {
  try {
    const container = map.getContainer();
    if (container.querySelector("." + className)) return; // don't stack duplicates
    const chip = document.createElement("div");
    chip.className = className;
    chip.setAttribute("role", "status");
    chip.textContent = text;
    container.appendChild(chip);
  } catch {
    /* non-DOM env (SSR/tests) */
  }
}

function mapAlive(map: L.Map): boolean {
  try {
    const c = map.getContainer();
    return !!c && c.isConnected;
  } catch {
    return false;
  }
}

/** Count basemap canvas pixels that actually painted (non-zero alpha). Returns the
 *  number of sampled opaque pixels; 0 ⇒ the basemap rendered nothing. Sparse sampling
 *  keeps it cheap. Same-origin pmtiles ⇒ the canvases are not tainted, so getImageData
 *  is allowed. */
function countPaintedPixels(map: L.Map): number {
  try {
    const canvases = map
      .getContainer()
      .querySelectorAll<HTMLCanvasElement>("canvas.leaflet-tile");
    let painted = 0;
    canvases.forEach((cv) => {
      const w = cv.width;
      const h = cv.height;
      if (!w || !h) return;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      let img: ImageData;
      try {
        img = ctx.getImageData(0, 0, w, h);
      } catch {
        return; // tainted / unreadable — skip
      }
      const data = img.data;
      const stride = 32 * 4; // sample ~1 px per 32 in each axis-ish (coarse)
      for (let i = 3; i < data.length; i += stride) {
        if (data[i] !== 0) painted++;
      }
    });
    return painted;
  } catch {
    return -1; // couldn't sample (no canvases yet / non-DOM) — treat as "unknown", not zero
  }
}

/** Add the basemap layer to a map and return metadata for the legend/attribution.
 *  Wires the F5 reliability guard: auto-engage the raster fallback if the vector
 *  basemap is provably broken, and surface a "simplified basemap" chip. */
export function addBasemap(map: L.Map, hooks?: BasemapGuardHooks): BasemapInfo {
  // Manual escape hatch: force raster from the start (never the shipped default).
  if (BASEMAP_MODE === "raster-todo" || BASEMAP_MODE === "raster") {
    addRasterLayer(map);
    return { ...RASTER_INFO, reason: "forced_mode" };
  }

  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  const layer = leafletLayer({
    url: BASEMAP_URL,
    // protomaps-leaflet 4.x uses `theme` (NOT `flavor` — that is the MapLibre
    // @protomaps/basemaps API). An unknown option silently yields empty
    // paintRules/labelRules, so the basemap fetches tiles but paints nothing.
    theme: prefersDark ? "dark" : "light",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Protomaps',
  });
  layer.addTo(map);

  let engaged = false;
  const engageRaster = (reason: string): void => {
    if (engaged) return;
    engaged = true;
    if (!mapAlive(map)) return;
    try {
      map.removeLayer(layer);
    } catch {
      /* already gone */
    }
    addRasterLayer(map);
    showChip(map, "imm-basemap-fallback", "simplified basemap");
    const info = { ...RASTER_INFO, reason };
    hooks?.onFallback?.(info, reason);
  };

  // (1) Immediate check — the exact `flavor`→`theme` class of bug: an unknown theme
  //     option yields an EMPTY paintRules array and the basemap can never paint.
  const paintRuleCount = (layer as unknown as { paintRules?: unknown[] }).paintRules?.length;
  if (paintRuleCount === 0) {
    console.error(
      "[basemap] protomaps-leaflet produced EMPTY paintRules — auto-engaging raster fallback.",
    );
    engageRaster("empty_paint_rules");
    return { ...RASTER_INFO, reason: "empty_paint_rules" };
  }

  // (2) Runtime tile-error guard. protomaps-leaflet extends L.GridLayer and fires
  //     'tileloadstart' when a tile begins and 'tileload' ONLY on success (it swallows
  //     fetch failures as console.error and never fires Leaflet's 'tileerror'). So the
  //     honest error signal is: requested (tileloadstart) vs succeeded (tileload).
  let started = 0;
  let loaded = 0;
  const onStart = () => started++;
  const onLoad = () => loaded++;
  layer.on("tileloadstart", onStart);
  layer.on("tileload", onLoad);

  // (2a) Zero-painted-tiles beacon after 10s (F5.2). Beacon-only here; the 15s check
  //      decides whether to actually swap.
  const t10 = setTimeout(() => {
    if (engaged || !mapAlive(map)) return;
    const painted = countPaintedPixels(map);
    if (painted === 0) {
      hooks?.onZeroTiles?.("zero_painted_tiles_after_10s");
    }
  }, 10_000);

  // (2b) At 15s, decide: >30% of requested tiles failed to load, OR nothing painted at
  //      all ⇒ the vector basemap is broken ⇒ swap to raster.
  const t15 = setTimeout(() => {
    layer.off("tileloadstart", onStart);
    layer.off("tileload", onLoad);
    if (engaged || !mapAlive(map)) return;
    const errRate = started > 0 ? 1 - loaded / started : 0;
    const painted = countPaintedPixels(map);
    if (started > 0 && errRate > 0.3) {
      engageRaster("tile_errors_" + Math.round(errRate * 100) + "pct");
    } else if (painted === 0) {
      // canvases exist but nothing opaque was drawn (started may be low if the pmtiles
      // fetch itself 404'd before any tile request completed).
      engageRaster("zero_tiles");
    }
  }, 15_000);

  // Best-effort cleanup if the map is torn down before the timers fire.
  map.on("unload", () => {
    clearTimeout(t10);
    clearTimeout(t15);
  });

  return { ...PMTILES_INFO };
}
