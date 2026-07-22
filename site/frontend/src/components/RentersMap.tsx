// Renter's Map map panel. Real layers over the self-hosted pmtiles basemap:
//   * location marker(s) — A (and B in compare)
//   * 45-min / weekday-8am transit isochrone from the profile (inline); 30- and
//     60-min variants fetched on demand from /api/isochrone and cached
//   * nearest bus stops as dots colored by Stop Access Index (viridis)
//   * a point-level flood-exposure ring (toggle) — the profile ships flood FLAGS
//     for the location, not a citywide flood polygon, so the map shows the point
// Click anywhere (single-location mode) to profile that spot.
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addBasemap, NYC_CENTER, NYC_BOUNDS, type BasemapInfo } from "../lib/basemap";
import { saiColor, wktToLatLngs } from "../lib/renters";
import { getIsochrone, type RenterProfile, type RenterIsochrone } from "../lib/api";

const A_COLOR = "#2563eb"; // side A (accent)
const B_COLOR = "#9333ea"; // side B (violet) — categorical, not moral

/** Extract [lat,lon] ring-polygons from either an OTP GeoJSON isochrone or the
 *  approximate WKT fallback. Returns [] if nothing renderable. */
function isoPolys(iso: RenterIsochrone | null | undefined): [number, number][][][] {
  if (!iso) return [];
  if (iso.geometry_wkt) return wktToLatLngs(iso.geometry_wkt);
  type Geom = { type?: string; coordinates?: unknown };
  const gj = iso.geojson as
    | { type?: string; features?: { geometry?: Geom }[]; geometry?: Geom; coordinates?: unknown }
    | undefined;
  if (!gj) return [];
  const geoms: Geom[] = [];
  if (gj.type === "FeatureCollection" && gj.features) geoms.push(...gj.features.map((f) => f.geometry ?? {}));
  else if (gj.type === "Feature" && gj.geometry) geoms.push(gj.geometry);
  else if (gj.type && gj.coordinates) geoms.push(gj as Geom);
  const out: [number, number][][][] = [];
  const ring = (coords: number[][]): [number, number][] =>
    coords.map((c) => [c[1], c[0]] as [number, number]);
  for (const g of geoms) {
    if (g.type === "Polygon") out.push((g.coordinates as number[][][]).map(ring));
    else if (g.type === "MultiPolygon")
      for (const poly of g.coordinates as number[][][][]) out.push(poly.map(ring));
  }
  return out;
}

interface Props {
  primary: RenterProfile | null;
  secondary?: RenterProfile | null;
  compare: boolean;
  onPick?: (lat: number, lon: number) => void;
}

