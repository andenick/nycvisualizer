// Sidewalk Explorer map — four real layers per ARKMAP_STANDARD:
//  1. SAI stops (13,621 pts, viridis by composite; popup = subscores)
//  2. Segment coverage classes (96,553 CSCL lines; per-borough lazy load, zoom-gated)
//  3. NTA equity choropleth (coverage per frontage ft / sqft per capita)
//  4. ADA ramp-gap intersections (6,086 pts, zoom-gated)
// Every layer carries its own data-vintage stamp in the legend (ARKMAP §3).
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addBasemap, NYC_CENTER, NYC_BOUNDS, type BasemapInfo } from "../lib/basemap";

const COV_COLORS: Record<string, string> = { b: "#16a34a", o: "#d97706", n: "#dc2626" };
const COV_MIN_ZOOM = 12;
const ADA_MIN_ZOOM = 13;

const BORO_FILES: { key: string; bbox: [number, number, number, number] }[] = [
  { key: "manhattan", bbox: [-74.05, 40.68, -73.9, 40.88] },
  { key: "bronx", bbox: [-73.94, 40.78, -73.75, 40.92] },
  { key: "brooklyn", bbox: [-74.06, 40.55, -73.83, 40.74] },
  { key: "queens", bbox: [-73.97, 40.53, -73.7, 40.81] },
  { key: "staten_island", bbox: [-74.26, 40.48, -74.03, 40.66] },
];

/** Viridis-ish colorblind-safe ramp for SAI 0..100. */
function saiColor(v: number): string {
  const stops: [number, string][] = [
    [0, "#440154"], [25, "#3b528b"], [50, "#21918c"], [75, "#5ec962"], [100, "#fde725"],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [v0, c0] = stops[i - 1];
      const [v1, c1] = stops[i];
      const t = (v - v0) / (v1 - v0);
      const p = (c: string) => [1, 3, 5].map((j) => parseInt(c.slice(j, j + 2), 16));
      const a = p(c0), b = p(c1);
      const mix = a.map((x, j) => Math.round(x + (b[j] - x) * t));
      return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
    }
  }
  return "#fde725";
}

function ntaColor(v: number | null, metric: "ratio" | "spc"): string {
  if (v == null) return "#9ca3af";
  // Blues ramp; domain per metric (ratio ~0-14 ft/ft, spc ~0-150 sqft/capita)
  const max = metric === "ratio" ? 14 : 150;
  const t = Math.max(0, Math.min(v / max, 1));
  const shades = ["#f1f5fb", "#c9d8f0", "#93b3e3", "#5c8bd4", "#2f5fb8", "#1e3a8a"];
  return shades[Math.min(Math.floor(t * shades.length), shades.length - 1)];
}

interface LayerState {
  sai: boolean;
  coverage: boolean;
  nta: boolean;
  ada: boolean;
}

