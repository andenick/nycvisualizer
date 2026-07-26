"""Realtime bus vehicle positions + alerts.

Primary source: the poller's hourly-partitioned Parquet archive (freshest snapshot
per vehicle). Fallback: a direct, cached GTFS-RT fetch with the server-side key when
the archive is stale (> STALE_AFTER_S) — respecting BusTime's 30s rate floor via a
short-TTL cache.
"""
from __future__ import annotations

import html
import json
import sys
import time
from pathlib import Path
from typing import Any

import duckdb

from . import config, motion

# Vendor-extension decoder lives with the poller (realtime/gtfs_ext.py) so exactly one
# implementation reads the NYCT/Mercury/OneBusAway wire format — see realtime/proto/.
sys.path.insert(0, str(config.REALTIME_PKG_DIR))
try:
    import gtfs_ext  # type: ignore
except Exception:  # pragma: no cover - extensions simply stay None
    class _NoExt:
        @staticmethod
        def mercury_alert(_a):
            return {"alert_type": None, "created_at": None, "updated_at": None,
                    "display_before_active": None, "human_readable_active_period": None}

        @staticmethod
        def oba_vehicle(_v):
            return {"passenger_count": None, "passenger_capacity": None}
    gtfs_ext = _NoExt()  # type: ignore


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


# Columns the poller only began writing on 2026-07-25 (W6b). They are absent from every
# earlier parquet file, so they are projected ONLY when the scanned files actually carry
# them — a hard reference to a column present in no file fails to bind.
_VEH_OPTIONAL_COLS = ("occupancy_status", "passenger_count", "passenger_capacity",
                      "header_ts")


def _int_or_none(v):
    return int(v) if v is not None else None