export default function RentersMap({ primary, secondary, compare, onPick }: Props) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const markerLayer = useRef<L.LayerGroup | null>(null);
  const isoLayer = useRef<L.LayerGroup | null>(null);
  const stopLayer = useRef<L.LayerGroup | null>(null);
  const floodLayer = useRef<L.LayerGroup | null>(null);
  const [basemap, setBasemap] = useState<BasemapInfo | null>(null);
  const [minutes, setMinutes] = useState<30 | 45 | 60>(45);
  const [showStops, setShowStops] = useState(true);
  const [showFlood, setShowFlood] = useState(true);
  const [isoBusy, setIsoBusy] = useState(false);
  const [isoNote, setIsoNote] = useState<string | null>(null);
  // client-side isochrone cache keyed by lat|lon|minutes
  const isoCache = useRef<Map<string, RenterIsochrone>>(new Map());
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const compareRef = useRef(compare);
  compareRef.current = compare;

  // ---- init ----
  useEffect(() => {
    if (map.current || !mapRef.current) return;
    const m = L.map(mapRef.current, {
      center: NYC_CENTER,
      zoom: 11,
      minZoom: 9,
      maxZoom: 18,
      maxBounds: NYC_BOUNDS,
      maxBoundsViscosity: 0.6,
    });
    setBasemap(addBasemap(m));
    markerLayer.current = L.layerGroup().addTo(m);
    isoLayer.current = L.layerGroup().addTo(m);
    stopLayer.current = L.layerGroup().addTo(m);
    floodLayer.current = L.layerGroup().addTo(m);
    m.on("click", (e: L.LeafletMouseEvent) => {
      if (compareRef.current) return; // compare is address-driven
      onPickRef.current?.(+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6));
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // ---- markers ----
  useEffect(() => {
    const g = markerLayer.current;
    if (!g || !map.current) return;
    g.clearLayers();
    const pts: L.LatLng[] = [];
    const place = (p: RenterProfile | null | undefined, color: string, tag: string) => {
      if (!p || p.error || !p.query) return;
      const { lat, lon } = p.query;
      const ll = L.latLng(lat, lon);
      pts.push(ll);
      L.marker(ll, {
        icon: L.divIcon({
          className: "nyc-bullet-wrap",
          html: `<div class="rent-pin" style="background:${color}"><span>${tag}</span></div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 22],
        }),
      }).addTo(g);
    };
    place(primary, A_COLOR, compare ? "A" : "");
    if (compare) place(secondary, B_COLOR, "B");
    if (pts.length === 1) map.current.setView(pts[0], Math.max(map.current.getZoom(), 14), { animate: true });
    else if (pts.length > 1) map.current.fitBounds(L.latLngBounds(pts).pad(0.35), { animate: true });
  }, [primary, secondary, compare]);

  // ---- isochrone (45 inline; 30/60 lazy) ----
  useEffect(() => {
    const g = isoLayer.current;
    if (!g || !map.current) return;
    let cancelled = false;

    const draw = (polys: [number, number][][][], color: string, approx: boolean) => {
      for (const poly of polys) {
        L.polygon(poly, {
          color,
          weight: 1.5,
          opacity: 0.9,
          fillColor: color,
          fillOpacity: 0.14,
          dashArray: approx ? "5,5" : undefined,
          interactive: false,
        }).addTo(g);
      }
    };

    const run = async () => {
      g.clearLayers();
      setIsoNote(null);
      // Side A
      if (primary && !primary.error && primary.query) {
        const { lat, lon } = primary.query;
        let iso: RenterIsochrone | null | undefined;
        if (minutes === 45) {
          iso = primary.isochrone_45min_8am;
        } else {
          const key = `${lat}|${lon}|${minutes}`;
          iso = isoCache.current.get(key);
          if (!iso) {
            setIsoBusy(true);
            try {
              const gj = await getIsochrone(lat, lon, minutes);
              iso = { source: "live_otp", approximate: false, geojson: gj };
              isoCache.current.set(key, iso);
            } catch {
              iso = { source: "unavailable", approximate: true, note: "routing engine busy" };
            } finally {
              if (!cancelled) setIsoBusy(false);
            }
          }
        }
        if (cancelled) return;
        const polys = isoPolys(iso);
        if (polys.length) draw(polys, A_COLOR, !!iso?.approximate);
        if (iso?.approximate)
          setIsoNote(
            iso.note ??
              "Approximate: routing engine unreachable — showing the precomputed reachable area for this grid cell.",
          );
      }
      // Side B (compare) — always its inline 45-min
      if (compare && secondary && !secondary.error && secondary.query) {
        const polys = isoPolys(secondary.isochrone_45min_8am);
        if (polys.length) draw(polys, B_COLOR, !!secondary.isochrone_45min_8am?.approximate);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [primary, secondary, compare, minutes]);

  // ---- stops ----
  // The profile's nearest_stops_detail carries names + SAI but NO coordinates, so
  // geographic dots come from the shipped SAI stop layer, filtered to a ~450 m box
  // around each queried point and colored by the same viridis SAI ramp.
  const saiStops = useRef<{ lat: number; lon: number; props: Record<string, unknown> }[] | null>(null);
  const saiStopsLoading = useRef(false);
  useEffect(() => {
    const g = stopLayer.current;
    if (!g) return;
    let cancelled = false;

    const render = () => {
      if (cancelled) return;
      g.clearLayers();
      if (!showStops || !saiStops.current) return;
      const BOX = 0.006; // ~ 450–500 m in lat; a touch wider in lon at NYC latitude
      const near = (p: RenterProfile | null | undefined) => {
        if (!p || p.error || !p.query) return;
        const { lat, lon } = p.query;
        for (const s of saiStops.current!) {
          if (Math.abs(s.lat - lat) > BOX || Math.abs(s.lon - lon) > BOX * 1.3) continue;
          const sai = Number(s.props.sai);
          if (!Number.isFinite(sai)) continue;
          L.circleMarker([s.lat, s.lon], {
            radius: 5,
            weight: 1,
            color: "#1f2937",
            fillColor: saiColor(sai),
            fillOpacity: 0.92,
          })
            .bindPopup(
              `<strong>${s.props.stop_name ?? "Bus stop"}</strong><br/>` +
                `<span style="opacity:.75">${s.props.routes ?? ""} · ${s.props.borough ?? ""}</span><br/>` +
                `<strong>SAI ${Math.round(sai)}</strong> / 100`,
            )
            .addTo(g);
        }
      };
      near(primary);
      if (compare) near(secondary);
    };

    if (showStops && !saiStops.current && !saiStopsLoading.current) {
      saiStopsLoading.current = true;
      fetch("/layers/sai_stops.min.geojson")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("sai_stops"))))
        .then((gj: { features?: { geometry?: { coordinates?: [number, number] }; properties?: Record<string, unknown> }[] }) => {
          saiStops.current = (gj.features ?? [])
            .filter((f) => f.geometry?.coordinates)
            .map((f) => ({
              lon: f.geometry!.coordinates![0],
              lat: f.geometry!.coordinates![1],
              props: f.properties ?? {},
            }));
          render();
        })
        .catch(() => {
          /* stop layer unavailable; scorecard still lists nearest stops */
        });
    } else {
      render();
    }
    return () => {
      cancelled = true;
    };
  }, [primary, secondary, compare, showStops]);

  // ---- flood ring ----
  useEffect(() => {
    const g = floodLayer.current;
    if (!g) return;
    g.clearLayers();
    if (!showFlood) return;
    const ring = (p: RenterProfile | null | undefined) => {
      if (!p || p.error || !p.query || !p.flood?.any_flag) return;
      const { lat, lon } = p.query;
      L.circle([lat, lon], {
        radius: 140,
        color: "#0369a1",
        weight: 2,
        dashArray: "4,4",
        fillColor: "#38bdf8",
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(g);
    };
    ring(primary);
    if (compare) ring(secondary);
  }, [primary, secondary, compare, showFlood]);

  const approxA = primary?.isochrone_45min_8am?.approximate;

  return (
    <div className="nyc-map-wrap">
      <div className="nyc-map" ref={mapRef} />

      <div className="nyc-map-controls">
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Reachable in</div>
        <div className="rent-seg" role="group" aria-label="Isochrone minutes">
          {[30, 45, 60].map((mn) => (
            <button
              key={mn}
              type="button"
              className={minutes === mn ? "on" : ""}
              disabled={compare && mn !== 45}
              onClick={() => setMinutes(mn as 30 | 45 | 60)}
            >
              {mn}m
            </button>
          ))}
        </div>
        <label style={{ marginTop: 6 }}>
          <input type="checkbox" checked={showStops} onChange={() => setShowStops((v) => !v)} style={{ width: "auto" }} />{" "}
          Nearest stops
        </label>
        <label>
          <input type="checkbox" checked={showFlood} onChange={() => setShowFlood((v) => !v)} style={{ width: "auto" }} />{" "}
          Flood exposure
        </label>
        {isoBusy && <div className="muted">Computing isochrone…</div>}
        {compare && <div className="muted">45-min shown for both in compare</div>}
      </div>

      <div className="nyc-legend" style={{ maxWidth: "min(76vw, 320px)" }}>
        <div>
          <span className="swatch" style={{ background: A_COLOR }} /> Reachable area (A){approxA ? " · approx" : ""}
          {compare && (
            <>
              <br />
              <span className="swatch" style={{ background: B_COLOR }} /> Reachable area (B)
            </>
          )}
        </div>
        <div style={{ marginTop: 4 }}>
          SAI stops:
          <span className="swatch" style={{ background: saiColor(10), marginLeft: 6 }} /> low
          <span className="swatch" style={{ background: saiColor(50), marginLeft: 6 }} /> mid
          <span className="swatch" style={{ background: saiColor(90), marginLeft: 6 }} /> high
        </div>
        {showFlood && (
          <div style={{ marginTop: 4 }}>
            <span className="swatch" style={{ background: "#38bdf8", border: "2px dashed #0369a1" }} /> mapped flood exposure
          </div>
        )}
        {isoNote && <div className="attr" style={{ color: "#b45309" }}>{isoNote}</div>}
        <div className="attr">
          Isochrone: OpenTripPlanner (WALK+TRANSIT), weekday 8am · jobs LODES WAC
          {basemap && (
            <>
              <br />
              {basemap.vintageNote} · {basemap.attribution}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
