"""S7 verification: 10 addresses across the 5 boroughs through the live backend functions.

Imports the FastAPI app's renters module in-process (no server needed): geocodes each address
via GeoSearch, builds the full profile, prints a compact per-address table + timings, then tests
the compare path and a couple of targeted sanity checks (flood flags, no-sidewalk, noise percentiles).
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

# make `app` importable
BACKEND = Path(__file__).resolve().parents[2] / "site" / "backend"
sys.path.insert(0, str(BACKEND))

from app import renters  # noqa: E402

ADDRESSES = [
    ("1 Times Square, Manhattan", "Manhattan / Midtown (expect HIGH noise pctile)"),
    ("311 Todt Hill Road, Staten Island", "Staten Island / Todt Hill (expect LOW noise pctile)"),
    ("97 Prospect Park West, Brooklyn", "Brooklyn / Park Slope"),
    ("40-24 Main Street, Flushing, Queens", "Queens / Flushing"),
    ("851 Grand Concourse, Bronx", "Bronx / Concourse"),
    ("480 Van Brunt Street, Brooklyn", "Brooklyn / Red Hook (expect FLOOD flag)"),
    ("159-01 Cross Bay Boulevard, Queens", "Queens / Howard Beach (expect FLOOD flag)"),
    ("55 West 125th Street, Manhattan", "Manhattan / Harlem"),
    ("2344 Arthur Avenue, Bronx", "Bronx / Belmont"),
    ("10 Bay Street, Staten Island", "Staten Island / St. George"),
]


def one(address: str, note: str) -> dict:
    t0 = time.time()
    geo = renters.geocode(address)
    if geo is None:
        return {"address": address, "note": note, "error": "geocode failed"}
    # warm the grid/parquet caches by calling twice; report the warm timing.
    # profile_ms = precomputed path only (no live isochrone); warm_ms = full incl. isochrone ref.
    _ = renters.build_profile(geo["lat"], geo["lon"], geo)
    tp = time.time()
    _ = renters.build_profile(geo["lat"], geo["lon"], geo, with_isochrone=False)
    profile_ms = (time.time() - tp) * 1000
    tw = time.time()
    p = renters.build_profile(geo["lat"], geo["lon"], geo)
    warm_ms = (time.time() - tw) * 1000
    if "error" in p:
        return {"address": address, "note": note, "error": p["error"], "matched": geo.get("matched_label")}
    s = p["scores"]
    fl = p["flood"]
    tr = p["transit"]
    return {
        "address": address,
        "note": note,
        "matched": geo.get("matched_label"),
        "bbl": geo.get("bbl"),
        "populated": p["query"]["populated_cell"],
        "noise_pct": s["noise"]["percentile"],
        "trees_pct": s["street_trees"]["percentile"],
        "transit_pct": s["transit_supply"]["percentile"],
        "jobs_pct": s["jobs_45min"]["percentile"],
        "rodent_pct": s["rodent_failures"]["percentile"],
        "swcov_pct": s["sidewalk_coverage"]["percentile"],
        "sw_full_share": s["sidewalk_coverage"]["value"],
        "bus_400m": tr["bus_stops_within_400m"],
        "subway": (tr["nearest_subway"]["name"], tr["nearest_subway"]["distance_ft"]),
        "n_stops_detail": len(tr["nearest_stops_detail"]),
        "n_buildings": len(p["buildings_nearby"]),
        "flood": fl["any_flag"],
        "flood_detail": (fl["stormwater_moderate_current"], fl["stormwater_extreme_2080"],
                         fl["fema_firm_special_flood_hazard"], fl["fema_firm_zone"]),
        "iso_source": p["isochrone_45min_8am"]["source"],
        "iso_approx": p["isochrone_45min_8am"]["approximate"],
        "total_ms": round((time.time() - t0) * 1000, 0),
        "profile_ms": round(profile_ms, 0),
        "warm_ms": round(warm_ms, 0),
    }


def main() -> None:
    results = [one(a, n) for a, n in ADDRESSES]
    print("\n================ PER-ADDRESS PROFILE VERIFICATION ================")
    hdr = ("borough/area", "noise%", "tree%", "trans%", "jobs%", "flood", "bus400", "subwayft",
           "bld", "prof_ms", "warm_ms")
    print("{:<40} {:>6} {:>5} {:>6} {:>5} {:>5} {:>6} {:>8} {:>4} {:>7} {:>7}".format(*hdr))
    for r in results:
        if "error" in r:
            print(f"{(r['note'] or r['address'])[:40]:<40} ERROR: {r['error']}")
            continue
        sub_ft = r["subway"][1]
        print("{:<40} {:>6} {:>5} {:>6} {:>5} {:>5} {:>6} {:>8} {:>4} {:>7} {:>7}".format(
            (r["note"] or r["address"])[:40],
            _fmt(r["noise_pct"]), _fmt(r["trees_pct"]), _fmt(r["transit_pct"]),
            _fmt(r["jobs_pct"]), "YES" if r["flood"] else "-",
            r["bus_400m"], int(sub_ft) if sub_ft is not None else "-",
            r["n_buildings"], int(r["profile_ms"]), int(r["warm_ms"]),
        ))
    # one full example payload summary
    ex = next((r for r in results if "error" not in r), None)
    if ex:
        print("\n---- EXAMPLE FULL PAYLOAD SUMMARY:", ex["address"], "----")
        for k in ("matched", "bbl", "populated", "subway", "n_stops_detail", "n_buildings",
                  "flood_detail", "sw_full_share", "swcov_pct", "rodent_pct", "iso_source", "iso_approx"):
            print(f"   {k:<16}: {ex[k]}")

    # compare endpoint (two coords)
    print("\n---- COMPARE (Midtown vs Todt Hill) ----")
    import asyncio, json
    g1 = renters.geocode(ADDRESSES[0][0]); g2 = renters.geocode(ADDRESSES[1][0])
    t0 = time.time()
    pa = renters.build_profile(g1["lat"], g1["lon"], g1)
    pb = renters.build_profile(g2["lat"], g2["lon"], g2)
    print(f"   A noise%={pa['scores']['noise']['percentile']} vs B noise%={pb['scores']['noise']['percentile']} "
          f"(compare built in {(time.time()-t0)*1000:.0f} ms for both)")

    # sanity assertions
    print("\n---- SANITY CHECKS ----")
    ok = [r for r in results if "error" not in r]
    n_ok = len(ok)
    print(f"   {n_ok}/{len(results)} addresses returned a complete profile")
    slow = [r for r in ok if r["profile_ms"] > 1000]
    print(f"   precomputed-path <1s: {'PASS' if not slow else 'CHECK'} "
          f"(max profile_ms={max((r['profile_ms'] for r in ok), default=0):.0f})")

    def find(tag):
        return next((r for r in ok if tag in (r["note"] or "")), None)

    mid, todt = find("Midtown"), find("Todt Hill")
    if mid and todt:
        print(f"   Midtown noise {mid['noise_pct']} > Todt Hill {todt['noise_pct']}: "
              f"{'PASS' if (mid['noise_pct'] or 0) > (todt['noise_pct'] or 0) else 'CHECK'}")
    for tag in ("Red Hook", "Howard Beach"):
        r = find(tag)
        if r:
            print(f"   {tag} flood flag: {'PASS' if r['flood'] else 'CHECK'} {r['flood_detail']}")


def _fmt(v):
    return f"{v:.0f}" if isinstance(v, (int, float)) else "-"


if __name__ == "__main__":
    main()
