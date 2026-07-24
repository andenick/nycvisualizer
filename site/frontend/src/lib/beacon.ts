// F5 reliability — client error beacon.
//
// Map pages POST small {page, kind, detail, ua} events to the first-party /__track
// sink so map-render failures are greppable on the box (see REFRESH.md: "grep the box
// telemetry for kind=map_error"). Transport mirrors the ArkTriad beacon: sendBeacon →
// fetch keepalive fallback, DNT/GPC respected, and telemetry must NEVER break a page.
//
// All map-reliability events use kind="map_error" (the documented grep key); the
// specific event lives in `detail`, e.g.:
//   init:<message>            caught map-init error
//   fallback:<reason>         reliability guard swapped to the raster basemap
//   zero_tiles:<detail>       no basemap pixels painted after 10s
//   sse_down:<path>           SSE permanently down (>5 consecutive failures)

const TRACK_URL = (import.meta.env.VITE_API_BASE ?? "") + "/__track";

// Dedupe: fire each distinct detail at most once per page-load (a broken basemap or a
// dead SSE would otherwise beacon on a loop).
const seen = new Set<string>();

function dnt(): boolean {
  try {
    return (
      navigator.doNotTrack === "1" ||
      (window as unknown as { doNotTrack?: string }).doNotTrack === "1" ||
      (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl === true
    );
  } catch {
    return false;
  }
}

/** Fire one map-error telemetry beacon. `page` defaults to the current path. */
export function trackMapError(detail: string, page?: string): void {
  try {
    if (dnt()) return;
    const key = (page ?? "") + "|" + detail;
    if (seen.has(key)) return;
    seen.add(key);
    const payload = JSON.stringify({
      page: page ?? (typeof location !== "undefined" ? location.pathname : ""),
      kind: "map_error",
      detail: String(detail).slice(0, 300),
      ua: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 220) : "",
      ts: Math.floor(Date.now() / 1000),
    });
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon(TRACK_URL, new Blob([payload], { type: "application/json" }));
    } else if (typeof fetch === "function") {
      fetch(TRACK_URL, {
        method: "POST",
        body: payload,
        keepalive: true,
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
      }).catch(() => {});
    }
  } catch {
    /* telemetry must never break a page */
  }
}
