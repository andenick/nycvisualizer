// Self-hosted basemap for Leaflet — NO CDN (D3 rule).
//
// Primary path: a NYC-extent Protomaps vector basemap (.pmtiles), extracted from
// OpenStreetMap and served from /basemap/nyc-basemap.pmtiles in this app's own
// public tree. protomaps-leaflet reads the .pmtiles directly (HTTP range requests
// against our own origin) — no tile server, no third-party host.
//
// Fallback path (VITE_BASEMAP_MODE=raster-todo): OSM raster tiles. This DOES hit a
// third-party host and therefore VIOLATES the no-CDN rule — it exists only as a
// clearly-marked TODO-vendor escape hatch and must never be the shipped default.
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
  mode: "pmtiles" | "raster-todo";
  attribution: string;
  vintageNote: string;
}

/** Add the basemap layer to a map and return metadata for the legend/attribution. */
export function addBasemap(map: L.Map): BasemapInfo {
  if (BASEMAP_MODE === "raster-todo") {
    // TODO-VENDOR (D3 gap): raster tiles hit a third-party CDN. Replace before ship.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors (TODO: vendor tiles — D3 gap)",
    }).addTo(map);
    return {
      mode: "raster-todo",
      attribution: "© OpenStreetMap contributors",
      vintageNote: "Basemap: OSM raster (TODO-vendor — not no-CDN compliant)",
    };
  }

  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  const layer = leafletLayer({
    url: BASEMAP_URL,
    flavor: prefersDark ? "dark" : "light",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Protomaps',
  });
  layer.addTo(map);

  return {
    mode: "pmtiles",
    attribution: "© OpenStreetMap · Protomaps",
    vintageNote: "Basemap: Protomaps/OSM vector (self-hosted pmtiles, NYC extent)",
  };
}
