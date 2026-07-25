// Self-hosted basemap for Leaflet — NO CDN (D3 rule) on the PRIMARY path.
//
// Primary path: a NYC-extent Protomaps vector basemap (.pmtiles), built from
// OpenStreetMap with Planetiler and served from /basemap/nyc-basemap-z15b.pmtiles
// in this app's own public tree (see `site/tools/build_basemap.sh`).
// protomaps-leaflet reads the .pmtiles directly (HTTP range requests against our
// own origin) — no tile server, no third-party host.
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
import {
  leafletLayer,
  CenteredTextSymbolizer,
  type Feature,
  type LabelRule,
} from "protomaps-leaflet";
import {
  MAP_THEME_EVENT,
  resolveMapTheme,
  themeLabelRules,
  themePaintRules,
  type MapThemeChoice,
  type MapThemeDef,
} from "./mapThemes";

// W6.1: the deeper (maxzoom-15) extract ships under a NEW filename so the immutable
// edge/browser cache on the old /basemap/nyc-basemap.pmtiles (36 MB, maxzoom 14) is bypassed
// — same cache-bust discipline as content-hashed assets. Covers all five boroughs; 94.7 MiB.
// NOTE (W1-client deploy): the file ships under the `-z15b` suffix. The `-z15` URL was
// edge-cache-poisoned during pre-deploy diagnostics (a bare-URL request 404'd to the SPA
// index.html BEFORE the file was on the box, and Caddy's `/basemap/*` immutable rule let
// Cloudflare cache that 1 KB HTML fallback for 24h). A fresh, never-requested filename is
// the clean, CF-token-free cache-bust — same discipline that moved z14→z15.
const BASEMAP_URL = import.meta.env.VITE_BASEMAP_URL ?? "/basemap/nyc-basemap-z15b.pmtiles";
const BASEMAP_MODE = import.meta.env.VITE_BASEMAP_MODE ?? "pmtiles";
// The deepest zoom with tile data in nyc-basemap.pmtiles (see W6.1). Map zoom 16-19
// over-zoom (scale) these z15 tiles so roads stay rendered all the way in.
const BASEMAP_MAX_DATA_ZOOM = 15;
// Clamp the Leaflet tile pyramid here; z17-19 CSS-scale this tile (see addBasemap). Kept ≥
// maxDataZoom so the z16 tile carries full z15 detail before it is visually upscaled.
const BASEMAP_MAX_NATIVE_ZOOM = 16;
/** Deepest interactive zoom the maps allow — z15 data over-zoomed to z19 keeps every road
 *  visible in dense + suburban areas (W6.1). Both map surfaces read this. */
export const MAP_MAX_ZOOM = 19;

export const NYC_CENTER: L.LatLngExpression = [40.7128, -73.98];
export const NYC_BOUNDS: L.LatLngBoundsExpression = [
  [40.45, -74.3],
  [40.95, -73.65],
];

/** W3 (2026-07-24) — STREET NUMBERS.
 *
 *  The house numbers were already in the tiles: the `buildings` layer carries
 *  `kind: "address"` POINT features with an `addr_housenumber` property, at data zoom 15
 *  only. Measured on the shipped archive, five z15 tiles:
 *    Midtown 1,213 address points / 2,665 features · Park Slope 2,110 / 4,306 ·
 *    Bayside 1,603 / 3,525 (Queens hyphenation preserved: `215-29`, `48-01`) ·
 *    St George 369 / 764 · Riverdale 366 / 730.
 *  100% of address features carry a number; `addr_street` is NOT in the tiles, so a
 *  label can only ever be the number, never "42 W 42nd St".
 *
 *  COVERAGE IS PARTIAL AND UNEVEN — say so wherever this is surfaced. Address points per
 *  mapped building polygon range 0.83 (Bayside) to 1.56 (Midtown) across those samples;
 *  plenty of buildings have none and some have several. This is OpenStreetMap
 *  volunteered data, not a cadastre.
 *
 *  ZOOM GATING — the trap. protomaps-leaflet keys its labeler on the LEAFLET TILE zoom
 *  (`leaflet_layer.ts`: `this.labelers.add(coords.z, …)`), and we clamp that pyramid at
 *  `BASEMAP_MAX_NATIVE_ZOOM = 16`. A LabelRule with `minzoom: 17` would therefore NEVER
 *  fire. So the rule is declared at minzoom 16 and gated on the map's DISPLAY zoom at
 *  runtime by flipping `rule.visible` (see `gateStreetNumbers`). */
