// Sidewalk Explorer map (Q1.2 overhaul — coverage centerlines as the HERO).
//
// The street network is the canvas. Sidewalk coverage is rendered as attribute-
// driven vector-tile CENTERLINES via protomaps-leaflet reading /layers/coverage
// .pmtiles (Z10–16, ~6.5 MB) — deficiency-forward: gaps scream, good recedes.
// This replaces the old per-borough GeoJSON fetch (files kept on disk for the
// full-resolution downloads).
//
// Layers, back-to-front:
//   1. NTA equity choropleth — SOFT blue background only (one-hot law: never hot)
//   2. Coverage centerlines (HERO) — pmtiles + paint rules; ON by default, ungated
//   3. SAI stops — canvas circleMarkers on min.geojson (rich sub-score popups),
//      magma-style GREEN-FREE ramp; mutually exclusive with hot coverage
//   4. ADA ramp-gap intersections — dots, zoom-gated (unchanged)
//
// One-hot color budget rule (site-wide law): only ONE magnitude/status encoding
// is hot per view. When SAI is active, the coverage lines drop to a neutral
// hairline so the two status-greens never collide (viridis-green killed → magma).
//
// Every layer carries its own data-vintage stamp (ARKMAP §3); coverage/SAI stamps
// come from the tile sidecar /layers/overlays_meta.json.
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { leafletLayer, LineSymbolizer } from "protomaps-leaflet";
// minimal shape of a protomaps-leaflet vector-tile feature (only props are read)
interface CovFeat { props?: Record<string, unknown> }
import { addBasemap, NYC_CENTER, NYC_BOUNDS, type BasemapInfo } from "../lib/basemap";

// ---- palettes (all run through the dataviz validate_palette.js; see wrap-up) ----
// Coverage: 3 ordered classes drawn as lines. Deficiency-forward. The amber↔green
// adjacency is CVD-covered by the REDUNDANT width + dash channels (risk register).
type Theme = "light" | "dark";
const COV: Record<Theme, { n: string; o: string; b: string; neutral: string; dashbg: string }> = {
  // light basemap
  light: { n: "#d64545", o: "#e8a33d", b: "#0f9d58", neutral: "#b4b4af", dashbg: "#f4f3ef" },
  // dark basemap — ~+12% lightness so lines read on dark tiles (Q1.6)
  dark: { n: "#f0696a", o: "#f2b65a", b: "#38c07f", neutral: "#5a5a54", dashbg: "#14120f" },
};
const ADA_MIN_ZOOM = 13;
const W_MED_FT = 13; // ~citywide median sidewalk width, the sqrt-scale anchor

function effectiveTheme(): Theme {
  if (typeof document !== "undefined") {
    const a = document.documentElement.getAttribute("data-theme");
    if (a === "dark") return "dark";
    if (a === "light") return "light";
  }
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Magma-style GREEN-FREE sequential ramp for SAI 0..100 (kills the viridis-green
 *  vs coverage-green collision). Monotonic OKLCH lightness .31→.44→.60→.79→.81. */
function saiColor(v: number): string {
  const stops: [number, string][] = [
    [0, "#3b0f70"], [25, "#8c2981"], [50, "#de4968"], [75, "#fe9f6d"], [100, "#fcae60"],
  ];
  const x = Math.max(0, Math.min(100, v));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [v0, c0] = stops[i - 1];
      const [v1, c1] = stops[i];
      const t = (x - v0) / (v1 - v0);
      const p = (c: string) => [1, 3, 5].map((j) => parseInt(c.slice(j, j + 2), 16));
      const a = p(c0), b = p(c1);
      const mix = a.map((q, j) => Math.round(q + (b[j] - q) * t));
      return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
    }
  }
  return stops[stops.length - 1][1];
}

