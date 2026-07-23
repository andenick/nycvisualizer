// Reliability ribbon (Q1.3) — the route's stop-pair segments drawn as Leaflet
// polylines, COLORED by peak weighted through-speed as a PERCENTILE within the
// route (diverging red→gray→blue, the Swiftly pattern). Live vehicles ride on top
// as ORIENTED ARROW markers (bearing from the realtime payload).
//
// Honesty: line WIDTH is constant / color-only. Per-segment passenger ridership is
// not derivable from the source (the analysis carries bus trip counts, not APC
// boardings), so no ridership width is shown — see the backend width_note. Single
// route → no tiling needed (plain polylines).
import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addBasemap, NYC_BOUNDS, type BasemapInfo } from "../lib/basemap";
import { getRibbon, getVehicles, streamVehicles, type RibbonResponse, type Vehicle } from "../lib/api";

// diverging: 0 (slowest on route) = red, 0.5 = neutral gray, 1 (fastest) = blue
const SLOW = "#c1272d", MID = "#cfcfcf", FAST = "#1a6fb5";
function lerp(a: string, b: string, t: number): string {
  const p = (c: string) => [1, 3, 5].map((j) => parseInt(c.slice(j, j + 2), 16));
  const pa = p(a), pb = p(b);
  const m = pa.map((x, i) => Math.round(x + (pb[i] - x) * t));
  return `rgb(${m[0]},${m[1]},${m[2]})`;
}
function speedColor(pct: number): string {
  const p = Math.max(0, Math.min(1, pct));
  return p < 0.5 ? lerp(SLOW, MID, p / 0.5) : lerp(MID, FAST, (p - 0.5) / 0.5);
}
function arrowIcon(color: string, bearing: number | null): L.DivIcon {
  const b = bearing ?? 0;
  return L.divIcon({
    className: "ribbon-veh-wrap",
    html:
      `<svg width="18" height="18" viewBox="0 0 16 16" style="transform:rotate(${b}deg)">` +
      `<path d="M8 1 L13 14 L8 10.5 L3 14 Z" fill="${color}" stroke="#ffffff" stroke-width="1.1" stroke-linejoin="round"/></svg>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

export default function ReliabilityRibbon({ route, displayName }: { route: string; displayName: string }) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const segLayer = useRef<L.LayerGroup | null>(null);
  const vehLayer = useRef<L.LayerGroup | null>(null);
  const [basemap, setBasemap] = useState<BasemapInfo | null>(null);
  const [data, setData] = useState<RibbonResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "empty">("loading");

  // ---- init ----
  useEffect(() => {
    if (map.current || !elRef.current) return;
    const m = L.map(elRef.current, {
      center: [40.75, -73.97], zoom: 12, minZoom: 9, maxZoom: 17,
      maxBounds: NYC_BOUNDS, maxBoundsViscosity: 0.5, preferCanvas: true,
    });
    setBasemap(addBasemap(m));
    segLayer.current = L.layerGroup().addTo(m);
    vehLayer.current = L.layerGroup().addTo(m);
    map.current = m;
    setTimeout(() => m.invalidateSize(), 60);
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // ---- ribbon segments ----
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    getRibbon(route)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        const g = segLayer.current;
        const m = map.current;
        if (!g || !m) return;
        g.clearLayers();
        if (!d.segments.length) {
          setStatus("empty");
          return;
        }
        const all: L.LatLng[] = [];
        for (const s of d.segments) {
          const line = s.coords.map((c) => L.latLng(c[0], c[1]));
          all.push(...line);
          L.polyline(line, {
            color: speedColor(s.speed_pctile),
            weight: 5,
            opacity: 0.9,
            lineCap: "round",
          })
            .bindPopup(
              `<strong>${s.from_stop} → ${s.to_stop}</strong><br/>` +
                `<strong>${s.wt_speed_mph} mph</strong> (peak, weighted)<br/>` +
                `<span style="opacity:.75">${Math.round(s.speed_pctile * 100)}th percentile speed on ${displayName}` +
                `${s.seg_miles != null ? ` · ${s.seg_miles} mi` : ""}</span>`,
            )
            .addTo(g);
        }
        if (all.length) m.fitBounds(L.latLngBounds(all).pad(0.12), { animate: false });
        setStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setStatus("empty");
      });
    return () => {
      cancelled = true;
    };
  }, [route, displayName]);

  // ---- live vehicles as oriented arrows ----
  useEffect(() => {
    let cancelled = false;
    const render = (vehicles: Vehicle[]) => {
      const g = vehLayer.current;
      if (!g) return;
      g.clearLayers();
      for (const v of vehicles) {
        if (v.route_id !== route) continue;
        L.marker([v.lat, v.lon], { icon: arrowIcon("#111827", v.bearing), keyboard: false })
          .bindPopup(
            `<strong>${displayName}</strong> vehicle <code>${v.vehicle_id}</code><br/>` +
              `Bearing ${v.bearing != null ? Math.round(v.bearing) + "°" : "—"}` +
              `${v.stop_id ? ` · next stop ${v.stop_id}` : ""}`,
          )
          .addTo(g);
      }
    };
    const pull = () => getVehicles().then((d) => !cancelled && render(d.vehicles)).catch(() => {});
    pull();
    const unsub = streamVehicles((d) => !cancelled && render(d.vehicles), () => {});
    const poll = setInterval(pull, 30000);
    return () => {
      cancelled = true;
      unsub();
      clearInterval(poll);
    };
  }, [route, displayName]);

  return (
    <section className="obs-panel" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "0.6rem 0.9rem 0.3rem" }}>
        <h3 style={{ margin: 0 }}>Reliability ribbon</h3>
        <p className="nyc-note" style={{ margin: "0.2rem 0 0", fontSize: "0.82rem" }}>
          Each stop-to-stop segment colored by its peak through-speed, ranked against this route.
          Live buses point in their direction of travel.
        </p>
      </div>
      <div className="nyc-map-wrap" style={{ height: 320, position: "relative" }}>
        <div className="nyc-map" ref={elRef} />
        {status === "empty" && (
          <div className="ops-hotmap-empty">No mapped segment speeds for {displayName} yet.</div>
        )}
        <div className="nyc-legend" style={{ maxWidth: "min(76vw, 300px)" }}>
          <div>
            Speed vs route:
            <span className="swatch" style={{ background: SLOW, marginLeft: 6 }} /> slow
            <span className="swatch" style={{ background: MID, marginLeft: 6 }} /> on-pace
            <span className="swatch" style={{ background: FAST, marginLeft: 6 }} /> fast
          </div>
          <div style={{ marginTop: 3 }}>
            <svg width="14" height="14" viewBox="0 0 16 16" style={{ verticalAlign: "middle" }}>
              <path d="M8 1 L13 14 L8 10.5 L3 14 Z" fill="#111827" stroke="#fff" strokeWidth="1.1" />
            </svg>{" "}
            live bus (points in travel direction)
          </div>
          {data && (
            <div className="attr">
              {data.n_placed} segments · route median {data.route_median_speed_mph ?? "—"} mph · color-only (width carries no
              ridership){basemap ? ` · ${basemap.attribution}` : ""}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