export const STREET_NUMBER_MIN_ZOOM = 17;

export interface BasemapInfo {
  mode: "pmtiles" | "raster";
  attribution: string;
  vintageNote: string;
  /** true once the reliability guard has swapped to the raster fallback. */
  fallbackEngaged?: boolean;
  /** why the fallback engaged (for telemetry): empty_paint_rules | tile_errors_NN | zero_tiles. */
  reason?: string;
  /** id of the map theme currently painted (W4). Absent in raster fallback. */
  themeId?: MapThemeDef["id"];
  /** user-facing name of that theme, for the legend. */
  themeLabel?: string;
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

/** Everything `addBasemap` accepts. Extends the guard hooks so the 7 existing call
 *  sites keep working unchanged. */
export interface BasemapOptions extends BasemapGuardHooks {
  /** This surface's DEFAULT map theme — used only when the visitor has never picked one
   *  (an explicit choice always wins). The thematic-overlay maps pass "focus" so the
   *  DATA carries the colour budget (ARKMAP §7: one hot encoding per view). */
  theme?: MapThemeChoice;
  /** Render OSM house numbers at display zoom >= STREET_NUMBER_MIN_ZOOM. Default true.
   *  Costs nothing below that zoom (the rule is not evaluated). */
  streetNumbers?: boolean;
  /** Called on mount and again whenever the applied theme changes, so a legend can
   *  name the theme honestly instead of guessing. */
  onTheme?: (theme: { id: MapThemeDef["id"]; label: string; tone: "light" | "dark" }) => void;
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

/** The W3 street-number label rule, built against the active theme's flavor so the
 *  numbers inherit that theme's `address_label` / `address_label_halo` colours.
 *
 *  One rule, one dataLayer, zero new bytes: the data is already in the basemap archive
 *  (see STREET_NUMBER_MIN_ZOOM above), already ODbL/OSM, and already attributed at
 *  `chrome/ReactChrome.tsx:168`. Nothing is fetched that was not fetched before.
 *
 *  Collision handling is protomaps' own labeler: address points are laid out AFTER the
 *  road-name rules in this array, so a street name always wins the pixel and the numbers
 *  thin themselves out automatically at density (which is why Midtown shows far fewer
 *  than its 1,213 candidates). */
function streetNumberRule(theme: MapThemeDef): LabelRule {
  return {
    id: "nycv-address-housenumber",
    dataLayer: "buildings",
    // must be <= BASEMAP_MAX_NATIVE_ZOOM — the labeler is keyed on the Leaflet TILE
    // zoom, which we clamp at 16. Display-zoom gating happens in gateStreetNumbers().
    minzoom: BASEMAP_MAX_NATIVE_ZOOM,
    visible: false,
    filter: (_z: number, f: Feature) => f.props.kind === "address",
    symbolizer: new CenteredTextSymbolizer({
      labelProps: ["addr_housenumber"],
      fill: theme.flavor.address_label,
      stroke: theme.flavor.address_label_halo,
      width: 2,
      font: "500 9px sans-serif",
    }),
  };
}

/** Add the basemap layer to a map and return metadata for the legend/attribution.
 *
 *  Wires three things:
 *    * the F5 reliability guard — auto-engage the raster fallback if the vector basemap
 *      is provably broken, and surface a "simplified basemap" chip;
 *    * W4 THEME REACTIVITY. Two defects existed here before 2026-07-24 and are fixed
 *      together: (a) the basemap read ONLY the OS `prefers-color-scheme` and never
 *      `document.documentElement[data-theme]`, so the in-app theme toggle did not move
 *      it — while `SidewalkMap.tsx` DID read `data-theme`, meaning overlay and basemap
 *      could disagree; (b) `addBasemap` is called from `[]`-dep effects at all 7 map
 *      sites, so the theme was fixed AT MOUNT and nothing listened for
 *      `ark:themechange`. Both are now handled INSIDE this function — the listeners live
 *      with the layer, so no call site has to change its effect deps to get a live theme.
 *    * W3 STREET NUMBERS — a display-zoom-gated house-number label rule.
 */
export function addBasemap(map: L.Map, opts?: BasemapOptions): BasemapInfo {
  // Manual escape hatch: force raster from the start (never the shipped default).
  if (BASEMAP_MODE === "raster-todo" || BASEMAP_MODE === "raster") {
    addRasterLayer(map);
    return { ...RASTER_INFO, reason: "forced_mode" };
  }
  const hooks = opts;
  const wantNumbers = opts?.streetNumbers !== false;

  let theme = resolveMapTheme(opts?.theme);
  let addrRule: LabelRule | null = null;

  /** Build a protomaps layer for the current theme. Throws only if protomaps does. */
  const build = (): ReturnType<typeof leafletLayer> => {
    const labels = themeLabelRules(theme);
    addrRule = wantNumbers ? streetNumberRule(theme) : null;
    if (addrRule) labels.push(addrRule);
    return leafletLayer({
      url: BASEMAP_URL,
      // ⚠️ VERSION-SPECIFIC OPTION NAME — THIS RULE INVERTED AT protomaps-leaflet v5.
      //   * protomaps-leaflet **4.x**: the option was `theme`, and passing `flavor`
      //     was the bug (it silently yielded empty paintRules — the 2026-07 outage).
      //   * protomaps-leaflet **5.x (what we ship)**: the option is `flavor`, backed by
      //     `namedFlavor()` from `@protomaps/basemaps`. Passing `theme` is now the bug.
      // So the old "never use `flavor`" warning is DEAD and must not be reinstated while
      // we are on 5.x. Check the installed major before trusting any advice about this
      // option name.
      //
      // W4 NOTE — we now pass EXPLICIT rules instead of a flavor NAME, because
      // `leafletLayer` treats the two as mutually exclusive (`if (options.flavor) {…}
      // else { paintRules/labelRules }`) and our four purpose-built themes are custom
      // `Flavor` OBJECTS, not one of the five names `namedFlavor()` knows. The rules come
      // from protomaps' own `paintRules()`/`labelRules()` generators, so the FILTERS are
      // byte-identical to what `flavor: "light"` would have produced — only the colours
      // differ, and `site/tools/rule_canary.mjs` therefore still speaks for them.
      paintRules: themePaintRules(theme),
      labelRules: labels,
      backgroundColor: theme.flavor.background,
      // W6.1 basemap depth — "roads must never disappear when zooming in". The NYC build is
      // generated at maxzoom 15 (see `site/tools/build_basemap.sh`); the previous 36 MB
      // extract stopped at z14.
      //   * maxDataZoom=15 tells protomaps-leaflet the deepest zoom with tile data, so a display
      //     tile at z16 resolves to the z15 data tile (verified: full roads at z15 AND z16).
      //   * maxNativeZoom=16 is the RELIABLE over-zoom for z17-19: protomaps-leaflet's OWN
      //     internal scale path (display zoom > maxDataZoom+levelDiff) renders buildings but
      //     DROPS roads. W0 verified that on 4.1.1 and INFERRED it for 5.1.0; W3 (2026-07-24)
      //     RE-TESTED IT on 5.1.0 rather than trusting the inference — built with
      //     maxNativeZoom=19 and shot Midtown at z18: street NAMES render natively and
      //     crisply, but road casings and fills are gone and the buildings wash out. The
      //     defect survives the major. The clamp stays. Clamping the Leaflet tile pyramid at z16 makes
      //     Leaflet request the known-good z16 tile and CSS-scale that canvas for z17-19 — every
      //     road stays rendered, just visually upscaled. protomaps overrides only createTile/
      //     renderTile, NOT Leaflet's _clampZoom/_setZoomTransform, so native scaling is intact.
      //     The same upscale applies to the z17+ house numbers (W3) — they are laid out on the
      //     z16 tile and CSS-scaled, so they are larger and softer than a native z18 label.
      maxDataZoom: BASEMAP_MAX_DATA_ZOOM,
      maxNativeZoom: BASEMAP_MAX_NATIVE_ZOOM,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Protomaps',
    });
  };

  let layer: ReturnType<typeof leafletLayer>;
  /** Set by the tile-error guard below so a W4 theme rebuild can move its counters onto
   *  the replacement layer instead of leaving them on a detached one. */
  let onRebuild: (
    oldLayer: ReturnType<typeof leafletLayer>,
    newLayer: ReturnType<typeof leafletLayer>,
  ) => void = () => {};
  try {
    layer = build();
  } catch (e) {
    // 5.x `namedFlavor()` throws on an unrecognized flavor name (4.x silently produced
    // empty rules). Never let a style problem take the whole map down — degrade to raster.
    console.error("[basemap] leafletLayer() threw — auto-engaging raster fallback.", e);
    addRasterLayer(map);
    showChip(map, "imm-basemap-fallback", "simplified basemap");
    const info: BasemapInfo = { ...RASTER_INFO, reason: "layer_construct_threw" };
    hooks?.onFallback?.(info, "layer_construct_threw");
    return info;
  }
  layer.addTo(map);

  let engaged = false;
  const engageRaster = (reason: string): void => {
    if (engaged) return;
    engaged = true;
    if (!mapAlive(map)) return;
    try {
      // protomaps-leaflet builds its LeafletLayer by extending an `any`-typed `L.GridLayer`
      // (the lib does `declare const L: any`), so its emitted instance type carries an index
      // signature rather than L.Layer's members. It IS an L.Layer at runtime; this cast is
      // that fact, and is the ONLY place we widen the now-real protomaps types.
      map.removeLayer(layer as unknown as L.Layer);
    } catch {
      /* already gone */
    }
    addRasterLayer(map);
    showChip(map, "imm-basemap-fallback", "simplified basemap");
    const info = { ...RASTER_INFO, reason };
    hooks?.onFallback?.(info, reason);
  };

  // ---- W3: display-zoom gate for the house numbers -------------------------------
  // The rule's own minzoom cannot express this (see STREET_NUMBER_MIN_ZOOM), so flip
  // `visible` when the DISPLAY zoom crosses the threshold and re-lay-out the labels.
  // Only fires on an actual crossing — at most a couple of relayouts per session.
  const gateStreetNumbers = (): void => {
    if (!addrRule || engaged || !mapAlive(map)) return;
    const want = map.getZoom() >= STREET_NUMBER_MIN_ZOOM;
    if (want === addrRule.visible) return;
    addrRule.visible = want;
    try {
      layer.clearLayout();
      layer.rerenderTiles();
    } catch {
      /* layer torn down mid-flight */
    }
  };
  map.on("zoomend", gateStreetNumbers);
  gateStreetNumbers();

  // ---- W4: live theme changes ------------------------------------------------------
  hooks?.onTheme?.({ id: theme.id, label: theme.label, tone: theme.tone });
  const applyTheme = (): void => {
    if (engaged || !mapAlive(map)) return; // raster fallback owns the map now
    const next = resolveMapTheme(opts?.theme);
    if (next.id === theme.id && next.tone === theme.tone) return;
    theme = next;
    let rebuilt: ReturnType<typeof leafletLayer>;
    try {
      rebuilt = build();
    } catch (e) {
      console.error("[basemap] rebuilding for a theme change threw — keeping the old layer.", e);
      return;
    }
    const old = layer;
    layer = rebuilt;
    layer.addTo(map);
    try {
      map.removeLayer(old as unknown as L.Layer);
    } catch {
      /* already gone */
    }
    onRebuild(old, layer);
    gateStreetNumbers();
    hooks?.onTheme?.({ id: theme.id, label: theme.label, tone: theme.tone });
  };
  const mql =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
  if (typeof document !== "undefined") {
    document.addEventListener("ark:themechange", applyTheme);
    document.addEventListener(MAP_THEME_EVENT, applyTheme);
  }
  mql?.addEventListener?.("change", applyTheme);

  // (1) Immediate structural check on the generated style.
  //
  //     ⚠️ KNOWN LIMIT — READ BEFORE TRUSTING THIS GUARD. It inspects the RULES, never the
  //     TILES. It caught the 2026-07 `flavor`→`theme` outage (an unknown option produced an
  //     EMPTY paintRules array), but it was BLIND to the far worse 2026-07-24 defect: the
  //     4.1.1 default style targeted the Protomaps **v2** schema (`pmap:kind`) while the
  //     shipped tileset is **v4.15.0** (bare `kind`), so paintRules was fully populated —
  //     ~34 rules — and every road/place rule still matched ZERO features. Roads and street
  //     labels were absent from production for weeks and both guards passed.
  //
  //     A schema mismatch is only detectable by decoding a real tile and evaluating the real
  //     filters against real features. That is `site/tools/rule_canary.mjs` (run from
  //     `paint_canary.py`), not this function. Do not treat a green guard (1) as evidence
  //     that anything renders.
  //
  //     What this DOES now assert: rules exist at all, AND the style still declares rules for
  //     the `roads` dataLayer (a style whose dataLayers stop matching the tileset's layer
  //     names — the `natural`/`physical_line`/`transit` v2 names — trips this).
  const lyr = layer as unknown as {
    paintRules?: { dataLayer?: string }[];
    labelRules?: { dataLayer?: string }[];
  };
  const paintRuleCount = lyr.paintRules?.length;
  if (paintRuleCount === 0) {
    console.error(
      "[basemap] protomaps-leaflet produced EMPTY paintRules — auto-engaging raster fallback.",
    );
    engageRaster("empty_paint_rules");
    return { ...RASTER_INFO, reason: "empty_paint_rules" };
  }
  const roadPaintRules = (lyr.paintRules ?? []).filter((r) => r.dataLayer === "roads").length;
  const roadLabelRules = (lyr.labelRules ?? []).filter((r) => r.dataLayer === "roads").length;
  if (paintRuleCount !== undefined && (roadPaintRules === 0 || roadLabelRules === 0)) {
    // Not fatal enough to drop to raster (buildings/water/landuse would still be correct),
    // but it is always a defect: log loudly so it shows up in the client-error beacon.
    console.error(
      `[basemap] style declares NO rules for the 'roads' dataLayer ` +
        `(paint=${roadPaintRules} label=${roadLabelRules}) — streets will not render. ` +
        "This is the protomaps style/tileset schema-mismatch class of bug; run " +
        "site/tools/rule_canary.mjs.",
    );
  }

  // (2) Runtime tile-error guard. protomaps-leaflet extends L.GridLayer and fires
  //     'tileloadstart' when a tile begins and 'tileload' ONLY on success (it swallows
  //     fetch failures as console.error and never fires Leaflet's 'tileerror'). So the
  //     honest error signal is: requested (tileloadstart) vs succeeded (tileload).
  //     A theme change (W4) rebuilds the layer, so the counters MOVE to the new layer and
  //     reset — otherwise a rebuild inside the 15 s window would look like a wall of
  //     failed tiles and falsely engage the raster fallback.
  let started = 0;
  let loaded = 0;
  const onStart = () => started++;
  const onLoad = () => loaded++;
  const attachCounters = (l: ReturnType<typeof leafletLayer>) => {
    l.on("tileloadstart", onStart);
    l.on("tileload", onLoad);
  };
  const detachCounters = (l: ReturnType<typeof leafletLayer>) => {
    try {
      l.off("tileloadstart", onStart);
      l.off("tileload", onLoad);
    } catch {
      /* already gone */
    }
  };
  onRebuild = (oldLayer, newLayer) => {
    detachCounters(oldLayer);
    started = 0;
    loaded = 0;
    attachCounters(newLayer);
  };
  attachCounters(layer);

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
    detachCounters(layer);
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

  // Best-effort cleanup if the map is torn down before the timers fire. Leaflet fires
  // 'unload' from Map.remove(), which is what every map surface calls on unmount — so
  // the theme listeners this function installs do NOT outlive their map. (Without this
  // the document-level listeners would leak one closure per SPA navigation.)
  map.on("unload", () => {
    clearTimeout(t10);
    clearTimeout(t15);
    map.off("zoomend", gateStreetNumbers);
    if (typeof document !== "undefined") {
      document.removeEventListener("ark:themechange", applyTheme);
      document.removeEventListener(MAP_THEME_EVENT, applyTheme);
    }
    mql?.removeEventListener?.("change", applyTheme);
  });

  return { ...PMTILES_INFO, themeId: theme.id, themeLabel: theme.label };
}