def _vehicles_from_archive() -> dict[str, Any] | None:
    files = _newest_partition_files("bus_vehicle_positions")
    if not files:
        return None
    lst = ",".join("'" + f + "'" for f in files)
    con = duckdb.connect()
    try:
        src = f"read_parquet([{lst}], union_by_name=true)"
        try:
            have = {c[0] for c in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()}
        except Exception:
            have = set()
        opt = [c for c in _VEH_OPTIONAL_COLS if c in have]
        opt_sql = ("," + ",".join(opt)) if opt else ""
        # Freshest snapshot per vehicle over the last ~120s window (robust to partial flushes),
        # PLUS the immediately-preceding ping (rn=2) so the motion model can derive an observed
        # speed (displacement/Δt) and check the along-shape offset is monotonic.
        rows = con.execute(
            f"""
            WITH t AS (SELECT * FROM {src}),
                 m AS (SELECT max(poll_ts) AS mx FROM t),
                 r AS (
                    SELECT vehicle_id, route_id, trip_id, lat, lon, bearing, timestamp,
                           stop_id, direction_id, coalesce(timestamp, poll_ts) AS eff_ts
                           {opt_sql},
                           row_number() OVER (
                               PARTITION BY vehicle_id
                               ORDER BY coalesce(timestamp, poll_ts) DESC
                           ) AS rn
                    FROM t, m
                    WHERE t.poll_ts >= m.mx - 120 AND t.lat IS NOT NULL AND t.lon IS NOT NULL
                 )
            SELECT *, (SELECT mx FROM m) AS as_of FROM r WHERE rn <= 2
            """
        ).fetchall()
        cols = [d[0] for d in con.description]
    finally:
        con.close()
    if not rows:
        return None
    recs = [dict(zip(cols, r)) for r in rows]
    as_of = _int_or_none(recs[0].get("as_of"))
    vehicles = []
    prev: dict[str, tuple] = {}
    n_apc = 0
    n_occ = 0
    for d in recs:
        if d["rn"] == 1:  # freshest snapshot
            v = {
                "vehicle_id": d["vehicle_id"],
                "route_id": d["route_id"],
                "trip_id": d["trip_id"],
                "lat": d["lat"],
                "lon": d["lon"],
                "bearing": d["bearing"],
                "timestamp": _int_or_none(d["timestamp"]),
                "stop_id": d["stop_id"],
                "direction_id": _int_or_none(d["direction_id"]),
            }
            # A1/B6 — crowding. NULL means "this bus has no APC", NEVER "empty": the
            # value 0 does not occur. Only ~half the fleet reports, so any consumer must
            # render absence as unknown rather than as a low load.
            occ = d.get("occupancy_status")
            pax = d.get("passenger_count")
            cap = d.get("passenger_capacity")
            if occ is not None:
                v["occupancy_status"] = int(occ)
                n_occ += 1
            if pax is not None:
                v["passenger_count"] = int(pax)
                n_apc += 1
            if cap is not None:
                v["passenger_capacity"] = int(cap)
            vehicles.append(v)
        else:  # rn=2 -> previous ping (lat, lon, eff_ts) for the motion model
            prev[d["vehicle_id"]] = (d["lat"], d["lon"], _int_or_none(d["eff_ts"]))
    stale = as_of is not None and (time.time() - as_of) > config.STALE_AFTER_S
    # A6 — separate MTA staleness from OUR lag. header_ts is what MTA says it published;
    # poll_ts is when we fetched it; timestamp is when the vehicle was actually observed.
    hdrs = [d["header_ts"] for d in recs if d.get("header_ts") is not None]
    freshness = {
        "as_of_poll_ts": as_of,
        "mta_header_ts": int(max(hdrs)) if hdrs else None,
        "poller_lag_s": (int(as_of - max(hdrs)) if hdrs and as_of else None),
        "feed_age_s": (int(time.time() - max(hdrs)) if hdrs else None),
        "basis": "header_ts" if hdrs else "poll_ts_only",
    }
    n = len(vehicles) or 1
    return {"as_of": as_of, "source": "archive", "count": len(vehicles), "stale": stale,
            "vehicles": vehicles, "_prev": prev, "freshness": freshness,
            "crowding": {"apc_vehicles": n_apc, "apc_pct": round(100.0 * n_apc / n, 1),
                         "occupancy_vehicles": n_occ,
                         "note": "NULL = no automatic passenger counter on that bus, "
                                 "not an empty bus. Value 0 never occurs."}}


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
        header_ts = int(feed.header.timestamp) if feed.header.timestamp else None
        vehicles = []
        n_apc = 0
        n_occ = 0
        for ent in feed.entity:
            if not ent.HasField("vehicle"):
                continue
            v = ent.vehicle
            if not v.position.latitude:
                continue
            rec = {
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
            # A1/B6 — crowding on the LIVE path too. This branch previously dropped both
            # fields, so on any deployment served from the live fallback (the public box
            # has no raw archive) occupancy was captured upstream and then discarded here.
            # NULL means "this bus has no automatic passenger counter", NEVER "empty bus":
            # the value 0 does not occur.
            if v.HasField("occupancy_status"):
                rec["occupancy_status"] = int(v.occupancy_status)
                n_occ += 1
            try:
                oba = gtfs_ext.oba_vehicle(v)
            except Exception:
                oba = {}
            if oba.get("passenger_count") is not None:
                rec["passenger_count"] = int(oba["passenger_count"])
                n_apc += 1
            if oba.get("passenger_capacity") is not None:
                rec["passenger_capacity"] = int(oba["passenger_capacity"])
            vehicles.append(rec)
        n = len(vehicles) or 1
        data = {"as_of": as_of, "source": "live", "count": len(vehicles), "stale": False,
                "vehicles": vehicles,
                # A6 — MTA's own publication clock, so feed staleness can be told apart
                # from our lag. On the live path there is no poll step, so they coincide.
                "freshness": {"as_of_poll_ts": as_of, "mta_header_ts": header_ts,
                              "poller_lag_s": 0 if header_ts else None,
                              "feed_age_s": (int(time.time() - header_ts) if header_ts else None),
                              "basis": "header_ts" if header_ts else "poll_ts_only"},
                "crowding": {"apc_vehicles": n_apc,
                             "apc_pct": round(100.0 * n_apc / n, 1),
                             "occupancy_vehicles": n_occ,
                             "note": "NULL = no automatic passenger counter on that bus, "
                                     "not an empty bus. Value 0 never occurs."}}
        _live_cache["ts"] = now
        _live_cache["data"] = data
        return data
    except Exception:
        return None


def get_vehicles() -> dict[str, Any]:
    """Freshest vehicles: archive first, live GTFS-RT fallback if archive is stale/absent.

    The payload is enriched with the W1 motion fields (shape_id, route_offset_ft,
    speed_est_fps, speed_basis) here so the enrichment runs once per RT_CACHE_TTL_S build,
    NOT per request (main.py wraps this in the TTL cache). The live-fallback path has no
    previous ping, so its speed falls back to the derive2 median tables / default (honest).
    """
    arch = _vehicles_from_archive()
    if arch is not None and not arch["stale"]:
        return motion.enrich(arch)
    live = _vehicles_from_live()
    if live is not None:
        return motion.enrich(live)
    if arch is not None:
        return motion.enrich(arch)  # stale archive beats nothing — honestly flagged stale
    return {"as_of": None, "source": "none", "count": 0, "stale": True, "vehicles": [],
            "motion": {"n": 0}}


def _newest_jsonl_files(feed: str, n: int = 3) -> list[Path]:
    """Newest JSONL poll files for an alert feed.

    The alert feeds are archived as JSON-LINES (`poller.py` FEEDS: fmt="jsonl"), NOT
    parquet. The previous implementation globbed `*.parquet` under a JSONL-only feed, so
    it always returned [] and the entire archive branch below — including the only reader
    of `description_text` anywhere in the platform — was unreachable dead code.
    """
    base = config.REALTIME_ARCHIVE / feed
    if not base.exists():
        return []
    for d in sorted(base.glob("date=*"), reverse=True):
        for h in sorted(d.glob("hour=*"), reverse=True):
            files = sorted(h.glob("*.jsonl"))
            if files:
                return files[-n:]
    return []


def _first_text(v: Any) -> str:
    """poller.parse_alert writes header_text/description_text as a LIST of translations."""
    if isinstance(v, list):
        return _clean_text(str(v[0])) if v else ""
    return _clean_text(str(v or ""))


def _alerts_from_archive() -> dict[str, Any] | None:
    """Bus service alerts from the JSONL archive, with the rich fields intact."""
    rows: list[dict[str, Any]] = []
    max_poll = 0
    for fp in _newest_jsonl_files("bus_alerts"):
        try:
            with fp.open(encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    d = json.loads(line)
                    rows.append(d)
                    max_poll = max(max_poll, int(d.get("poll_ts") or 0))
        except Exception:
            continue
    if not rows:
        return None
    # keep only the freshest poll cycle, then de-duplicate by alert id
    fresh = [d for d in rows if int(d.get("poll_ts") or 0) >= max_poll - 60]
    seen: dict[str, dict[str, Any]] = {}
    for d in fresh:
        aid = str(d.get("alert_id") or "")
        if aid and aid not in seen:
            seen[aid] = d
    now = time.time()
    alerts = []
    for aid, d in seen.items():
        periods = [p for p in (d.get("active_period") or []) if isinstance(p, dict)]
        active_now = None
        if periods:
            active_now = any(
                (not p.get("start") or p["start"] <= now)
                and (not p.get("end") or p["end"] >= now)
                for p in periods
            )
        alerts.append({
            "id": aid,
            "header": _first_text(d.get("header_text")),
            # A4: rich alert copy — "What's happening?" and the suggested alternative.
            "description": _first_text(d.get("description_text")),
            "routes": sorted({str(e.get("route_id")) for e in (d.get("informed_entity") or [])
                              if isinstance(e, dict) and e.get("route_id")})[:8],
            "stops": sorted({str(e.get("stop_id")) for e in (d.get("informed_entity") or [])
                             if isinstance(e, dict) and e.get("stop_id")})[:8],
            # A5: the alert's own active window, and whether it applies RIGHT NOW.
            "active_period": periods,
            "active_now": active_now,
            # Mercury extension (poller >= 2026-07-25): MTA's real taxonomy + its own
            # rider-facing rendering of the window. None on rows archived before that.
            "alert_type": d.get("alert_type"),
            "human_readable_active_period": d.get("human_readable_active_period"),
            "created_at": d.get("created_at"),
            "updated_at": d.get("updated_at"),
        })
    # active alerts first, then most recently updated
    alerts.sort(key=lambda a: (a["active_now"] is False, -(a.get("updated_at") or 0)))
    stale = (now - max_poll) > config.ALERTS_STALE_AFTER_S if max_poll else True
    return {"source": "archive", "as_of": max_poll or None, "stale": stale,
            "count": len(alerts), "alerts": alerts[:50],
            "severity_note": _SEVERITY_NOTE}


# GTFS-RT `cause`/`effect` are never on the wire from MTA (verified 2026-07-25: the only
# populated Alert fields are active_period, informed_entity, header_text, description_text).
# Any severity read out of them is a proto2 default, so we publish the Mercury alert_type
# taxonomy instead and say plainly that severity is not published upstream.
_SEVERITY_NOTE = (
    "MTA does not publish GTFS-RT cause/effect/severity_level on these feeds — the "
    "values a decoder returns are protobuf defaults, not agency judgements. The "
    "classification shown is MTA's own Mercury `alert_type` where present."
)


def get_alerts() -> dict[str, Any]:
    """Service alerts. JSONL archive if present, else a cached live GTFS-RT alerts fetch."""
    arch = _alerts_from_archive()
    if arch is not None and not arch["stale"]:
        return arch

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
                stops = sorted({inf.stop_id for inf in a.informed_entity if inf.stop_id})
                periods = [{"start": (int(p.start) if p.HasField("start") else None),
                            "end": (int(p.end) if p.HasField("end") else None)}
                           for p in a.active_period]
                now = time.time()
                active_now = any((not p["start"] or p["start"] <= now)
                                 and (not p["end"] or p["end"] >= now)
                                 for p in periods) if periods else None
                merc = gtfs_ext.mercury_alert(a)
                alerts.append({"id": ent.id, "header": _clean_text(header),
                               "description": _clean_text(desc), "routes": routes,
                               "stops": stops[:8], "active_period": periods,
                               "active_now": active_now,
                               "alert_type": merc["alert_type"],
                               "human_readable_active_period":
                                   merc["human_readable_active_period"],
                               "created_at": merc["created_at"],
                               "updated_at": merc["updated_at"]})
            return {"source": "live", "as_of": int(time.time()), "stale": False,
                    "count": len(alerts), "alerts": alerts[:50],
                    "severity_note": _SEVERITY_NOTE}
        except Exception:
            pass
    if arch is not None:
        return arch  # stale archive beats nothing — honestly flagged stale
    return {"source": "none", "as_of": None, "stale": True, "count": 0, "alerts": [],
            "severity_note": _SEVERITY_NOTE}
