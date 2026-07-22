"""Renter's Map (S7) — one-pager location profile + two-location compare.

A self-contained APIRouter (`/api/renters/*`) mounted by main.py with a single include line.

  * /api/renters/profile?lat&lon   (or ?address=)  -> the full one-pager payload
  * /api/renters/compare?a_lat&a_lon&b_lat&b_lon    -> two profiles side by side

Everything the browser sees is places-and-infrastructure only. There are NO demographic /
protected-class variables anywhere in any score — the profile carries an explicit fair-housing
disclaimer. It describes places, not people, and is not a tenant-screening or credit product.

Reads
-----
  * precomputed grid            config.RENTERS_GRID           (per-H3-res-10-cell scores + percentiles)
  * per-BBL building aggregates config.RENTERS_{HPD,DOB,LANDLORD}_BBL
  * live geo lookups            config.JANE_GEO_DB            (PLUTO within 75 m; SAI bus stops within 400 m)
  * SAI stop scores             config.RENTERS_SAI           (subscores for the nearest-stops detail)
  * job-access fallback polygon config.RENTERS_ISO_GRID      (res-8 45-min isochrone, used if OTP is down)
  * live isochrone              app.isochrone.get_isochrone  (server-side; cached; 503 -> approximate flag)
  * geocoder                    config.GEOSEARCH_URL         (GeoSearch: address -> lon/lat + BBL + BIN)

Design notes
------------
* Fresh in-memory DuckDB connection per query over Parquet + the geo DB (attached read-only),
  same pattern as gtfs.py / obs.py. The 5.4 GB DB is only touched for the tiny PLUTO/SAI radius
  scans (bbox-pruned by ST_DWithin on geom_2263), never a full scan.
* H3 res-10 cell id is computed with the `h3` lib (h3.str_to_int) so it matches the grid's
  integer cell ids exactly (verified against DuckDB's scalar h3_latlng_to_cell).
* Distances are EPSG:2263 (ftUS). Percentile fields come straight from the grid (ranked over
  populated cells citywide) — higher percentile = more of that thing (more noise, more trees…);
  the plain-language direction of "good/bad" is the frontend's job.
"""
from __future__ import annotations

import time
from functools import lru_cache
from typing import Any

import duckdb
import h3
import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from . import config, isochrone

router = APIRouter(prefix="/api/renters", tags=["renters"])

# NYC service-area bbox guard (same as isochrone.py).
_LAT_LO, _LAT_HI, _LON_LO, _LON_HI = 40.3, 41.0, -74.4, -73.6

DISCLAIMER = (
    "This profile describes a place and its surrounding infrastructure — transit, quality-of-life "
    "complaint patterns, street conditions, flood exposure and nearby buildings. It is NOT a "
    "credit score, a tenant-screening report, or a judgement about the people who live here. No "
    "demographic or protected-class information (race, national origin, religion, sex, family "
    "status, disability, age, income of residents) is used in any score. Every number is sourced "
    "from open NYC datasets and is shown with its citywide percentile context so you can compare "
    "neighborhoods on equal terms. Fair-housing note: choose a home by the place, not by who your "
    "neighbors are."
)

# Human-readable direction for each percentile field (frontend one-liners lean on this).
SCORE_META = {
    "transit_supply_pctile": {"label": "Bus service nearby", "higher_is": "more"},
    "transit_sai_pctile": {"label": "Best stop-access score nearby", "higher_is": "better"},
    "jobs_pctile": {"label": "Jobs reachable in 45 min (8am transit)", "higher_is": "more"},
    "noise_pctile": {"label": "311 noise complaints nearby", "higher_is": "more"},
    "sidewalk311_pctile": {"label": "311 sidewalk/curb complaints nearby", "higher_is": "more"},
    "rodent_fail_pctile": {"label": "Rodent-inspection failure rate nearby", "higher_is": "more"},
    "ped_crash_pctile": {"label": "Pedestrian-injury crashes nearby", "higher_is": "more"},
    "trees_pctile": {"label": "Street trees nearby", "higher_is": "more"},
    "sidewalk_cov_pctile": {"label": "Sidewalk coverage nearby", "higher_is": "better"},
}


