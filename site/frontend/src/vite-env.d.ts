/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_BASEMAP_URL?: string;
  readonly VITE_BASEMAP_MODE?: string; // "pmtiles" (default) | "raster-todo"
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "protomaps-leaflet";
declare module "plotly.js-dist-min";
declare module "*.html?raw" {
  const html: string;
  export default html;
}
