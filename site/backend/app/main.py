"""nycvisualizer backend — FastAPI.

Holds all server-side keys; the browser talks only to this service. Serves live bus
vehicle positions (archive-first, GTFS-RT fallback), an SSE stream, service alerts,
GTFS route catalog + per-route shapes/stops, and an on-demand SIRI arrivals proxy.
"""
from __future__ import annotations

import asyncio
import json
import time

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from . import (busshapes, changes, config, downloads, gtfs, isochrone, obs, opswall,
               realtime, renters, runtime, siri, subway)

app = FastAPI(title="nycvisualizer API", version="0.1.0")

# F3 capacity: serve the RT poll payloads from an in-process single-flight TTL cache
# so the heavy duckdb/parquet read runs at most once per RT_CACHE_TTL_S regardless of
# how many users are polling. bbox filtering (below) is applied to the cached payload.
_vehicles_cache = runtime.TTLCache(realtime.get_vehicles, config.RT_CACHE_TTL_S)
_subway_cache = runtime.TTLCache(subway.get_subway, config.RT_CACHE_TTL_S)

# Origin-side edge-cache hint (works even before any Cloudflare Cache Rule): CF/other
# shared caches may serve up to s-maxage seconds fresh, then swr while revalidating.
_RT_CACHE_CONTROL = (
    f"public, s-maxage={config.RT_CACHE_TTL_S}, "
    f"stale-while-revalidate={config.RT_CACHE_TTL_S * 2}"
)

# Bus Observatory (S5): /api/obs/* — dossier, Marey, headways, league tables.
app.include_router(obs.router)

# Renter's Map (S7): /api/renters/* — location profile + two-location compare.
app.include_router(renters.router)