# --------------------------------------------------------------------------- #
# DuckDB plumbing
# --------------------------------------------------------------------------- #
def _con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("LOAD spatial;")
    con.execute("PRAGMA threads=4")
    con.execute(f"ATTACH '{config.JANE_GEO_DB.as_posix()}' AS geo (READ_ONLY)")
    return con


def _p(path) -> str:
    return path.as_posix()


# --------------------------------------------------------------------------- #
# tiny TTL cache (grid rows + geocode + isochrone results)
# --------------------------------------------------------------------------- #
_ttl_cache: dict[str, tuple[float, Any]] = {}


def _cached(key: str, ttl: float, fn):
    now = time.time()
    hit = _ttl_cache.get(key)
    if hit is not None and (now - hit[0]) < ttl:
        return hit[1]
    val = fn()
    _ttl_cache[key] = (now, val)
    return val


# --------------------------------------------------------------------------- #
# geocoding (GeoSearch) — address -> lon/lat + BBL + BIN
# --------------------------------------------------------------------------- #
def geocode(address: str) -> dict[str, Any] | None:
    try:
        r = httpx.get(
            config.GEOSEARCH_URL,
            params={"text": address, "size": 1},
            timeout=config.GEOSEARCH_TIMEOUT_S,
        )
        if r.status_code != 200:
            return None
        gj = r.json()
    except Exception:
        return None
    feats = gj.get("features") or []
    if not feats:
        return None
    f = feats[0]
    lon, lat = f["geometry"]["coordinates"]
    props = f.get("properties", {})
    add = props.get("addendum", {}).get("pad", {})
    bbl = add.get("bbl") or props.get("pad_bbl")
    bin_ = add.get("bin") or props.get("pad_bin")
    return {
        "input": address,
        "matched_label": props.get("label"),
        "lat": float(lat),
        "lon": float(lon),
        "bbl": str(bbl) if bbl else None,
        "bin": str(bin_) if bin_ else None,
        "confidence": props.get("confidence"),
        "geocoder": "GeoSearch (NYC Planning Labs)",
    }


# --------------------------------------------------------------------------- #
# grid lookup — snap to res-10 cell, fall back to nearest populated neighbour
# --------------------------------------------------------------------------- #
_GRID_COLS = [
    "h3_10", "res8", "lat", "lon", "pop_300m", "populated",
    "transit_stops_400m", "best_sai_400m", "sched_am_trips_400m",
    "subway_name", "subway_borough", "subway_dist_ft",
    "noise_400m", "sidewalk311_400m", "rodent_insp_400m", "rodent_fail_400m",
    "rodent_fail_rate", "ped_crash_400m", "trees_400m",
    "sidewalk_full_share", "sidewalk_none_share",
    "flood_sw_moderate", "flood_sw_extreme", "firm_zone", "flood_firm_sfha",
    "jobs_45min", "jobs_45min_pct",
    "noise_pctile", "sidewalk311_pctile", "ped_crash_pctile", "trees_pctile",
    "transit_sai_pctile", "transit_supply_pctile", "jobs_pctile",
    "rodent_fail_pctile", "sidewalk_cov_pctile",
]


def _grid_row(con, lat: float, lon: float) -> tuple[dict | None, bool]:
    """Return (grid row dict, exact) — exact=False means a nearest-neighbour fallback."""
    cell_str = h3.latlng_to_cell(lat, lon, 10)
    cell_int = h3.str_to_int(cell_str)
    cols = ",".join(_GRID_COLS)
    row = con.execute(
        f"SELECT {cols} FROM read_parquet('{_p(config.RENTERS_GRID)}') WHERE h3_10 = ?",
        [cell_str],
    ).fetchdf()
    if len(row):
        return row.iloc[0].to_dict(), True
    # fallback: nearest cell within a widening disk (address may be on the coastline / a park edge)
    for k in (1, 2, 3, 4):
        # the grid stores the string cell id; search this ring of neighbours
        neigh_str = list(h3.grid_disk(cell_str, k))
        placeholders = ",".join("?" for _ in neigh_str)
        df = con.execute(
            f"SELECT {cols} FROM read_parquet('{_p(config.RENTERS_GRID)}') "
            f"WHERE h3_10 IN ({placeholders})",
            neigh_str,
        ).fetchdf()
        if len(df):
            # pick the geographically nearest of the returned cells
            import math

            def d2(r):
                return (r["lat"] - lat) ** 2 + (r["lon"] - lon) ** 2

            best = min((df.iloc[i].to_dict() for i in range(len(df))), key=d2)
            return best, False
    return None, False


