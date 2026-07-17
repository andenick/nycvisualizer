"""Realtime bus vehicle positions + alerts.

Primary source: the poller's hourly-partitioned Parquet archive (freshest snapshot
per vehicle). Fallback: a direct, cached GTFS-RT fetch with the server-side key when
the archive is stale (> STALE_AFTER_S) — respecting BusTime's 30s rate floor via a
short-TTL cache.
"""
from __future__ import annotations

import html
import time
from pathlib import Path
from typing import Any

import duckdb

from . import config


def _clean_text(s: str) -> str:
    """Decode HTML entities the upstream MTA feed sometimes ships as literal text
    (e.g. ``&#x200c;`` zero-width non-joiners) so they don't render verbatim."""
    return html.unescape(s or "")

_live_cache: dict[str, Any] = {"ts": 0.0, "data": None}


def _newest_partition_files(feed: str) -> list[str]:
    base = config.REALTIME_ARCHIVE / feed
    if not base.exists():
        return []
    dates = sorted(base.glob("date=*"))
    if not dates:
        return []
    for d in reversed(dates):
        hours = sorted(d.glob("hour=*"))
        for h in reversed(hours):
            files = list(h.glob("*.parquet"))
            if files:
                return [p.as_posix() for p in files]
    return []


def _vehicles_from_archive() -> dict[str, Any] | None:
    files = _newest_partition_files("bus_vehicle_positions")
    if not files:
        return None
    lst = ",".join("'" + f + "'" for f in files)
    con = duckdb.connect()
    try:
        # Freshest snapshot per vehicle over the last ~90s window (robust to partial flushes).
        rows = con.execute(
            f"""
            WITH t AS (SELECT * FROM read_parquet([{lst}])),
                 m AS (SELECT max(poll_ts) AS mx FROM t)
            SELECT vehicle_id, route_id, trip_id, lat, lon, bearing, timestamp,
                   stop_id, direction_id, (SELECT mx FROM m) AS as_of
            FROM t, m
            WHERE t.poll_ts >= m.mx - 90 AND t.lat IS NOT NULL AND t.lon IS NOT NULL
            QUALIFY row_number() OVER (
                PARTITION BY vehicle_id ORDER BY coalesce(timestamp, poll_ts) DESC
            ) = 1
            """
        ).fetchall()
    finally:
        con.close()
    if not rows:
        return None
    as_of = int(rows[0][9]) if rows[0][9] is not None else None
    vehicles = [
        {
            "vehicle_id": r[0],
            "route_id": r[1],
            "trip_id": r[2],
            "lat": r[3],
            "lon": r[4],
            "bearing": r[5],
            "timestamp": int(r[6]) if r[6] is not None else None,
            "stop_id": r[7],
            "direction_id": int(r[8]) if r[8] is not None else None,
        }
        for r in rows
    ]
    stale = as_of is not None and (time.time() - as_of) > config.STALE_AFTER_S
    return {"as_of": as_of, "source": "archive", "count": len(vehicles), "stale": stale, "vehicles": vehicles}


def _vehicles_from_live() -> dict[str, Any] | None:
    if not config.MTA_BUSTIME_KEY:
        return None
    now = time.time()
    if _live_cache["data"] is not None and (now - _live_cache["ts"]) < config.LIVE_CACHE_TTL_S:
        return _live_cache["data"]
    try:
        import httpx
        from google.transit import gtfs_realtime_pb2  # type: ignore

        r = httpx.get(
            config.GTFSRT_VEHICLES_URL,
            params={"key": config.MTA_BUSTIME_KEY},
            timeout=20.0,
        )
        r.raise_for_status()
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(r.content)
        as_of = int(feed.header.timestamp) if feed.header.timestamp else int(now)
        vehicles = []
        for ent in feed.entity:
            if not ent.HasField("vehicle"):
                continue
            v = ent.vehicle
            if not v.position.latitude:
                continue
            vehicles.append(
                {
                    "vehicle_id": v.vehicle.id or ent.id,
                    "route_id": v.trip.route_id or None,
                    "trip_id": v.trip.trip_id or None,
                    "lat": v.position.latitude,
                    "lon": v.position.longitude,
                    "bearing": v.position.bearing if v.position.HasField("bearing") else None,
                    "timestamp": int(v.timestamp) if v.timestamp else as_of,
                    "stop_id": v.stop_id or None,
                    "direction_id": v.trip.direction_id if v.trip.HasField("direction_id") else None,
                }
            )
        data = {"as_of": as_of, "source": "live", "count": len(vehicles), "stale": False, "vehicles": vehicles}
        _live_cache["ts"] = now
        _live_cache["data"] = data
        return data
    except Exception:
        return None


def get_vehicles() -> dict[str, Any]:
    """Freshest vehicles: archive first, live GTFS-RT fallback if archive is stale/absent."""
    arch = _vehicles_from_archive()
    if arch is not None and not arch["stale"]:
        return arch
    live = _vehicles_from_live()
    if live is not None:
        return live
    if arch is not None:
        return arch  # stale archive beats nothing — honestly flagged stale
    return {"as_of": None, "source": "none", "count": 0, "stale": True, "vehicles": []}


def get_alerts() -> dict[str, Any]:
    """Service alerts. Archive parquet if present, else a cached live GTFS-RT alerts fetch."""
    files = _newest_partition_files("bus_alerts")
    if files:
        lst = ",".join("'" + f + "'" for f in files)
        con = duckdb.connect()
        try:
            cols = {c[0] for c in con.execute(f"DESCRIBE SELECT * FROM read_parquet([{lst}])").fetchall()}
            hdr = "header_text" if "header_text" in cols else ("header" if "header" in cols else None)
            if hdr:
                rows = con.execute(
                    f"SELECT * FROM read_parquet([{lst}]) LIMIT 50"
                ).fetchdf().to_dict("records")
                alerts = []
                for i, row in enumerate(rows):
                    alerts.append(
                        {
                            "id": str(row.get("id", i)),
                            "header": _clean_text(str(row.get(hdr, ""))),
                            "description": _clean_text(str(row.get("description_text", row.get("description", "")))),
                            "routes": [x for x in str(row.get("route_ids", row.get("routes", ""))).split(",") if x and x != "nan"],
                        }
                    )
                return {"source": "archive", "as_of": None, "alerts": alerts}
        finally:
            con.close()

    # live fallback
    if config.MTA_BUSTIME_KEY:
        try:
            import httpx
            from google.transit import gtfs_realtime_pb2  # type: ignore

            r = httpx.get(config.GTFSRT_ALERTS_URL, params={"key": config.MTA_BUSTIME_KEY}, timeout=20.0)
            r.raise_for_status()
            feed = gtfs_realtime_pb2.FeedMessage()
            feed.ParseFromString(r.content)
            alerts = []
            for ent in feed.entity:
                if not ent.HasField("alert"):
                    continue
                a = ent.alert
                header = a.header_text.translation[0].text if a.header_text.translation else ""
                desc = a.description_text.translation[0].text if a.description_text.translation else ""
                routes = sorted({inf.route_id for inf in a.informed_entity if inf.route_id})
                alerts.append({"id": ent.id, "header": _clean_text(header), "description": _clean_text(desc), "routes": routes})
            return {"source": "live", "as_of": int(time.time()), "alerts": alerts[:50]}
        except Exception:
            pass
    return {"source": "none", "as_of": None, "alerts": []}
