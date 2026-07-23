import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { addBasemap, NYC_CENTER, NYC_BOUNDS } from "../lib/basemap";
import type { WallHotspot } from "../lib/api";

const SEV_COLOR: Record<string, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#eab308",
};
// Q1.5: connector-line width by severity (redundant channel — the amber/yellow
// medium↔low hues are close, so weight also carries severity, not color alone).
const SEV_WEIGHT: Record<string, number> = { high: 5, medium: 3.5, low: 2.5 };

// Small ops map: live bunching-pair midpoints as pulsing markers colored by severity.
// Reuses the shared pmtiles basemap plumbing (no CDN). Degrades to an empty basemap
// when there are no active pairs.
export default function OpsHotspotMap({ hotspots }: { hotspots: WallHotspot[] }) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (mapRef.current || !elRef.current) return;
    const m = L.map(elRef.current, {
      center: NYC_CENTER,
      zoom: 11,
      minZoom: 9,
      maxZoom: 16,
      maxBounds: NYC_BOUNDS,
      maxBoundsViscosity: 0.6,
      zoomControl: false,
      attributionControl: false,
    });
    addBasemap(m);
    L.control.zoom({ position: "bottomright" }).addTo(m);
    layerRef.current = L.layerGroup().addTo(m);
    mapRef.current = m;
    // Leaflet needs a size recalc once the flex layout settles.
    setTimeout(() => m.invalidateSize(), 60);
    return () => {
      m.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    layer.clearLayers();
    for (const h of hotspots) {
      const color = SEV_COLOR[h.severity] ?? "#eab308";
      // Q1.5: the bunching CONNECTOR — the gap between the two buses becomes the
      // mark. Drawn under the pulsing midpoint dot; degrades gracefully when an
      // older cached payload lacks the per-bus coords.
      if (h.lat_a != null && h.lon_a != null && h.lat_b != null && h.lon_b != null) {
        L.polyline(
          [
            [h.lat_a, h.lon_a],
            [h.lat_b, h.lon_b],
          ],
          {
            color,
            weight: SEV_WEIGHT[h.severity] ?? 2.5,
            opacity: 0.85,
            lineCap: "round",
            interactive: false,
          },
        ).addTo(layer);
      }
      const icon = L.divIcon({
        className: "ops-hot-wrap",
        html: `<span class="ops-hot ${h.severity}" style="--hc:${color}"></span>`,
        iconSize: [14, 14],
        iconAnchor: [7, 7],
      });
      L.marker([h.lat, h.lon], { icon, keyboard: false })
        .bindPopup(
          `<strong>${h.route}</strong> dir ${h.direction}<br/>` +
            `two buses ${h.gap_m} m apart<br/>` +
            `<span style="opacity:.75">scheduled headway ${Math.round(
              h.sched_headway_s / 60,
            )} min · ${h.severity}</span>`,
        )
        .addTo(layer);
    }
  }, [hotspots]);

  return (
    <div className="ops-hotmap-wrap">
      <div className="ops-hotmap" ref={elRef} />
      {hotspots.length === 0 && <div className="ops-hotmap-empty">No active bunching pairs right now.</div>}
    </div>
  );
}
