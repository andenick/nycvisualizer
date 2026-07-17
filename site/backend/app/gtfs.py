"""GTFS static: bus route catalog + per-route shapes and stops.

Reads the per-borough GTFS static feeds under GTFS_STATIC_ROOT/gtfs_bus_*/gtfs/.
A lightweight route index is built lazily and cached; shapes/stops for a route are
loaded on demand (stop_times.txt is large, so it is only touched per representative
trip). Uses DuckDB's CSV reader.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

import duckdb

from . import config

_BOROUGH_LABEL = {
    "gtfs_bus_bronx": "Bronx",
    "gtfs_bus_brooklyn": "Brooklyn",
    "gtfs_bus_manhattan": "Manhattan",
    "gtfs_bus_queens": "Queens",
    "gtfs_bus_staten_island": "Staten Island",
    "gtfs_bus_mta_bus_company": "MTA Bus Co.",
}

_route_index: dict[str, str] | None = None  # route_id -> borough dir name
_catalog: list[dict[str, Any]] | None = None


def _bus_dirs() -> list[Path]:
    root = config.GTFS_STATIC_ROOT
    if not root.exists():
        return []
    return sorted(p for p in root.glob("gtfs_bus_*") if (p / "gtfs" / "routes.txt").exists())


def _build_index() -> None:
    global _route_index, _catalog
    idx: dict[str, str] = {}
    cat: list[dict[str, Any]] = []
    con = duckdb.connect()
    try:
        for d in _bus_dirs():
            name = d.name
            gdir = d / "gtfs"
            routes_txt = (gdir / "routes.txt").as_posix()
            trips_txt = (gdir / "trips.txt").as_posix()
            # A route is OWNED by the feed whose trips.txt actually operates it.
            # (Each borough's routes.txt is a system-wide superset, so routes.txt
            #  alone mis-assigns routes — only trips.txt says who runs them.)
            operated = {
                r[0]
                for r in con.execute(
                    f"SELECT DISTINCT route_id FROM read_csv_auto('{trips_txt}', header=true, all_varchar=true) WHERE route_id IS NOT NULL"
                ).fetchall()
            }
            rows = con.execute(
                f"""
                SELECT route_id, route_short_name, route_long_name, route_color
                FROM read_csv_auto('{routes_txt}', header=true, all_varchar=true)
                """
            ).fetchall()
            for rid, short, long, color in rows:
                if rid in idx or rid not in operated:
                    continue
                idx[rid] = name
                cat.append(
                    {
                        "route_id": rid,
                        "short_name": (short or rid) or "",
                        "long_name": long or "",
                        "color": (color or "").strip() or "2563eb",
                        "borough": _BOROUGH_LABEL.get(name, name),
                    }
                )
    finally:
        con.close()
    cat.sort(key=lambda r: (r["borough"], r["short_name"]))
    _route_index, _catalog = idx, cat


def get_route_catalog() -> list[dict[str, Any]]:
    if _catalog is None:
        _build_index()
    return _catalog or []


def _gtfs_dir_for(route_id: str) -> Path | None:
    if _route_index is None:
        _build_index()
    name = (_route_index or {}).get(route_id)
    if not name:
        return None
    return config.GTFS_STATIC_ROOT / name / "gtfs"


@lru_cache(maxsize=256)
def get_route_shape(route_id: str) -> dict[str, Any]:
    gdir = _gtfs_dir_for(route_id)
    if gdir is None:
        return {"route_id": route_id, "polylines": [], "stops": []}
    trips_txt = (gdir / "trips.txt").as_posix()
    shapes_txt = (gdir / "shapes.txt").as_posix()
    stops_txt = (gdir / "stops.txt").as_posix()
    stop_times_txt = (gdir / "stop_times.txt").as_posix()

    con = duckdb.connect()
    try:
        # trips for this route -> (direction, shape_id, a representative trip_id)
        trip_rows = con.execute(
            f"""
            SELECT direction_id, shape_id, min(trip_id) AS rep_trip
            FROM read_csv_auto('{trips_txt}', header=true, all_varchar=true)
            WHERE route_id = ? AND shape_id IS NOT NULL AND shape_id <> ''
            GROUP BY direction_id, shape_id
            """,
            [route_id],
        ).fetchall()
        if not trip_rows:
            return {"route_id": route_id, "polylines": [], "stops": []}

        # point counts per shape -> pick the longest shape per direction
        shape_ids = sorted({r[1] for r in trip_rows})
        in_list = ",".join("'" + s.replace("'", "''") + "'" for s in shape_ids)
        counts = dict(
            con.execute(
                f"""
                SELECT shape_id, count(*) FROM read_csv_auto('{shapes_txt}', header=true, all_varchar=true)
                WHERE shape_id IN ({in_list}) GROUP BY shape_id
                """
            ).fetchall()
        )
        best: dict[str, tuple[str, str]] = {}  # direction -> (shape_id, rep_trip)
        for direction, shape_id, rep_trip in trip_rows:
            cnt = int(counts.get(shape_id, 0))
            cur = best.get(direction)
            if cur is None or cnt > int(counts.get(cur[0], 0)):
                best[direction] = (shape_id, rep_trip)

        polylines: list[list[list[float]]] = []
        rep_trips: list[str] = []
        for shape_id, rep_trip in best.values():
            pts = con.execute(
                f"""
                SELECT CAST(TRIM(shape_pt_lat) AS DOUBLE), CAST(TRIM(shape_pt_lon) AS DOUBLE)
                FROM read_csv_auto('{shapes_txt}', header=true, all_varchar=true)
                WHERE shape_id = ?
                ORDER BY CAST(shape_pt_sequence AS BIGINT)
                """,
                [shape_id],
            ).fetchall()
            if pts:
                polylines.append([[lat, lon] for lat, lon in pts])
                rep_trips.append(rep_trip)

        # stops along the representative trips
        stops: list[dict[str, Any]] = []
        if rep_trips:
            trips_in = ",".join("'" + t.replace("'", "''") + "'" for t in rep_trips)
            stop_rows = con.execute(
                f"""
                WITH st AS (
                    SELECT DISTINCT stop_id
                    FROM read_csv_auto('{stop_times_txt}', header=true, all_varchar=true)
                    WHERE trip_id IN ({trips_in})
                )
                SELECT s.stop_id, s.stop_name,
                       CAST(TRIM(s.stop_lat) AS DOUBLE), CAST(TRIM(s.stop_lon) AS DOUBLE)
                FROM read_csv_auto('{stops_txt}', header=true, all_varchar=true) s
                JOIN st ON st.stop_id = s.stop_id
                """
            ).fetchall()
            stops = [
                {"stop_id": r[0], "stop_name": r[1], "lat": r[2], "lon": r[3]}
                for r in stop_rows
                if r[2] is not None and r[3] is not None
            ]
        return {"route_id": route_id, "polylines": polylines, "stops": stops}
    finally:
        con.close()