# --------------------------------------------------------------------------- #
# nearest bus stops (SAI) within 400 m — with subscores
# --------------------------------------------------------------------------- #
def _nearest_stops(con, lat: float, lon: float, limit: int = 6) -> list[dict]:
    rows = con.execute(
        f"""
        WITH o AS (
          SELECT ST_Transform(ST_Point(?, ?), 'EPSG:4326', 'EPSG:2263', always_xy:=true) AS g
        )
        SELECT stop_name, borough, n_routes, routes, sbs_flag,
               sai, sai_pctile, safety, comfort, condition, service_intensity,
               sidewalk_provision, ada_ramp_access, walkshed_population,
               trips_am, shelter_100ft,
               ST_Distance(ST_Transform(ST_Point(lon, lat),'EPSG:4326','EPSG:2263',always_xy:=true),
                           o.g) AS dist_ft
        FROM read_parquet('{_p(config.RENTERS_SAI)}'), o
        WHERE lat IS NOT NULL
          AND ST_DWithin(ST_Transform(ST_Point(lon, lat),'EPSG:4326','EPSG:2263',always_xy:=true),
                         o.g, {config.RENTERS_STOP_RADIUS_FT})
        ORDER BY dist_ft ASC
        LIMIT {int(limit)}
        """,
        [lon, lat],
    ).fetchall()
    out = []
    for r in rows:
        out.append({
            "stop_name": r[0], "borough": r[1], "n_routes": int(r[2]) if r[2] is not None else None,
            "routes": (r[3] or "").split(",") if r[3] else [],
            "sbs": bool(r[4]),
            "sai": round(r[5], 2) if r[5] is not None else None,
            "sai_pctile": round(r[6], 1) if r[6] is not None else None,
            "subscores": {
                "safety": round(r[7], 2) if r[7] is not None else None,
                "comfort": round(r[8], 2) if r[8] is not None else None,
                "condition": round(r[9], 2) if r[9] is not None else None,
                "service_intensity": round(r[10], 2) if r[10] is not None else None,
                "sidewalk_provision": round(r[11], 2) if r[11] is not None else None,
                "ada_ramp_access": round(r[12], 2) if r[12] is not None else None,
            },
            "walkshed_population": round(r[13], 0) if r[13] is not None else None,
            "am_trips": int(r[14]) if r[14] is not None else None,
            "sheltered": bool(r[15]) if r[15] is not None else None,
            "dist_ft": round(r[16], 0) if r[16] is not None else None,
        })
    return out


