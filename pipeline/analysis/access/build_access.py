"""Transit-access precomputed grid + jobs-accessibility + income-decile equity.

Pipeline (resumable):
  prep    -> build the H3 res-8 origin grid over NYC land, tag every census block
             with its res-9/res-8 cell + WAC jobs + block-group income + population,
             and compute the frequent-transit stop set.  Writes _cache/*.parquet.
  grid    -> for each res-8 origin cell centroid, query box OTP for a 45-min
             weekday-8am WALK+TRANSIT isochrone, convert to the set of reachable
             H3 res-9 cells, sum reachable NYC-block jobs.  Checkpoints per cell
             (resumable); writes isochrone_grid_45min.parquet.
  equity  -> join grid -> blocks -> block groups; population-weighted income deciles;
             writes jobs_accessibility_block.parquet, access_equity.parquet + .xlsx.

Usage:
  python build_access.py prep
  python build_access.py grid   [--otp http://localhost:8080] [--limit N] [--workers 2]
  python build_access.py equity

Honesty: an origin whose OTP query fails is recorded status=error and retried on the
next `grid` run.  We never write a fabricated polygon or a guessed job count.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import duckdb
import h3
import pandas as pd
from shapely import wkt as shapely_wkt

HERE = Path(__file__).resolve().parent
# analysis/access -> analysis -> NYCPlatform
PLATFORM = HERE.parents[1]
DATA = PLATFORM / "data" / "parquet"
CACHE = HERE / "_cache"
CACHE.mkdir(exist_ok=True)

BLOCKS_PQ = DATA / "population" / "pop_census_blocks.parquet"
WAC_PQ = DATA / "landuse" / "pop_lodes_wac.parquet"
ACS_PQ = DATA / "population" / "pop_bg_acs.parquet"
BLOCKPOP_PQ = DATA / "population" / "pop_block_pop.parquet"
STOPS_PQ = DATA / "transit_static" / "transit_gtfs_stops.parquet"
STOPTIMES_PQ = DATA / "transit_static" / "transit_gtfs_stop_times.parquet"

ORIGIN_RES = 8       # origin grid resolution
REACH_RES = 9        # reachability cell resolution
FREQ_AM_MIN_TRIPS = 8      # >=8 scheduled AM-peak trips in the 7-9am window (~<=15 min headway)
FREQ_RADIUS_M = 400        # walk radius to a frequent stop
DEPART_DATE = os.environ.get("ISOCHRONE_DEPART_DATE", "2026-07-22")  # a Wednesday
DEPART_HHMM = "08:00"
CUTOFF_MIN = 45

BLOCKS_CACHE = CACHE / "blocks_tagged.parquet"
CELLS_CACHE = CACHE / "origin_cells.parquet"
FREQCELLS_CACHE = CACHE / "frequent_res9.parquet"
GRID_CKPT = CACHE / "grid_checkpoint.parquet"

GRID_OUT = HERE / "isochrone_grid_45min.parquet"
JOBS_OUT = HERE / "jobs_accessibility_block.parquet"
EQUITY_OUT = HERE / "access_equity.parquet"
EQUITY_XLSX = HERE / "access_equity.xlsx"


# ---------------------------------------------------------------------------
# prep
# ---------------------------------------------------------------------------
def _hhmmss_to_sec(s: str) -> int:
    h, m, sec = s.split(":")
    return int(h) * 3600 + int(m) * 60 + int(sec)


def prep() -> None:
    import shapely.wkb as swkb

    con = duckdb.connect()
    print("[prep] loading census blocks + WAC jobs + block-group income ...")
    # Block centroids computed with shapely (WGS84 WKB); duckdb for the tabular joins.
    raw = pd.read_parquet(BLOCKS_PQ, columns=["geoid", "geom_wkb", "boroname"])
    lats, lons = [], []
    for b in raw.geom_wkb:
        try:
            c = swkb.loads(bytes(b)).centroid
            lons.append(c.x)
            lats.append(c.y)
        except Exception:
            lons.append(None)
            lats.append(None)
    base = pd.DataFrame({
        "geoid": raw.geoid.astype(str),
        "lat": lats, "lon": lons, "boroname": raw.boroname,
    })
    base["bg_geoid"] = base.geoid.str.slice(0, 12)
    # WAC jobs join (block geoid == w_geocode)
    wac = con.execute(
        f"SELECT CAST(w_geocode AS VARCHAR) AS geoid, C000 AS jobs "
        f"FROM read_parquet('{WAC_PQ.as_posix()}')"
    ).df()
    df = base.merge(wac, on="geoid", how="left")
    df["jobs"] = df["jobs"].fillna(0).astype("int64")
    # block population (optional)
    try:
        pop = con.execute(
            f"SELECT * FROM read_parquet('{BLOCKPOP_PQ.as_posix()}') LIMIT 1"
        ).df()
        popcols = list(pop.columns)
        geoidcol = next((c for c in popcols if c.lower() in ("geoid", "geoid15", "geoid20", "bctcb2020")), None)
        popcol = next((c for c in popcols if c.lower() in ("total_pop", "pop", "population", "p1_001n", "pop20")), None)
        if geoidcol and popcol:
            popdf = con.execute(
                f"SELECT CAST({geoidcol} AS VARCHAR) AS geoid, TRY_CAST({popcol} AS BIGINT) AS pop "
                f"FROM read_parquet('{BLOCKPOP_PQ.as_posix()}')"
            ).df()
            df = df.merge(popdf, on="geoid", how="left")
        else:
            df["pop"] = None
    except Exception as e:
        print(f"[prep] block pop unavailable ({e}); population weights fall back to jobs origin count")
        df["pop"] = None

    df = df.dropna(subset=["lat", "lon"])
    df = df[(df.lat.between(40.3, 41.0)) & (df.lon.between(-74.4, -73.6))]
    print(f"[prep] {len(df):,} NYC blocks with centroids; {int(df.jobs.sum()):,} WAC jobs matched")

    # H3 tags
    df["res9"] = [h3.latlng_to_cell(la, lo, REACH_RES) for la, lo in zip(df.lat, df.lon)]
    df["res8"] = [h3.latlng_to_cell(la, lo, ORIGIN_RES) for la, lo in zip(df.lat, df.lon)]
    df.to_parquet(BLOCKS_CACHE, index=False)
    print(f"[prep] wrote {BLOCKS_CACHE.name}")

    # Origin grid = distinct res-8 cells that contain at least one NYC block centroid.
    cells = (
        df.groupby("res8")
        .agg(n_blocks=("geoid", "size"), block_jobs=("jobs", "sum"))
        .reset_index()
    )
    cents = [h3.cell_to_latlng(c) for c in cells.res8]
    cells["lat"] = [c[0] for c in cents]
    cells["lon"] = [c[1] for c in cents]
    cells.to_parquet(CELLS_CACHE, index=False)
    print(f"[prep] {len(cells):,} res-8 origin cells -> {CELLS_CACHE.name}")

    # Frequent-transit stops: >= FREQ_AM_MIN_TRIPS scheduled departures 07:00-09:00,
    # excluding obviously weekend-only trips (trip_id token Saturday/Sunday/Weekend).
    print("[prep] computing frequent AM-peak stops ...")
    freq = con.execute(
        f"""
        WITH st AS (
            SELECT feed, stop_id, trip_id, departure_time
            FROM read_parquet('{STOPTIMES_PQ.as_posix()}')
            WHERE departure_time >= '07:00:00' AND departure_time < '09:00:00'
              AND lower(trip_id) NOT LIKE '%saturday%'
              AND lower(trip_id) NOT LIKE '%sunday%'
              AND lower(trip_id) NOT LIKE '%weekend%'
        ),
        cnt AS (
            SELECT feed, stop_id, COUNT(*) AS am_trips
            FROM st GROUP BY feed, stop_id
            HAVING COUNT(*) >= {FREQ_AM_MIN_TRIPS}
        )
        SELECT c.feed, c.stop_id, c.am_trips,
               TRY_CAST(s.stop_lat AS DOUBLE) AS lat,
               TRY_CAST(s.stop_lon AS DOUBLE) AS lon
        FROM cnt c JOIN read_parquet('{STOPS_PQ.as_posix()}') s
          ON c.feed = s.feed AND c.stop_id = s.stop_id
        WHERE s.stop_lat IS NOT NULL
        """
    ).df().dropna(subset=["lat", "lon"])
    print(f"[prep] {len(freq):,} frequent AM-peak stops")

    # A res-9 cell is 'frequent-access' if a frequent stop lies within FREQ_RADIUS_M.
    # Mark the stop's res-9 cell + its k-ring (res-9 edge ~174m; k=2 ~ up to ~430m).
    freq_cells: set[str] = set()
    for la, lo in zip(freq.lat, freq.lon):
        c9 = h3.latlng_to_cell(la, lo, REACH_RES)
        freq_cells.update(h3.grid_disk(c9, 2))
    fc = pd.DataFrame({"res9": sorted(freq_cells)})
    fc.to_parquet(FREQCELLS_CACHE, index=False)
    print(f"[prep] {len(fc):,} res-9 cells flagged frequent-transit-access -> {FREQCELLS_CACHE.name}")
    print("[prep] done.")


# ---------------------------------------------------------------------------
# grid
# ---------------------------------------------------------------------------
def _covered_res9(geom) -> set:
    """Set of H3 res-9 cells covered by an isochrone geometry (robust to type)."""
    try:
        return set(h3.geo_to_cells(geom, REACH_RES))
    except Exception:
        cells: set = set()
        geoms = getattr(geom, "geoms", [geom])
        for g in geoms:
            try:
                cells.update(h3.geo_to_cells(g, REACH_RES))
            except Exception:
                pass
        return cells


def _load_jobs_by_res9() -> dict[str, int]:
    df = pd.read_parquet(BLOCKS_CACHE, columns=["res9", "jobs"])
    return df.groupby("res9").jobs.sum().astype("int64").to_dict()


def grid(otp_url: str, limit: int | None, workers: int) -> None:
    from otp_client import fetch_isochrone, OTPError

    cells = pd.read_parquet(CELLS_CACHE)
    jobs_by_res9 = _load_jobs_by_res9()
    total_nyc_jobs = int(sum(jobs_by_res9.values()))

    # resume from checkpoint
    if GRID_CKPT.exists():
        done = pd.read_parquet(GRID_CKPT)
        done_ok = set(done.loc[done.status == "ok", "res8"])
    else:
        done = pd.DataFrame(columns=["res8", "lat", "lon", "status", "jobs_reachable",
                                     "n_reach_res9", "geom_wkt", "error"])
        done_ok = set()

    todo = cells[~cells.res8.isin(done_ok)].reset_index(drop=True)
    if limit:
        todo = todo.head(limit)
    print(f"[grid] {len(done_ok):,}/{len(cells):,} already done; {len(todo):,} to do this run")

    rows = done.to_dict("records")
    t0 = time.time()
    n_new = 0
    for i, row in todo.iterrows():
        c8, la, lo = row.res8, float(row.lat), float(row.lon)
        try:
            geom = fetch_isochrone(otp_url, la, lo, CUTOFF_MIN, DEPART_DATE, DEPART_HHMM)
            reach = _covered_res9(geom)  # set of covered res-9 cells
            jobs = int(sum(jobs_by_res9.get(c, 0) for c in reach))
            rows.append({
                "res8": c8, "lat": la, "lon": lo, "status": "ok",
                "jobs_reachable": jobs, "n_reach_res9": len(reach),
                "geom_wkt": geom.wkt, "error": None,
            })
        except (OTPError, Exception) as e:
            rows.append({
                "res8": c8, "lat": la, "lon": lo, "status": "error",
                "jobs_reachable": None, "n_reach_res9": None,
                "geom_wkt": None, "error": str(e)[:300],
            })
        n_new += 1
        if n_new % 25 == 0:
            _flush(rows)
            rate = n_new / (time.time() - t0)
            print(f"[grid] {n_new}/{len(todo)} this run ({rate:.2f}/s) "
                  f"~{(len(todo)-n_new)/max(rate,1e-6)/60:.1f} min left")
    _flush(rows)

    ck = pd.read_parquet(GRID_CKPT)
    ok = ck[ck.status == "ok"].copy()
    ok["jobs_reachable_pct"] = ok["jobs_reachable"] / total_nyc_jobs
    ok.to_parquet(GRID_OUT, index=False)
    n_err = int((ck.status == "error").sum())
    print(f"[grid] wrote {GRID_OUT.name}: {len(ok):,} cells ok, {n_err} errors "
          f"(errors retry next run). total NYC jobs baseline={total_nyc_jobs:,}")


def _flush(rows: list[dict]) -> None:
    # dedupe by res8 keeping the last (latest attempt)
    df = pd.DataFrame(rows).drop_duplicates(subset="res8", keep="last")
    df.to_parquet(GRID_CKPT, index=False)


# ---------------------------------------------------------------------------
# equity
# ---------------------------------------------------------------------------
def equity() -> None:
    blocks = pd.read_parquet(BLOCKS_CACHE)
    grid_df = pd.read_parquet(GRID_OUT)[["res8", "jobs_reachable", "jobs_reachable_pct"]]
    freq = set(pd.read_parquet(FREQCELLS_CACHE).res9)

    # each block inherits its origin (res-8) cell's reachable-jobs
    b = blocks.merge(grid_df, on="res8", how="left")
    b["frequent_transit_access"] = b.res9.isin(freq)

    # block-group median income
    con = duckdb.connect()
    acs = con.execute(
        f"""SELECT GEOID12 AS bg_geoid,
                   TRY_CAST(B19013_001E AS DOUBLE) AS med_income,
                   TRY_CAST(B01003_001E AS DOUBLE) AS bg_pop
            FROM read_parquet('{ACS_PQ.as_posix()}')"""
    ).df()
    acs.loc[acs.med_income < 0, "med_income"] = None  # -666666666 sentinel
    b = b.merge(acs, on="bg_geoid", how="left")

    # population weight: block pop if present else block-group pop share fallback
    if b["pop"].notna().any():
        b["w"] = b["pop"].fillna(0).clip(lower=0)
    else:
        b["w"] = 1.0
    # if all weights zero, fall back to equal weight
    if b["w"].sum() == 0:
        b["w"] = 1.0

    jobs_block = b[["geoid", "boroname", "bg_geoid", "res8", "res9", "jobs",
                    "jobs_reachable", "jobs_reachable_pct", "frequent_transit_access",
                    "med_income", "pop"]].copy()
    jobs_block.to_parquet(JOBS_OUT, index=False)
    print(f"[equity] wrote {JOBS_OUT.name}: {len(jobs_block):,} blocks")

    # income deciles: rank blocks by their block-group median income, population-weighted
    e = b.dropna(subset=["med_income", "jobs_reachable"]).copy()
    e = e[e.w > 0]
    e = e.sort_values("med_income").reset_index(drop=True)
    e["cw"] = e["w"].cumsum()
    total_w = e["w"].sum()
    e["decile"] = (e["cw"] / total_w * 10).clip(upper=9.9999).astype(int) + 1

    def wavg(g, col):
        return (g[col] * g["w"]).sum() / g["w"].sum()

    summ = []
    for d, g in e.groupby("decile"):
        summ.append({
            "income_decile": d,
            "median_income_range_low": round(g.med_income.min(), 0),
            "median_income_range_high": round(g.med_income.max(), 0),
            "population": int(g.w.sum()),
            "n_blocks": len(g),
            "mean_jobs_reachable_45min": round(wavg(g, "jobs_reachable"), 0),
            "mean_jobs_reachable_pct": round(wavg(g, "jobs_reachable_pct"), 4),
            "frequent_transit_access_share": round(
                (g.frequent_transit_access.astype(float) * g.w).sum() / g.w.sum(), 4),
        })
    eq = pd.DataFrame(summ).sort_values("income_decile")
    eq.to_parquet(EQUITY_OUT, index=False)
    try:
        eq.to_excel(EQUITY_XLSX, index=False)
    except Exception as e2:
        print(f"[equity] xlsx write skipped: {e2}")
    print(f"[equity] wrote {EQUITY_OUT.name} + xlsx")
    print(eq.to_string(index=False))
    # headline gap
    lo = eq.iloc[0]["mean_jobs_reachable_45min"]
    hi = eq.iloc[-1]["mean_jobs_reachable_45min"]
    print(f"[equity] D1(low-income) mean jobs={lo:,.0f}; D10(high-income) mean jobs={hi:,.0f}; "
          f"ratio={hi/max(lo,1):.2f}x")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("prep")
    g = sub.add_parser("grid")
    g.add_argument("--otp", default=os.environ.get("OTP_URL", "http://localhost:8080"))
    g.add_argument("--limit", type=int, default=None)
    g.add_argument("--workers", type=int, default=1)
    sub.add_parser("equity")
    args = ap.parse_args()

    sys.path.insert(0, str(HERE))
    if args.cmd == "prep":
        prep()
    elif args.cmd == "grid":
        grid(args.otp, args.limit, args.workers)
    elif args.cmd == "equity":
        equity()