// Q4.1 cross-link: a location popup on the sidewalk map offers a jump to the same
// spot in the Renter's Map (lat/lon URL — the renters page reads ?ll= on load, so
// the link is shareable). Plain anchor: the popup HTML lives outside React, and an
// internal href to /renters?ll= navigates the SPA to the right place.
function rentersLinkHtml(lat: number, lon: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  const url = `/renters?ll=${lat.toFixed(6)},${lon.toFixed(6)}`;
  return (
    `<a href="${url}" class="sw-popup-renters" ` +
    `style="display:inline-block;margin-top:6px;font-weight:600;color:var(--ark-accent,#2563eb)">` +
    `Explore this location in the Renter&rsquo;s Map →</a>`
  );
}
/** GeoJSON point → [lat, lon] (coords are [lon, lat]); null if not a point. */
function pointLatLon(f: { geometry?: { type?: string; coordinates?: number[] } }): [number, number] | null {
  const g = f.geometry;
  if (!g || g.type !== "Point" || !Array.isArray(g.coordinates)) return null;
  const [lon, lat] = g.coordinates;
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}

function ntaColor(v: number | null, metric: "ratio" | "spc"): string {
  if (v == null) return "#9ca3af";
  const max = metric === "ratio" ? 14 : 150;
  const t = Math.max(0, Math.min(v / max, 1));
  // soft blue background ramp — deliberately low-contrast (never hot)
  const shades = ["#f1f5fb", "#dce7f6", "#c2d6ee", "#a7c3e6", "#8fb0dd", "#7aa0d6"];
  return shades[Math.min(Math.floor(t * shades.length), shades.length - 1)];
}

interface LayerState {
  sai: boolean;
  coverage: boolean;
  nta: boolean;
  ada: boolean;
}
/** Live style state read by the pmtiles paint functions (mutated in place so a
 *  toggle/theme change is a cheap rerenderTiles(), never a tile refetch). */
interface CovStyle {
  theme: Theme;
  widthMode: boolean;
  saiActive: boolean;
}

interface CovMeta {
  generated?: string;
  source_vintage?: string;
  tippecanoe?: string;
}

