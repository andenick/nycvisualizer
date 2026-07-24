/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_BASEMAP_URL?: string;
  readonly VITE_BASEMAP_MODE?: string; // "pmtiles" (default) | "raster-todo"
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// NOTE (W0, 2026-07-24): protomaps-leaflet is deliberately NOT stubbed here. It ships real
// types (`dist/esm/index.d.ts`), and an `any` stub is what let `theme:` vs `flavor:` — an
// option-name mistake that silently blanks the entire basemap — sail past `tsc` twice. With
// the real types, passing an unknown option to `leafletLayer()` is a COMPILE ERROR.
// Do not re-add `declare module "protomaps-leaflet";`.
declare module "plotly.js-dist-min";
declare module "*.html?raw" {
  const html: string;
  export default html;
}