export default function SidewalkMap() {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const groups = useRef<Record<keyof LayerState, L.LayerGroup | null>>({
    sai: null, coverage: null, nta: null, ada: null,
  });
  const loadedBoros = useRef<Set<string>>(new Set());
  const loadedFlags = useRef<{ sai: boolean; nta: boolean; ada: boolean }>({
    sai: false, nta: false, ada: false,
  });
  const [on, setOn] = useState<LayerState>({ sai: true, coverage: false, nta: true, ada: false });
  const onRef = useRef(on);
  onRef.current = on;
  const [ntaMetric, setNtaMetric] = useState<"ratio" | "spc">("ratio");
  const ntaMetricRef = useRef(ntaMetric);
  ntaMetricRef.current = ntaMetric;
  const ntaLayerObj = useRef<L.GeoJSON | null>(null);
  const [basemap, setBasemap] = useState<BasemapInfo | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [zoomNote, setZoomNote] = useState<string | null>(null);

  // ---- init ----
  useEffect(() => {
    if (map.current || !mapRef.current) return;
    const m = L.map(mapRef.current, {
      center: NYC_CENTER, zoom: 11, minZoom: 9, maxZoom: 17,
      maxBounds: NYC_BOUNDS, maxBoundsViscosity: 0.6, preferCanvas: true,
    });
    setBasemap(addBasemap(m));
    for (const k of ["nta", "coverage", "sai", "ada"] as (keyof LayerState)[]) {
      groups.current[k] = L.layerGroup();
    }
    m.on("zoomend moveend", () => sync(m));
    map.current = m;
    sync(m);
    return () => {
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
        pointToLayer: (f, latlng) => {
          const p = f.properties as Record<string, number | string>;
          return L.circleMarker(latlng, {
            radius: 4, weight: 0.8, color: "#1f2937",
            fillColor: saiColor(Number(p.sai)), fillOpacity: 0.9,
          });
        },
        onEachFeature: (f, l) => {
          const p = f.properties as Record<string, string | number>;
          const sub = (label: string, key: string) =>
            `<tr><td style="padding-right:8px">${label}</td><td><strong>${p[key]}</strong></td></tr>`;
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
              `</table><span style="opacity:.65;font-size:.8em">${Number(p.pop_400m).toLocaleString()} residents within 400 m</span></div>`,
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
        style: (f) => ({
          weight: 0.8,
          color: "#64748b",
          fillColor: ntaColor(
            (f?.properties as Record<string, number | null>)[ntaMetricRef.current] ?? null,
            ntaMetricRef.current,
          ),
          fillOpacity: 0.55,
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
        pointToLayer: (_f, latlng) =>
          L.circleMarker(latlng, {
            radius: 3.5, weight: 1.4, color: "#dc2626", fillColor: "#fecaca", fillOpacity: 0.85,
          }),
        onEachFeature: (f, l) => {
          const p = f.properties as Record<string, string | number>;
          l.bindPopup(
            `<strong>Intersection without any ramp</strong><br/>within 50 ft (of ${p.deg} legs)<br/>` +
              `<span style="opacity:.75">${p.nta} · ${p.boro}</span>`,
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

  const loadCoverageBoro = async (key: string) => {
    if (loadedBoros.current.has(key)) return;
    loadedBoros.current.add(key);
    setLoading(`Loading sidewalk coverage (${key.replace("_", " ")})…`);
    try {
      const gj = await fetchGeo(`/layers/coverage_seg_${key}.geojson`);
      const lyr = L.geoJSON(gj, {
        style: (f) => ({
          weight: 2,
          color: COV_COLORS[(f?.properties as { c: string }).c] ?? "#6b7280",
          opacity: 0.8,
        }),
      });
      groups.current.coverage?.addLayer(lyr);
    } catch {
      loadedBoros.current.delete(key);
    } finally {
      setLoading(null);
    }
  };

  /** Sync layer presence with toggles + zoom gates + viewport (lazy borough loads). */
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
    setLayer(groups.current.coverage, o.coverage && z >= COV_MIN_ZOOM);
    setLayer(groups.current.ada, o.ada && z >= ADA_MIN_ZOOM);

    const notes: string[] = [];
    if (o.coverage && z < COV_MIN_ZOOM) notes.push(`zoom to ${COV_MIN_ZOOM}+ for segments`);
    if (o.ada && z < ADA_MIN_ZOOM) notes.push(`zoom to ${ADA_MIN_ZOOM}+ for ramp gaps`);
    setZoomNote(notes.length ? notes.join(" · ") : null);

    if (o.sai) void loadSai();
    if (o.nta) void loadNta();
    if (o.ada && z >= ADA_MIN_ZOOM) void loadAda();
    if (o.coverage && z >= COV_MIN_ZOOM) {
      const b = m.getBounds();
      for (const { key, bbox } of BORO_FILES) {
        const inter =
          b.getWest() < bbox[2] && b.getEast() > bbox[0] && b.getSouth() < bbox[3] && b.getNorth() > bbox[1];
        if (inter) void loadCoverageBoro(key);
      }
    }
  };

  // toggles / metric changes
  useEffect(() => {
    if (map.current) sync(map.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);

  useEffect(() => {
    ntaLayerObj.current?.setStyle((f) => ({
      weight: 0.8,
      color: "#64748b",
      fillColor: ntaColor(
        (f?.properties as Record<string, number | null>)[ntaMetric] ?? null,
        ntaMetric,
      ),
      fillOpacity: 0.55,
    }));
  }, [ntaMetric]);

  const toggle = (k: keyof LayerState) => setOn((s) => ({ ...s, [k]: !s[k] }));
  const cb = (k: keyof LayerState, label: string) => (
    <label
      key={k}
      style={{ fontWeight: 600, display: "flex", gap: "0.35rem", alignItems: "center", marginBottom: "0.25rem" }}
    >
      <input type="checkbox" checked={on[k]} onChange={() => toggle(k)} style={{ width: "auto" }} />
      {label}
    </label>
  );

  return (
    <div className="nyc-map-wrap">
      <div className="nyc-map" ref={mapRef} />

      <div className="nyc-map-controls">
        {cb("sai", "Stop Accessibility Index")}
        {cb("coverage", "Sidewalk coverage (segments)")}
        {cb("nta", "Neighborhood equity")}
        {cb("ada", "ADA ramp gaps")}
        {on.nta && (
          <div className="row" style={{ marginTop: "0.35rem" }}>
            <label htmlFor="ntaMetric">Equity metric</label>
            <select
              id="ntaMetric"
              value={ntaMetric}
              onChange={(e) => setNtaMetric(e.target.value as "ratio" | "spc")}
            >
              <option value="ratio">Sidewalk per frontage foot</option>
              <option value="spc">Sidewalk sqft per resident</option>
            </select>
          </div>
        )}
        {loading && <div className="muted">{loading}</div>}
        {zoomNote && <div className="muted">{zoomNote}</div>}
      </div>

      <div className="nyc-legend" style={{ maxWidth: "min(76vw, 330px)" }}>
        {on.coverage && (
          <div>
            <span className="swatch" style={{ background: COV_COLORS.b }} />
            both sides
            <span className="swatch" style={{ background: COV_COLORS.o, marginLeft: 8 }} />
            one side
            <span className="swatch" style={{ background: COV_COLORS.n, marginLeft: 8 }} />
            none
          </div>
        )}
        {on.sai && (
          <div>
            SAI:
            <span className="swatch" style={{ background: saiColor(10), marginLeft: 6 }} />
            low
            <span className="swatch" style={{ background: saiColor(50), marginLeft: 6 }} />
            mid
            <span className="swatch" style={{ background: saiColor(90), marginLeft: 6 }} />
            high
          </div>
        )}
        {on.nta && (
          <div>
            Equity:
            <span className="swatch" style={{ background: ntaColor(2, ntaMetric), marginLeft: 6 }} />
            low
            <span className="swatch" style={{ background: ntaColor(ntaMetric === "ratio" ? 8 : 80, ntaMetric), marginLeft: 6 }} />
            mid
            <span className="swatch" style={{ background: ntaColor(ntaMetric === "ratio" ? 13 : 140, ntaMetric), marginLeft: 6 }} />
            high
          </div>
        )}
        {on.ada && (
          <div>
            <span className="swatch" style={{ background: "#fecaca", border: "1.4px solid #dc2626" }} />
            intersection lacking any ramp (50 ft)
          </div>
        )}
        {/* Per-layer data-vintage stamps (ARKMAP §3) */}
        <div className="attr">
          {on.sai && <div>SAI: analysis 2026-07-17 · stops 2ucp-7wg5 · shelters t4f2-8md7 (2025-10)</div>}
          {on.coverage && <div>Coverage: DCP planimetric 2022 flight · CSCL inkn-q76z (2026-07)</div>}
          {on.nta && <div>Equity: NTA 2020 · pop PL 94-171 (2020) · income ACS 2019-23</div>}
          {on.ada && <div>Ramps: DOT ufzp-rrqu (2026-07) · gaps = no ramp within 50 ft</div>}
          {basemap && <div>{basemap.vintageNote} · {basemap.attribution}</div>}
          <div>Web layers simplified for delivery — full resolution in the downloads below.</div>
        </div>
      </div>
    </div>
  );
}
