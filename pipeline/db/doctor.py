#!/usr/bin/env python3
"""
doctor.py -- Jane NYC Platform (B4, Pass 1) health gate for jane_geo.duckdb + lake.

Checks (PASS/FAIL per check, plus overall):
  1. ROWCOUNTS   -- every lake table/view matches its PROVENANCE-derived expected
                    row count where recorded (giants validated EXACT).
  2. CRS         -- geometry_crs is uniform (exactly one value) per geo table.
  3. GEOID_JOIN  -- census-block -> PL94-171 GEOID coverage >= 99%.
  4. GEOMVALID   -- ST_IsValid on a 1000-row sample per geo table (report invalid).
  5. VIEWS       -- every giant + rt_* view resolves and giants have rows > 0.
  6. SKIPPED     -- not-yet-landed categories reported honestly (informational).

Green doctor is the B4 phase gate.

Run:
  PYTHONIOENCODING=utf-8 python db/doctor.py
"""
import os, sys, json, glob
import duckdb

ROOT = os.environ.get("NYCV_PIPELINE_ROOT",
                      os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # db/ -> pipeline/
RAW  = os.path.join(ROOT, "data", "raw")
LAKE = os.path.join(ROOT, "data", "parquet")
DBP  = os.path.join(ROOT, "db", "jane_geo.duckdb")

sys.path.insert(0, os.path.join(ROOT, "db"))
from convert_lake import TASKS, get_prov, prov_rows

# Geometry-bearing tables (carry geom_wkb/geom_2263/geometry_crs) are exactly the
# geo / csv_wkt / point_csv tasks -- derived so phase-2 tables are covered automatically.
GEO_TABLES = [t["slug"] for t in TASKS if t["kind"] in ("geo", "csv_wkt", "point_csv")]
# Categories to report as skipped ONLY if no task of that category is registered.
_CANDIDATE_SKIP_CATS = ["sidewalk_pedestrian", "street_network", "qol"]
_TASK_CATS = set(t["category"] for t in TASKS)
SKIPPED_CATEGORIES = [c for c in _CANDIDATE_SKIP_CATS if c not in _TASK_CATS]

def expected_rows_for(task):
    """Sum PROVENANCE rows across a task's source raw dirs (None if unrecorded)."""
    dirs = []
    if task["kind"] == "giant":
        for s in task["sources"]:
            dirs.append(os.path.dirname(os.path.join(RAW, s["src"])))
    elif "src" in task:
        dirs.append(os.path.dirname(os.path.join(RAW, task["src"])))
    else:
        return None  # lodes/citibike/gtfs -- multi-file, no single SODA count
    total, any_recorded = 0, False
    for d in dirs:
        r = prov_rows(d)
        if r is not None:
            total += int(r); any_recorded = True
    return total if any_recorded else None

def main():
    con = duckdb.connect(DBP, read_only=True)
    con.execute("LOAD spatial;")
    checks = []   # (check, name, status, detail)
    def add(check, name, ok, detail): checks.append((check, name, "PASS" if ok else "FAIL", detail))

    existing = set(r[0] for r in con.execute(
        "SELECT table_name FROM information_schema.tables").fetchall())
    existing |= set(r[0] for r in con.execute(
        "SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall())

    # ---- 1. ROWCOUNTS ----
    for t in TASKS:
        slug = t["slug"]
        if slug not in existing:
            continue
        exp = expected_rows_for(t)
        act = con.execute(f'SELECT count(*) FROM "{slug}"').fetchone()[0]
        if exp is None:
            # distinguish "PROVENANCE.json present but no count" from "PROVENANCE absent"
            dirs = []
            if t["kind"] == "giant":
                dirs = [os.path.dirname(os.path.join(RAW, s["src"])) for s in t["sources"]]
            elif "src" in t:
                dirs = [os.path.dirname(os.path.join(RAW, t["src"]))]
            prov_absent = any(not os.path.exists(os.path.join(d, "PROVENANCE.json")) for d in dirs) if dirs else False
            note = ("PROVENANCE pending; validated by parser row-count only"
                    if prov_absent else "no SODA count recorded")
            checks.append(("ROWCOUNTS", slug, "INFO", f"{act:,} rows ({note})"))
        elif t["kind"] == "giant":
            # giants are SODA/parser-counted snapshots -> validated EXACT (e.g. 311 = 21,826,798)
            add("ROWCOUNTS", slug, act == exp, f"actual {act:,} vs expected {exp:,} (EXACT)")
        else:
            # Non-giant whole-file exports: DuckDB's logical row count is authoritative.
            # It can differ from a provenance line-counter by a hair (embedded newlines in
            # quoted fields overcount) and geo (csv_wkt/geo) tables legitimately drop
            # null/empty-geometry features. PASS on a tiny/geo-drop delta; report it.
            delta = exp - act
            tol = max(10, int(exp * 0.0005))
            ok = (0 <= delta <= tol) or (abs(delta) <= 2)
            add("ROWCOUNTS", slug, ok, f"actual {act:,} vs expected {exp:,} (delta={delta})")

    # ---- 2. CRS uniformity ----
    for tbl in GEO_TABLES:
        if tbl not in existing:
            checks.append(("CRS", tbl, "INFO", "table absent")); continue
        vals = [r[0] for r in con.execute(f'SELECT DISTINCT geometry_crs FROM "{tbl}"').fetchall()]
        add("CRS", tbl, len(vals) == 1, f"crs values={vals}")

    # ---- 3. GEOID join coverage ----
    if {"pop_census_blocks","pop_block_pop"} <= existing:
        r = con.execute("""
            SELECT count(*) blocks, sum(CASE WHEN p.GEOID15 IS NOT NULL THEN 1 ELSE 0 END) hit
            FROM pop_census_blocks b
            LEFT JOIN pop_block_pop p ON b.geoid = p.GEOID15
        """).fetchone()
        pct = 100.0 * r[1] / r[0] if r[0] else 0
        add("GEOID_JOIN", "census_block->pl94171", pct >= 99.0, f"{r[1]:,}/{r[0]:,} = {pct:.2f}%")

    # ---- 4. geometry validity sample ----
    for tbl in GEO_TABLES:
        if tbl not in existing:
            continue
        r = con.execute(f"""
            SELECT count(*) FILTER (WHERE geom_2263 IS NOT NULL) n,
                   count(*) FILTER (WHERE geom_2263 IS NOT NULL AND NOT ST_IsValid(geom_2263)) bad
            FROM (SELECT geom_2263 FROM "{tbl}" USING SAMPLE 1000 ROWS)
        """).fetchone()
        n, bad = r[0], r[1]
        frac = (bad / n) if n else 0
        # FAIL only if >5% of the non-null sample is invalid
        add("GEOMVALID", tbl, frac <= 0.05, f"{bad}/{n} invalid in sample ({frac*100:.2f}%)")

    # ---- 5. views resolve + giants have rows ----
    giant_slugs = [t["slug"] for t in TASKS if t["kind"] == "giant"]
    rt_views = [r[0] for r in con.execute(
        "SELECT view_name FROM duckdb_views() WHERE NOT internal AND view_name LIKE 'rt_%'").fetchall()]
    for slug in giant_slugs:
        if slug not in existing:
            add("VIEWS", slug, False, "giant view missing"); continue
        n = con.execute(f'SELECT count(*) FROM "{slug}"').fetchone()[0]
        add("VIEWS", slug, n > 0, f"{n:,} rows")
    for v in rt_views:
        try:
            n = con.execute(f'SELECT count(*) FROM "{v}"').fetchone()[0]
            # rt views may legitimately be small; resolving + >=0 is PASS, note 0 as WARN
            status = "PASS" if n > 0 else "WARN"
            checks.append(("VIEWS", v, status, f"{n:,} rows"))
        except Exception as e:
            checks.append(("VIEWS", v, "FAIL", f"resolve error: {repr(e)[:100]}"))

    # ---- 6. skipped categories ----
    for cat in SKIPPED_CATEGORIES:
        landed = os.path.isdir(os.path.join(RAW, cat)) and any(
            f.endswith((".csv",".geojson",".zip",".shp")) for _,_,fs in os.walk(os.path.join(RAW, cat)) for f in fs)
        checks.append(("SKIPPED", cat, "INFO",
                       "raw present but NOT registered this pass" if landed else "not yet landed"))

    # ---- report ----
    con.close()
    print("=" * 72)
    print("JANE NYC PLATFORM -- jane_geo.duckdb DOCTOR")
    print("=" * 72)
    order = ["ROWCOUNTS","CRS","GEOID_JOIN","GEOMVALID","VIEWS","SKIPPED"]
    hard_fail = 0
    for grp in order:
        rows = [c for c in checks if c[0] == grp]
        if not rows: continue
        print(f"\n[{grp}]")
        for _, name, st, detail in rows:
            print(f"  {st:5} {name:36} {detail}")
            if st == "FAIL":
                hard_fail += 1
    overall = "PASS" if hard_fail == 0 else "FAIL"
    print("\n" + "=" * 72)
    print(f"OVERALL: {overall}   ({hard_fail} FAIL check(s))")
    print("=" * 72)
    json.dump({"overall": overall, "hard_fail": hard_fail,
               "checks": [{"check":c,"name":n,"status":s,"detail":d} for c,n,s,d in checks]},
              open(os.path.join(ROOT, "db", "DOCTOR_REPORT.json"), "w"), indent=2)
    sys.exit(0 if overall == "PASS" else 1)

if __name__ == "__main__":
    main()