# --------------------------------------------------------------------------- #
# nearest buildings (PLUTO within 75 m) + BBL-joined HPD/DOB/landlord aggregates
# --------------------------------------------------------------------------- #
def _nearest_buildings(con, lat: float, lon: float, limit: int = 6) -> list[dict]:
    # PLUTO carries lot X/Y in EPSG:2263 (ftUS). Pre-filter by a numeric bbox on those
    # columns (parquet/row-group prunable) so ST_DWithin only touches a handful of lots,
    # not all 856k geometries — the difference between a ~2 s and a <100 ms building query.
    rad = config.RENTERS_BUILDING_RADIUS_FT
    rows = con.execute(
        f"""
        WITH o AS (
          SELECT ST_Transform(ST_Point(?, ?), 'EPSG:4326', 'EPSG:2263', always_xy:=true) AS g,
                 ST_X(ST_Transform(ST_Point(?, ?), 'EPSG:4326', 'EPSG:2263', always_xy:=true)) AS ox,
                 ST_Y(ST_Transform(ST_Point(?, ?), 'EPSG:4326', 'EPSG:2263', always_xy:=true)) AS oy
        )
        SELECT CAST(CAST(p.BBL AS BIGINT) AS VARCHAR) AS bbl,
               p.Address, p.UnitsRes, p.UnitsTotal, p.YearBuilt, p.NumFloors,
               p.OwnerName, p.BldgClass, p.LandUse,
               ST_Distance(p.geom_2263, o.g) AS dist_ft
        FROM geo.geo_pluto_lots p, o
        WHERE p.geom_2263 IS NOT NULL
          AND p.XCoord BETWEEN o.ox - {rad} AND o.ox + {rad}
          AND p.YCoord BETWEEN o.oy - {rad} AND o.oy + {rad}
          AND ST_DWithin(p.geom_2263, o.g, {rad})
        ORDER BY dist_ft ASC
        LIMIT {int(limit)}
        """,
        [lon, lat, lon, lat, lon, lat],
    ).fetchall()
    if not rows:
        return []
    bbls = [r[0] for r in rows if r[0]]
    hpd = _bbl_lookup(con, config.RENTERS_HPD_BBL, bbls)
    dob = _bbl_lookup(con, config.RENTERS_DOB_BBL, bbls)
    land = _bbl_lookup(con, config.RENTERS_LANDLORD_BBL, bbls)
    out = []
    for r in rows:
        bbl = r[0]
        h = hpd.get(bbl, {})
        d = dob.get(bbl, {})
        l = land.get(bbl, {})
        out.append({
            "bbl": bbl,
            "address": (r[1] or "").strip() or None,
            "units_res": int(r[2]) if r[2] is not None else None,
            "units_total": int(r[3]) if r[3] is not None else None,
            "year_built": int(r[4]) if r[4] not in (None, 0) else None,
            "num_floors": r[5],
            "owner_name": (r[6] or "").strip() or None,
            "bldg_class": r[7], "land_use": r[8],
            "dist_ft": round(r[9], 0) if r[9] is not None else None,
            "hpd_open_violations": {
                "total": int(h.get("open_total", 0)),
                "class_a": int(h.get("open_class_a", 0)),
                "class_b": int(h.get("open_class_b", 0)),
                "class_c": int(h.get("open_class_c", 0)),
                "class_i": int(h.get("open_class_i", 0)),
            } if h else {"total": 0, "class_a": 0, "class_b": 0, "class_c": 0, "class_i": 0},
            "dob_permits_5y": int(d.get("permits_5y", 0)) if d else 0,
            "dob_last_permit_date": str(d.get("last_permit_date")) if d and d.get("last_permit_date") is not None else None,
            "landlord": {
                "owner_name": l.get("owner_name"),
                "portfolio_buildings": int(l.get("portfolio_buildings")) if l and l.get("portfolio_buildings") is not None else None,
            } if l else None,
        })
    return out


def _bbl_lookup(con, parquet_path, bbls: list[str]) -> dict[str, dict]:
    if not bbls:
        return {}
    placeholders = ",".join("?" for _ in bbls)
    try:
        df = con.execute(
            f"SELECT * FROM read_parquet('{_p(parquet_path)}') WHERE bbl IN ({placeholders})",
            bbls,
        ).fetchdf()
    except Exception:
        return {}
    return {row["bbl"]: row.to_dict() for _, row in df.iterrows()}


