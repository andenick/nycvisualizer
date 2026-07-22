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

from . import changes, config, downloads, gtfs, isochrone, obs, opswall, realtime, renters, siri, subway

app = FastAPI(title="nycvisualizer API", version="0.1.0")

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


@app.get("/healthz")
def healthz() -> dict:
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


@app.get("/api/rt/vehicles")
async def rt_vehicles() -> JSONResponse:
    data = await asyncio.to_thread(realtime.get_vehicles)
    return JSONResponse(data)


@app.get("/api/rt/vehicles/stream")
async def rt_vehicles_stream(request: Request) -> StreamingResponse:
    async def gen():
        while True:
            if await request.is_disconnected():
                break
            try:
                data = await asyncio.to_thread(realtime.get_vehicles)
                yield f"data: {json.dumps(data)}\n\n"
            except Exception:
                yield "event: error\ndata: {}\n\n"
            await asyncio.sleep(config.SSE_INTERVAL_S)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/rt/subway")
async def rt_subway() -> JSONResponse:
    data = await asyncio.to_thread(subway.get_subway)
    return JSONResponse(data)


@app.get("/api/rt/subway/stream")
async def rt_subway_stream(request: Request) -> StreamingResponse:
    async def gen():
        while True:
            if await request.is_disconnected():
                break
            try:
                data = await asyncio.to_thread(subway.get_subway)
                yield f"data: {json.dumps(data)}\n\n"
            except Exception:
                yield "event: error\ndata: {}\n\n"
            await asyncio.sleep(config.SSE_INTERVAL_S)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


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


@app.post("/__track")
async def track() -> Response:
    # First-party telemetry sink for the ArkTriad beacon. Accept and drop (no PII stored here).
    return Response(status_code=204)
