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

/** Low-level: POST one {page, kind, detail, ua, ts, ...extra} event. Never throws. */
function post(kind: string, detail: string, page?: string, extra?: Record<string, unknown>): void {
  try {
    if (dnt()) return;
    const payload = JSON.stringify({
      page: page ?? (typeof location !== "undefined" ? location.pathname : ""),
      kind,
      detail: String(detail).slice(0, 300),
      ua: typeof navigator !== "undefined" ? navigator.userAgent.slice(0, 220) : "",
      ts: Math.floor(Date.now() / 1000),
      ...extra,
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

/** Fire one map-error telemetry beacon. `page` defaults to the current path. */
export function trackMapError(detail: string, page?: string): void {
  const key = (page ?? "") + "|" + detail;
  if (seen.has(key)) return; // dedupe: once per distinct detail per page-load
  seen.add(key);
  post("map_error", detail, page);
}

// --- bus_offline (Ant Farm v3 W1): a vehicle faded out after >3 missed ticks -----------
// Cheap + deduped: individual offline events are COALESCED and flushed at most once per
// window as a single {kind:"bus_offline", count} beacon, so a churny feed can't beacon in a
// loop. The renderer calls trackBusOffline() each time a bus is removed; we batch.
let _offlineCount = 0;
let _offlineTimer: ReturnType<typeof setTimeout> | null = null;
const OFFLINE_FLUSH_MS = 5000;
export function trackBusOffline(n = 1): void {
  _offlineCount += n;
  if (_offlineTimer) return; // a flush is already scheduled — just accumulate
  _offlineTimer = setTimeout(() => {
    const c = _offlineCount;
    _offlineCount = 0;
    _offlineTimer = null;
    if (c > 0) post("bus_offline", c + " bus" + (c === 1 ? "" : "es") + " went offline", undefined, { count: c });
  }, OFFLINE_FLUSH_MS);
}