# --------------------------------------------------------------------------- #
# isochrone: live OTP call (cached) with approximate grid-polygon fallback
# --------------------------------------------------------------------------- #
def _isochrone_ref(con, lat: float, lon: float, res8: str | None) -> dict[str, Any]:
    try:
        gj = isochrone.get_isochrone(lat, lon, 45, "weekday_8am")
        return {"source": "live_otp", "approximate": False, "geojson": gj}
    except Exception:
        pass
    # fallback: the res-8 45-min job-access grid polygon (WKT) for this cell's parent
    if res8:
        try:
            row = con.execute(
                f"SELECT geom_wkt, jobs_reachable, jobs_reachable_pct "
                f"FROM read_parquet('{_p(config.RENTERS_ISO_GRID)}') "
                f"WHERE res8 = ? AND status='ok' AND geom_wkt IS NOT NULL",
                [res8],
            ).fetchone()
            if row and row[0]:
                return {
                    "source": "precomputed_grid_res8",
                    "approximate": True,
                    "note": "OTP routing engine unreachable; showing the precomputed 45-min "
                            "weekday-8am reachable area for this location's ~800 m grid cell.",
                    "geometry_wkt": row[0],
                    "jobs_reachable": int(row[1]) if row[1] is not None else None,
                    "jobs_reachable_pct": round(row[2], 4) if row[2] is not None else None,
                }
        except Exception:
            pass
    return {"source": "unavailable", "approximate": True,
            "note": "No isochrone available (routing engine down and no precomputed cell)."}


# --------------------------------------------------------------------------- #
# assemble a full profile
# --------------------------------------------------------------------------- #
def _f(v):
    """None-safe float rounding for numpy/pandas scalars."""
    try:
        if v is None:
            return None
        import math
        fv = float(v)
        return None if math.isnan(fv) else fv
    except Exception:
        return None


def _scores_block(g: dict) -> dict:
    def sc(key, raw_key=None, raw_round=0):
        pct = _f(g.get(key))
        return {
            "percentile": round(pct, 1) if pct is not None else None,
            "value": (round(_f(g.get(raw_key)), raw_round) if raw_key and _f(g.get(raw_key)) is not None else None),
            "label": SCORE_META[key]["label"],
            "higher_is": SCORE_META[key]["higher_is"],
        }
    return {
        "transit_supply": sc("transit_supply_pctile", "sched_am_trips_400m"),
        "transit_access_sai": sc("transit_sai_pctile", "best_sai_400m", 2),
        "jobs_45min": sc("jobs_pctile", "jobs_45min"),
        "noise": sc("noise_pctile", "noise_400m"),
        "sidewalk_complaints": sc("sidewalk311_pctile", "sidewalk311_400m"),
        "rodent_failures": sc("rodent_fail_pctile", "rodent_fail_rate", 3),
        "pedestrian_crashes": sc("ped_crash_pctile", "ped_crash_400m"),
        "street_trees": sc("trees_pctile", "trees_400m"),
        "sidewalk_coverage": sc("sidewalk_cov_pctile", "sidewalk_full_share", 3),
    }