export default function SidewalkMap() {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  // pmtiles coverage overlay + its mutable style
  const covLayer = useRef<ReturnType<typeof leafletLayer> | null>(null);
  const covStyle = useRef<CovStyle>({ theme: effectiveTheme(), widthMode: false, saiActive: false });
  // leaflet vector groups
  const groups = useRef<Record<"sai" | "nta" | "ada", L.LayerGroup | null>>({ sai: null, nta: null, ada: null });
  const loadedFlags = useRef<{ sai: boolean; nta: boolean; ada: boolean }>({ sai: false, nta: false, ada: false });

  const [on, setOn] = useState<LayerState>({ sai: false, coverage: true, nta: true, ada: false });
  const onRef = useRef(on);
  onRef.current = on;
  const [widthMode, setWidthMode] = useState(false);
  const [ntaMetric, setNtaMetric] = useState<"ratio" | "spc">("ratio");
  const ntaMetricRef = useRef(ntaMetric);
  ntaMetricRef.current = ntaMetric;
  const ntaLayerObj = useRef<L.GeoJSON | null>(null);
  const [basemap, setBasemap] = useState<BasemapInfo | null>(null);
  const [covMeta, setCovMeta] = useState<CovMeta | null>(null);
  const [saiMeta, setSaiMeta] = useState<{ generated?: string; source_vintage?: string } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [zoomNote, setZoomNote] = useState<string | null>(null);

  const rerenderCov = () => {
    const cl = covLayer.current as unknown as { rerenderTiles?: () => void; redraw?: () => void } | null;
    if (!cl) return;
    if (typeof cl.rerenderTiles === "function") cl.rerenderTiles();
    else cl.redraw?.();
  };

  // ---- init ----
  useEffect(() => {
    if (map.current || !mapRef.current) return;
    const m = L.map(mapRef.current, {
      center: NYC_CENTER, zoom: 11, minZoom: 9, maxZoom: 17,
      maxBounds: NYC_BOUNDS, maxBoundsViscosity: 0.6, preferCanvas: true,
    });
    // z-order panes: basemap(tilePane 200) < nta(350) < coverage(400) < points(450)
    m.createPane("nta").style.zIndex = "350";
    m.createPane("coverage").style.zIndex = "400";
    m.createPane("points").style.zIndex = "450";
    setBasemap(addBasemap(m));

    for (const k of ["nta", "sai", "ada"] as const) groups.current[k] = L.layerGroup();

    // ---- coverage pmtiles HERO overlay ----
    const st = covStyle.current;
    const cls = (f?: CovFeat): string => String((f?.props as Record<string, unknown> | undefined)?.c ?? "");
    const zf = (z: number) => 0.5 + 0.15 * Math.max(0, z - 10); // zoom-scaled width
    const widthFn = (z: number, f?: CovFeat): number => {
      if (st.saiActive) return 0.6 * zf(z);
      const c = cls(f);
      let base = c === "n" ? 2.6 : c === "o" ? 2.2 : 1.2;
      if (st.widthMode) {
        const w = Number((f?.props as Record<string, unknown> | undefined)?.w);
        if (Number.isFinite(w) && w > 0) base *= Math.min(2.2, Math.max(0.5, Math.sqrt(w / W_MED_FT)));
      }
      return base * zf(z);
    };
    const colorFn = (_z: number, f?: CovFeat): string => {
      const C = COV[st.theme];
      if (st.saiActive) return C.neutral;
      const c = cls(f);
      return c === "n" ? C.n : c === "o" ? C.o : C.b;
    };
    const opacityFn = (_z: number, f?: CovFeat): number => {
      if (st.saiActive) return 0.5;
      return cls(f) === "b" ? 0.62 : 0.95; // good recedes; deficiency full
    };
    // main rule handles everything except the un-suppressed "none" class (which
    // gets its own dashed rule for the CVD-redundant "screaming" texture).
    const mainRule = {
      dataLayer: "coverage",
      minzoom: 10,
      filter: (_z: number, f: CovFeat) => st.saiActive || cls(f) !== "n",
      symbolizer: new LineSymbolizer({
        color: colorFn, width: widthFn, opacity: opacityFn, lineCap: "round" as CanvasLineCap,
      }),
    };
    const noneRule = {
      dataLayer: "coverage",
      minzoom: 10,
      filter: (_z: number, f: CovFeat) => !st.saiActive && cls(f) === "n",
      symbolizer: new LineSymbolizer({
        color: (_z: number) => COV[st.theme].n,
        width: widthFn,
        opacity: opacityFn,
        dash: [5, 4],
        dashColor: (_z: number) => COV[st.theme].dashbg,
        dashWidth: (z: number, f?: CovFeat) => widthFn(z, f) + 0.6,
        lineCap: "butt" as CanvasLineCap,
      }),
    };
    const cov = leafletLayer({
      url: "/layers/coverage.pmtiles",
      pane: "coverage",
      paintRules: [mainRule, noneRule],
      labelRules: [],
      maxDataZoom: 16,
    });
    covLayer.current = cov;
    if (onRef.current.coverage) cov.addTo(m);

    m.on("zoomend moveend", () => sync(m));
    map.current = m;
    sync(m);

    // theme reactivity: OS setting + manual [data-theme] toggle
    const applyTheme = () => {
      const t = effectiveTheme();
      if (t !== covStyle.current.theme) {
        covStyle.current.theme = t;
        rerenderCov();
      }
    };
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", applyTheme);
    const mo = new MutationObserver(applyTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    // vintage sidecar
    fetch("/layers/overlays_meta.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        setCovMeta({ generated: j.coverage?.generated, source_vintage: j.coverage?.source_vintage, tippecanoe: j.tippecanoe });
        if (j.sai) setSaiMeta({ generated: j.sai.generated, source_vintage: j.sai.source_vintage });
      })
      .catch(() => {});

    return () => {
      mq?.removeEventListener?.("change", applyTheme);
      mo.disconnect();
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchGeo = async (path: string) => {
    const r = await fetch(path);
    if (!r.ok) throw new Error(path);
    return r.json();
  };

  const loadSai = async () => {
    if (loadedFlags.current.sai) return;
    loadedFlags.current.sai = true;
    setLoading("Loading Stop Accessibility Index…");
    try {
      const gj = await fetchGeo("/layers/sai_stops.min.geojson");
      const lyr = L.geoJSON(gj, {
        pane: "points",
        pointToLayer: (f, latlng) => {
          const p = f.properties as Record<string, number | string>;
          return L.circleMarker(latlng, {
            pane: "points", radius: 4, weight: 0.8, color: "#1f2937",
            fillColor: saiColor(Number(p.sai)), fillOpacity: 0.92,
          });
        },
        onEachFeature: (f, l) => {
          const p = f.properties as Record<string, string | number>;
          const sub = (label: string, key: string) =>
            `<tr><td style="padding-right:8px">${label}</td><td><strong>${p[key]}</strong></td></tr>`;
          const ll = pointLatLon(f as { geometry?: { type?: string; coordinates?: number[] } });
          l.bindPopup(
            `<div style="min-width:190px"><strong>${p.stop_name}</strong><br/>` +
              `<span style="opacity:.75">${p.routes} · ${p.borough}</span><br/>` +
              `<span style="font-size:1.05rem"><strong>SAI ${p.sai}</strong> / 100</span>` +
              `<table style="margin-top:4px;font-size:.85em">` +
              sub("Walkshed population", "walkshed_population") +
              sub("Sidewalk provision", "sidewalk_provision") +
              sub("ADA ramp access", "ada_ramp_access") +
              sub("Comfort (shelter/seat)", "comfort") +
              sub("Condition", "condition") +
              sub("Safety", "safety") +
              sub("Service intensity", "service_intensity") +
              `</table><span style="opacity:.65;font-size:.8em">${Number(p.pop_400m).toLocaleString()} residents within 400 m</span>` +
              (ll ? `<br/>${rentersLinkHtml(ll[0], ll[1])}` : "") +
              `</div>`,
          );
        },
      });
      groups.current.sai?.addLayer(lyr);
    } catch {
      /* layer fetch failed; leave empty */
    } finally {
      setLoading(null);
    }
  };

  const loadNta = async () => {
    if (loadedFlags.current.nta) return;
    loadedFlags.current.nta = true;
    try {
      const gj = await fetchGeo("/layers/nta_equity.geojson");
      const lyr = L.geoJSON(gj, {
        pane: "nta",
        style: (f) => ({
          pane: "nta", weight: 0.6, color: "#8aa0bd",
          fillColor: ntaColor((f?.properties as Record<string, number | null>)[ntaMetricRef.current] ?? null, ntaMetricRef.current),
          fillOpacity: 0.32, // soft background only
        }),
        onEachFeature: (f, l) => {
          const p = f.properties as Record<string, string | number | null>;
          l.bindPopup(
            `<strong>${p.name}</strong> <span style="opacity:.7">(${p.boro})</span><br/>` +
              `Coverage: <strong>${p.ratio ?? "—"}</strong> sqft sidewalk / frontage ft<br/>` +
              `Per capita: <strong>${p.spc ?? "—"}</strong> sqft / resident<br/>` +
              `Population: ${Number(p.pop ?? 0).toLocaleString()}` +
              (p.inc ? `<br/>Median income (block-group med.): $${Number(p.inc).toLocaleString()}` : ""),
          );
        },
      });
      ntaLayerObj.current = lyr;
      groups.current.nta?.addLayer(lyr);
    } catch {
      /* ignore */
    }
  };

  const loadAda = async () => {
    if (loadedFlags.current.ada) return;
    loadedFlags.current.ada = true;
    setLoading("Loading ADA ramp gaps…");
    try {
      const gj = await fetchGeo("/layers/ada_gaps.geojson");
      const lyr = L.geoJSON(gj, {
        pane: "points",
        pointToLayer: (_f, latlng) =>
          L.circleMarker(latlng, { pane: "points", radius: 3.5, weight: 1.4, color: "#dc2626", fillColor: "#fecaca", fillOpacity: 0.85 }),
        onEachFeature: (f, l) => {
          const p = f.properties as Record<string, string | number>;
          const ll = pointLatLon(f as { geometry?: { type?: string; coordinates?: number[] } });
          l.bindPopup(
            `<strong>Intersection without any ramp</strong><br/>within 50 ft (of ${p.deg} legs)<br/>` +
              `<span style="opacity:.75">${p.nta} · ${p.boro}</span>` +
              (ll ? `<br/>${rentersLinkHtml(ll[0], ll[1])}` : ""),
          );
        },
      });
      groups.current.ada?.addLayer(lyr);
    } catch {
      /* ignore */
    } finally {
      setLoading(null);
    }
  };

  /** Sync layer presence with toggles + zoom gates + the one-hot coverage style. */
  const sync = (m: L.Map) => {
    const o = onRef.current;
    const z = m.getZoom();
    const setLayer = (g: L.LayerGroup | null, want: boolean) => {
      if (!g) return;
      const has = m.hasLayer(g);
      if (want && !has) m.addLayer(g);
      if (!want && has) m.removeLayer(g);
    };
    setLayer(groups.current.nta, o.nta);
    setLayer(groups.current.sai, o.sai);
    setLayer(groups.current.ada, o.ada && z >= ADA_MIN_ZOOM);

    // coverage overlay presence + one-hot style
    const cov = covLayer.current;
    if (cov) {
      const has = m.hasLayer(cov as unknown as L.Layer);
      if (o.coverage && !has) (cov as unknown as L.Layer).addTo(m);
      if (!o.coverage && has) m.removeLayer(cov as unknown as L.Layer);
    }
    const st = covStyle.current;
    const nextSaiActive = o.sai && o.coverage; // SAI wins the hot slot
    const nextWidth = widthModeRef.current && !nextSaiActive;
    if (st.saiActive !== nextSaiActive || st.widthMode !== nextWidth || st.theme !== effectiveTheme()) {
      st.saiActive = nextSaiActive;
      st.widthMode = nextWidth;
      st.theme = effectiveTheme();
      rerenderCov();
    }

    const notes: string[] = [];
    if (o.ada && z < ADA_MIN_ZOOM) notes.push(`zoom to ${ADA_MIN_ZOOM}+ for ramp gaps`);
    if (o.sai && o.coverage) notes.push("coverage dimmed while SAI is active (one-hot color)");
    setZoomNote(notes.length ? notes.join(" · ") : null);

    if (o.sai) void loadSai();
    if (o.nta) void loadNta();
    if (o.ada && z >= ADA_MIN_ZOOM) void loadAda();
  };

  const widthModeRef = useRef(widthMode);
  widthModeRef.current = widthMode;

  // toggles / width-mode / metric changes
  useEffect(() => {
    if (map.current) sync(map.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, widthMode]);

  useEffect(() => {
    ntaLayerObj.current?.setStyle((f) => ({
      pane: "nta", weight: 0.6, color: "#8aa0bd",
      fillColor: ntaColor((f?.properties as Record<string, number | null>)[ntaMetric] ?? null, ntaMetric),
      fillOpacity: 0.32,
    }));
  }, [ntaMetric]);

  const toggle = (k: keyof LayerState) => setOn((s) => ({ ...s, [k]: !s[k] }));
  const cb = (k: keyof LayerState, label: string) => (
    <label key={k} style={{ fontWeight: 600, display: "flex", gap: "0.35rem", alignItems: "center", marginBottom: "0.25rem" }}>
      <input type="checkbox" checked={on[k]} onChange={() => toggle(k)} style={{ width: "auto" }} />
      {label}
    </label>
  );

  const covHot = on.coverage && !(on.sai && on.coverage);
  const theme = covStyle.current.theme;

  return (
    <div className="nyc-map-wrap">
      <div className="nyc-map" ref={mapRef} />

      <div className="nyc-map-controls">
        {cb("coverage", "Sidewalk coverage (streets)")}
        {cb("sai", "Stop Accessibility Index")}
        {cb("nta", "Neighborhood equity")}
        {cb("ada", "ADA ramp gaps")}
        {covHot && (
          <div className="row" style={{ marginTop: "0.35rem" }}>
            <div className="rent-seg" role="group" aria-label="Coverage line width">
              <button type="button" className={!widthMode ? "on" : ""} onClick={() => setWidthMode(false)}>Color only</button>
              <button type="button" className={widthMode ? "on" : ""} onClick={() => setWidthMode(true)}>Width = sidewalk width</button>
            </div>
          </div>
        )}
        {on.nta && (
          <div className="row" style={{ marginTop: "0.35rem" }}>
            <label htmlFor="ntaMetric">Equity metric</label>
            <select id="ntaMetric" value={ntaMetric} onChange={(e) => setNtaMetric(e.target.value as "ratio" | "spc")}>
              <option value="ratio">Sidewalk per frontage foot</option>
              <option value="spc">Sidewalk sqft per resident</option>
            </select>
          </div>
        )}
        {loading && <div className="muted">{loading}</div>}
        {zoomNote && <div className="muted">{zoomNote}</div>}
      </div>

      <div className="nyc-legend" style={{ maxWidth: "min(76vw, 330px)" }}>
        {covHot && (
          <div>
            <span className="swatch" style={{ background: COV[theme].n, height: 5, width: 16, borderRadius: 1 }} />
            no sidewalk
            <span className="swatch" style={{ background: COV[theme].o, height: 4, width: 16, marginLeft: 8, borderRadius: 1 }} />
            one side
            <span className="swatch" style={{ background: COV[theme].b, height: 2, width: 16, marginLeft: 8, borderRadius: 1 }} />
            both sides
            {widthMode && <div style={{ opacity: 0.7, fontSize: "0.72rem", marginTop: 2 }}>line thickness ∝ √(sidewalk width)</div>}
          </div>
        )}
        {on.sai && (
          <div style={{ marginTop: covHot ? 4 : 0 }}>
            SAI:
            <span className="swatch" style={{ background: saiColor(10), marginLeft: 6 }} /> low
            <span className="swatch" style={{ background: saiColor(50), marginLeft: 6 }} /> mid
            <span className="swatch" style={{ background: saiColor(90), marginLeft: 6 }} /> high
            {on.coverage && <div style={{ opacity: 0.7, fontSize: "0.72rem", marginTop: 2 }}>coverage lines dimmed to neutral while SAI is active</div>}
          </div>
        )}
        {on.nta && (
          <div style={{ marginTop: 4 }}>
            Equity (soft bg):
            <span className="swatch" style={{ background: ntaColor(2, ntaMetric), marginLeft: 6 }} /> low
            <span className="swatch" style={{ background: ntaColor(ntaMetric === "ratio" ? 8 : 80, ntaMetric), marginLeft: 6 }} /> mid
            <span className="swatch" style={{ background: ntaColor(ntaMetric === "ratio" ? 13 : 140, ntaMetric), marginLeft: 6 }} /> high
          </div>
        )}
        {on.ada && (
          <div style={{ marginTop: 4 }}>
            <span className="swatch" style={{ background: "#fecaca", border: "1.4px solid #dc2626" }} />
            intersection lacking any ramp (50 ft)
          </div>
        )}
        {/* Per-layer data-vintage stamps (ARKMAP §3) */}
        <div className="attr">
          {covHot || (on.coverage && on.sai) ? (
            <div>
              Coverage: DCP planimetric 2022 · CSCL inkn-q76z (src {covMeta?.source_vintage ?? "2026-07"})
              {covMeta?.generated ? ` · tiled ${covMeta.generated.slice(0, 10)}` : ""}
            </div>
          ) : null}
          {on.sai && <div>SAI: analysis {saiMeta?.source_vintage ?? "2026-07-17"} · stops 2ucp-7wg5 · shelters t4f2-8md7</div>}
          {on.nta && <div>Equity: NTA 2020 · pop PL 94-171 (2020) · income ACS 2019-23</div>}
          {on.ada && <div>Ramps: DOT ufzp-rrqu (2026-07) · gaps = no ramp within 50 ft</div>}
          {basemap && <div>{basemap.vintageNote} · {basemap.attribution}</div>}
          <div>Coverage centerlines: vector tiles ({covMeta?.tippecanoe ?? "tippecanoe"}). Full resolution in the downloads below.</div>
        </div>
      </div>
    </div>
  );
}