# Live Ops Wall (S6): /api/wall — one aggregate control-room JSON + SSE.
app.include_router(opswall.router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# Q0.6.3: keep /api/wall warm so a cold visitor gets the cached aggregate
# (~ms) instead of paying the full 2-3s build. The Caddy edge does not cache
# /api/*, so warming happens here, just under the 25s cache TTL.
_wall_warm_task: "asyncio.Task | None" = None


@app.on_event("startup")
async def _start_wall_warmer() -> None:
    async def loop() -> None:
        while True:
            try:
                await asyncio.to_thread(opswall.get_wall, True)  # force refresh
            except Exception:
                pass  # never let the warmer die on a transient build error
            await asyncio.sleep(25)

    global _wall_warm_task
    _wall_warm_task = asyncio.create_task(loop())


@app.on_event("shutdown")
async def _stop_wall_warmer() -> None:
    if _wall_warm_task is not None:
        _wall_warm_task.cancel()


def _healthz_payload() -> dict:
    archive_ok = config.REALTIME_ARCHIVE.exists()
    gtfs_ok = config.GTFS_STATIC_ROOT.exists()
    return {
        "status": "ok",
        "service": "nycvisualizer-api",
        "version": "0.1.0",
        "archive_present": archive_ok,
        "gtfs_static_present": gtfs_ok,
        "bustime_key_configured": bool(config.MTA_BUSTIME_KEY),
        "ts": int(time.time()),
    }


@app.get("/healthz")
def healthz() -> dict:
    return _healthz_payload()


# Q0.7: edge-reachable health alias. Caddy's SPA try_files shadows a bare
# /healthz at the edge, so probes/runbook use /api/healthz (already inside the
# proxied /api/* prefix). The Caddyfile also rewrites /api/healthz -> /healthz;
# defining it here too keeps local/dev (no Caddy) consistent.
@app.get("/api/healthz")
def api_healthz() -> dict:
    return _healthz_payload()


_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def _sse_over_cap() -> JSONResponse:
    """Uniform 429 when the per-worker SSE ceiling is reached. Clients fall back to
    the (edge-cached) poll path automatically — the native EventSource fires onerror
    on the non-2xx and the caller's poll timer covers the gap."""
    return JSONResponse(
        {
            "error": "SSE capacity reached — poll the equivalent /api/rt endpoint instead.",
            "retry_after": 30,
        },
        status_code=429,
        headers={"Retry-After": "30"},
    )


@app.get("/api/rt/vehicles")
async def rt_vehicles(bbox: str | None = None) -> JSONResponse:
    data = await _vehicles_cache.get()
    data = runtime.filter_bbox(data, "vehicles", runtime.parse_bbox(bbox))
    return JSONResponse(data, headers={"Cache-Control": _RT_CACHE_CONTROL})


@app.get("/api/rt/vehicles/stream")
async def rt_vehicles_stream(request: Request):
    if not runtime.sse_limiter.try_acquire():
        return _sse_over_cap()

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await _vehicles_cache.get()
                    yield f"data: {json.dumps(data)}\n\n"
                except Exception:
                    yield "event: error\ndata: {}\n\n"
                await asyncio.sleep(config.SSE_INTERVAL_S)
        finally:
            runtime.sse_limiter.release()

    return StreamingResponse(gen(), media_type="text/event-stream", headers=_SSE_HEADERS)


@app.get("/api/rt/subway")
async def rt_subway(bbox: str | None = None) -> JSONResponse:
    data = await _subway_cache.get()
    data = runtime.filter_bbox(data, "trains", runtime.parse_bbox(bbox))
    return JSONResponse(data, headers={"Cache-Control": _RT_CACHE_CONTROL})


@app.get("/api/rt/subway/stream")
async def rt_subway_stream(request: Request):
    if not runtime.sse_limiter.try_acquire():
        return _sse_over_cap()

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    data = await _subway_cache.get()
                    yield f"data: {json.dumps(data)}\n\n"
                except Exception:
                    yield "event: error\ndata: {}\n\n"
                await asyncio.sleep(config.SSE_INTERVAL_S)
        finally:
            runtime.sse_limiter.release()

    return StreamingResponse(gen(), media_type="text/event-stream", headers=_SSE_HEADERS)


@app.get("/api/stations")
async def stations() -> JSONResponse:
    data = await asyncio.to_thread(subway.get_station_catalog)
    return JSONResponse(data)


@app.get("/api/stations/{station_id}/arrivals")
async def station_arrivals(station_id: str) -> JSONResponse:
    data = await asyncio.to_thread(subway.get_station_arrivals, station_id)
    return JSONResponse(data)


@app.get("/api/rt/alerts")
async def rt_alerts() -> JSONResponse:
    data = await asyncio.to_thread(realtime.get_alerts)
    return JSONResponse(data)


@app.get("/api/routes")
async def routes() -> JSONResponse:
    data = await asyncio.to_thread(gtfs.get_route_catalog)
    return JSONResponse(data)


@app.get("/api/routes/{route_id}")
async def route_shape(route_id: str) -> JSONResponse:
    data = await asyncio.to_thread(gtfs.get_route_shape, route_id)
    return JSONResponse(data)


@app.get("/api/rt/route_shapes")
async def rt_route_shapes(route: str, direction: int | None = None) -> JSONResponse:
    """The exact decimated shape polyline(s) that /api/rt/vehicles' route_offset_ft is measured
    against, with a cumulative offset_ft per vertex — so the motion client can place a bus at
    its route_offset_ft along the same geometry. Served from the startup bus-shape LUT."""
    data = await asyncio.to_thread(busshapes.route_shape_latlon, route, direction)
    return JSONResponse(data, headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/stops/{stop_id}/arrivals")
async def stop_arrivals(stop_id: str) -> JSONResponse:
    data = await asyncio.to_thread(siri.get_arrivals, stop_id)
    return JSONResponse(data)


@app.get("/api/isochrone")
async def api_isochrone(
    lat: float,
    lon: float,
    minutes: int = 45,
    depart: str = "weekday_8am",
) -> JSONResponse:
    """Transit isochrone (WALK+TRANSIT) as GeoJSON polygons. 503 if OTP is down."""
    try:
        data = await asyncio.to_thread(
            isochrone.get_isochrone, lat, lon, minutes, depart
        )
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except isochrone.OTPUnavailable as e:
        return JSONResponse(
            {
                "error": "Routing engine unavailable — no isochrone can be computed "
                "right now. This endpoint never returns estimated polygons.",
                "detail": str(e),
            },
            status_code=503,
        )
    return JSONResponse(data)


@app.get("/api/downloads")
async def downloads_inventory() -> JSONResponse:
    return JSONResponse(downloads.inventory())


@app.api_route("/api/downloads/{key}", methods=["GET", "HEAD"])
async def download_file(key: str):
    from fastapi.responses import FileResponse

    hit = downloads.resolve(key)
    if hit is None:
        return JSONResponse({"error": "unknown download key"}, status_code=404)
    path, media_type = hit
    return FileResponse(path, media_type=media_type, filename=path.name)


@app.get("/api/changes")
async def api_changes(
    page: int = 1,
    page_size: int = 50,
    feed: str | None = None,
    route: str | None = None,
    change_type: str | None = None,
    borough: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    include_proof: bool = False,
) -> JSONResponse:
    """Paginated, filterable list of detected GTFS service changes (S3 diff outputs)."""
    data = await asyncio.to_thread(
        changes.query,
        page=page,
        page_size=page_size,
        feed=feed,
        route=route,
        change_type=change_type,
        borough=borough,
        date_from=date_from,
        date_to=date_to,
        include_proof=include_proof,
    )
    return JSONResponse(data)


@app.get("/api/changes/feed.json")
async def api_changes_feed() -> JSONResponse:
    """Machine feed: newest 200 detected changes (proof backfill excluded)."""
    data = await asyncio.to_thread(changes.machine_feed, 200)
    return JSONResponse(data)


@app.get("/api/changes/rss")
async def api_changes_rss(route: str | None = None) -> Response:
    """RSS 2.0 feed of detected changes; `?route=M15` for a per-route watch feed."""
    xml = await asyncio.to_thread(changes.rss, route, 200)
    return Response(
        content=xml,
        media_type="application/rss+xml; charset=utf-8",
        headers={"Cache-Control": "max-age=300"},
    )


def _append_track_line(raw: bytes) -> None:
    """Append one telemetry event as a greppable JSONL line. Best-effort: any failure
    (bad JSON, unwritable path, oversize) is swallowed so telemetry never 5xxs a client.
    Line format: `<iso_ts>\\tkind=<kind>\\t<json>` so the documented
    `grep kind=map_error` matches literally AND the payload stays machine-parseable."""
    try:
        if len(raw) > 4096:  # cap: drop obviously-oversize bodies
            return
        evt = json.loads(raw.decode("utf-8", "replace"))
        if not isinstance(evt, dict):
            return
        kind = str(evt.get("kind", "event"))[:64]
        evt["server_ts"] = int(time.time())
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        line = f"{ts}\tkind={kind}\t{json.dumps(evt, separators=(',', ':'), ensure_ascii=False)}\n"
        path = config.TELEMETRY_LOG
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(line)
    except Exception:
        pass  # telemetry must never break a request


@app.post("/__track")
async def track(request: Request) -> Response:
    # First-party telemetry sink (ArkTriad triad beacon + F5 map-error beacon). Events
    # are appended as greppable JSONL to config.TELEMETRY_LOG (see REFRESH.md ops).
    try:
        raw = await request.body()
    except Exception:
        return Response(status_code=204)
    if raw:
        await asyncio.to_thread(_append_track_line, raw)
    return Response(status_code=204)