def build_profile(lat: float, lon: float, address_meta: dict | None = None,
                  with_isochrone: bool = True) -> dict[str, Any]:
    t0 = time.time()
    if not (_LAT_LO <= lat <= _LAT_HI and _LON_LO <= lon <= _LON_HI):
        return {"error": "location outside the NYC service area", "lat": lat, "lon": lon}
    con = _con()
    try:
        g, exact = _grid_row(con, lat, lon)
        if g is None:
            return {"error": "no data cell for this location (open water / outside NYC land grid)",
                    "lat": lat, "lon": lon}
        stops = _nearest_stops(con, lat, lon)
        buildings = _nearest_buildings(con, lat, lon)
        iso = _isochrone_ref(con, lat, lon, g.get("res8")) if with_isochrone else None

        payload = {
            "query": {"lat": lat, "lon": lon, "address": address_meta,
                      "h3_res10": g.get("h3_10"), "grid_cell_exact": exact,
                      "populated_cell": bool(g.get("populated"))},
            "scores": _scores_block(g),
            "transit": {
                "bus_stops_within_400m": int(_f(g.get("transit_stops_400m")) or 0),
                "best_sai_within_400m": round(_f(g.get("best_sai_400m")), 2) if _f(g.get("best_sai_400m")) is not None else None,
                "scheduled_am_trips_within_400m": int(_f(g.get("sched_am_trips_400m")) or 0),
                "nearest_subway": {
                    "name": g.get("subway_name"),
                    "borough": g.get("subway_borough"),
                    "distance_ft": round(_f(g.get("subway_dist_ft")), 0) if _f(g.get("subway_dist_ft")) is not None else None,
                    "distance_mi": round(_f(g.get("subway_dist_ft")) / 5280.0, 2) if _f(g.get("subway_dist_ft")) is not None else None,
                },
                "nearest_stops_detail": stops,
            },
            "flood": {
                "stormwater_moderate_current": bool(g.get("flood_sw_moderate")),
                "stormwater_extreme_2080": bool(g.get("flood_sw_extreme")),
                "fema_firm_special_flood_hazard": bool(g.get("flood_firm_sfha")),
                "fema_firm_zone": g.get("firm_zone"),
                "any_flag": bool(g.get("flood_sw_moderate") or g.get("flood_sw_extreme") or g.get("flood_firm_sfha")),
            },
            "buildings_nearby": buildings,
            "isochrone_45min_8am": iso,
            "disclaimer": DISCLAIMER,
            "sources": {
                "transit": "MTA GTFS + Stop Access Index (SAI) precompute",
                "quality_of_life": "NYC 311 (erm2-nwe9), DOHMH rodent inspections (p937-wjvj), "
                                   "NYPD/DOT MV crashes (h9gi-nx95), 2015 Street Tree Census (uvpi-gqnh), "
                                   "DOT planimetric sidewalk coverage",
                "flood": "DEP Stormwater Flood Maps + FEMA NFHL flood zones",
                "buildings": "MapPLUTO 26v1, HPD violations (wvxf-dwi5) + registrations, DOB permits",
                "jobs": "LEHD LODES WAC + OpenTripPlanner 45-min weekday-8am isochrone grid",
            },
            "elapsed_ms": round((time.time() - t0) * 1000, 1),
        }
        return payload
    finally:
        con.close()


# --------------------------------------------------------------------------- #
# endpoints
# --------------------------------------------------------------------------- #
@router.get("/profile")
async def renters_profile(
    lat: float | None = None,
    lon: float | None = None,
    address: str | None = None,
) -> JSONResponse:
    import asyncio

    address_meta = None
    if address:
        geo = await asyncio.to_thread(lambda: _cached(f"geo|{address}", 3600, lambda: geocode(address)))
        if geo is None:
            return JSONResponse({"error": f"could not geocode address: {address!r}"}, status_code=404)
        lat, lon, address_meta = geo["lat"], geo["lon"], geo
    if lat is None or lon is None:
        return JSONResponse({"error": "provide either address= or both lat= and lon="}, status_code=400)

    data = await asyncio.to_thread(build_profile, float(lat), float(lon), address_meta)
    status = 400 if "error" in data else 200
    return JSONResponse(data, status_code=status)


@router.get("/compare")
async def renters_compare(
    a_lat: float | None = None,
    a_lon: float | None = None,
    b_lat: float | None = None,
    b_lon: float | None = None,
    a_address: str | None = None,
    b_address: str | None = None,
) -> JSONResponse:
    import asyncio

    async def resolve(lat, lon, address):
        meta = None
        if address:
            geo = await asyncio.to_thread(lambda: _cached(f"geo|{address}", 3600, lambda: geocode(address)))
            if geo is None:
                return None, None, None, f"could not geocode address: {address!r}"
            return geo["lat"], geo["lon"], geo, None
        if lat is None or lon is None:
            return None, None, None, "each side needs address= or both lat= and lon="
        return float(lat), float(lon), None, None

    ala, alo, am, err_a = await resolve(a_lat, a_lon, a_address)
    if err_a:
        return JSONResponse({"error": f"A: {err_a}"}, status_code=400)
    bla, blo, bm, err_b = await resolve(b_lat, b_lon, b_address)
    if err_b:
        return JSONResponse({"error": f"B: {err_b}"}, status_code=400)

    # serialized, not gathered: two in-process DuckDB connections ATTACHing the same
    # geo DB file collide ("Unique file handle conflict") even READ_ONLY
    pa = await asyncio.to_thread(build_profile, ala, alo, am)
    pb = await asyncio.to_thread(build_profile, bla, blo, bm)
    return JSONResponse({"a": pa, "b": pb, "disclaimer": DISCLAIMER})
