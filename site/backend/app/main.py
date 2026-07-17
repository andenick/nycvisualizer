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

from . import config, downloads, gtfs, realtime, siri, subway

app = FastAPI(title="nycvisualizer API", version="0.1.0")

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


@app.get("/api/downloads")
async def downloads_inventory() -> JSONResponse:
    return JSONResponse(downloads.inventory())


@app.get("/api/downloads/{key}")
async def download_file(key: str):
    from fastapi.responses import FileResponse

    hit = downloads.resolve(key)
    if hit is None:
        return JSONResponse({"error": "unknown download key"}, status_code=404)
    path, media_type = hit
    return FileResponse(path, media_type=media_type, filename=path.name)


@app.post("/__track")
async def track() -> Response:
    # First-party telemetry sink for the ArkTriad beacon. Accept and drop (no PII stored here).
    return Response(status_code=204)
