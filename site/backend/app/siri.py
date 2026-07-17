"""SIRI StopMonitoring proxy — on-demand bus arrival board for one stop.

Called only when a user taps a stop (never bulk-polled). Uses the server-side
BusTime key and caches per stop for 30s.
"""
from __future__ import annotations

import time
from typing import Any

from . import config

_cache: dict[str, dict[str, Any]] = {}


def get_arrivals(stop_id: str) -> dict[str, Any]:
    now = time.time()
    hit = _cache.get(stop_id)
    if hit and (now - hit["ts"]) < 30:
        return hit["data"]
    result: dict[str, Any] = {"stop_id": stop_id, "arrivals": []}
    if not config.MTA_BUSTIME_KEY:
        return result
    try:
        import httpx

        r = httpx.get(
            config.SIRI_STOP_MONITORING_URL,
            params={"key": config.MTA_BUSTIME_KEY, "MonitoringRef": stop_id, "version": "2"},
            timeout=20.0,
        )
        r.raise_for_status()
        j = r.json()
        deliveries = (
            j.get("Siri", {})
            .get("ServiceDelivery", {})
            .get("StopMonitoringDelivery", [])
        )
        arrivals = []
        for d in deliveries:
            for visit in d.get("MonitoredStopVisit", []):
                mvj = visit.get("MonitoredVehicleJourney", {})
                call = mvj.get("MonitoredCall", {})
                eta = None
                exp = call.get("ExpectedArrivalTime") or call.get("AimedArrivalTime")
                if exp:
                    try:
                        from datetime import datetime

                        t = datetime.fromisoformat(exp.replace("Z", "+00:00"))
                        eta = int(t.timestamp() - now)
                    except Exception:
                        eta = None
                stops_away = None
                ext = call.get("Extensions", {}).get("Distances", {})
                if isinstance(ext, dict):
                    stops_away = ext.get("StopsFromCall")
                arrivals.append(
                    {
                        "route": mvj.get("PublishedLineName", [None])[0]
                        if isinstance(mvj.get("PublishedLineName"), list)
                        else mvj.get("PublishedLineName"),
                        "headsign": mvj.get("DestinationName", [None])[0]
                        if isinstance(mvj.get("DestinationName"), list)
                        else mvj.get("DestinationName"),
                        "eta_seconds": eta,
                        "stops_away": stops_away,
                    }
                )
        arrivals.sort(key=lambda a: (a["eta_seconds"] is None, a["eta_seconds"] or 0))
        result["arrivals"] = arrivals
    except Exception:
        pass
    _cache[stop_id] = {"ts": now, "data": result}
    return result
