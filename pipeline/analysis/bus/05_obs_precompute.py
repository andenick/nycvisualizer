"""05 - Precompute the two slow jane_geo aggregates the Bus Observatory dossier needs.

The dossier endpoint (`/api/obs/dossier`) must answer in < 2 s cold, but two of its
inputs live in the 5.4 GB `jane_geo.duckdb` and are expensive to scan per request:

  * route-level ridership-by-hour  (from `transit_ridership_bus_hourly`, ~584 M rows)
  * per-route ACE violation counts (from `transit_ace_violations`, joined to
    `transit_ace_routes` for the program + implementation date)

This script rolls both to tiny per-route Parquet artifacts under
`Outputs/NYCPlatform/bus/obs/` that the backend reads directly. Run at build time and
on the `JaneNYCDerive` cadence (they change slowly — ridership is historical APC, ACE
is a program reference). Reuses `common.connect()` (read-only jane_geo).

No fabricated numbers: every table is a straight serialization of a real query.
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd
from common import OUT as BUS_OUT
from common import borough_expr, connect

OUT = Path(BUS_OUT) / "obs"
OUT.mkdir(parents=True, exist_ok=True)


def _write(df: pd.DataFrame, name: str) -> None:
    p = OUT / f"{name}.parquet"
    df.to_parquet(p, index=False)
    print(f"  wrote {p.name}  ({len(df):,} rows)")


def main() -> None:
    con = connect()
    print("[05] Bus Observatory dossier precompute")

    # --- route x hour-of-day ridership (weekday / weekend boardings) --------------
    bor = borough_expr("bus_route")
    ridership = con.execute(
        f"""
        WITH d AS (
          SELECT bus_route AS route,
                 {bor}                       AS borough,
                 hour(transit_timestamp)     AS hod,
                 isodow(transit_timestamp)   AS dow,
                 ridership
          FROM transit_ridership_bus_hourly
        )
        SELECT route, any_value(borough) AS borough, hod,
               SUM(CASE WHEN dow <= 5 THEN ridership END) AS weekday_boardings,
               SUM(CASE WHEN dow >= 6 THEN ridership END) AS weekend_boardings,
               SUM(ridership)                             AS total_boardings
        FROM d
        GROUP BY route, hod
        ORDER BY route, hod
        """
    ).df()
    _write(ridership, "route_hourly_ridership")

    # --- per-route ACE program summary + first/last + total ----------------------
    ace = con.execute(
        """
        WITH v AS (
          SELECT bus_route_id AS route,
                 count(*)                        AS violations_total,
                 min(first_occurrence)::DATE     AS first_violation,
                 max(first_occurrence)::DATE     AS last_violation
          FROM transit_ace_violations
          WHERE bus_route_id IS NOT NULL
          GROUP BY 1
        )
        SELECT COALESCE(v.route, r.route)         AS route,
               r._program                          AS program,
               r.implementation_date::DATE         AS implementation_date,
               COALESCE(v.violations_total, 0)     AS violations_total,
               v.first_violation,
               v.last_violation
        FROM v
        FULL OUTER JOIN transit_ace_routes r ON r.route = v.route
        ORDER BY violations_total DESC
        """
    ).df()
    _write(ace, "route_ace")

    # --- per-route ACE violations by calendar year (for the dossier mini-series) --
    ace_year = con.execute(
        """
        SELECT bus_route_id                       AS route,
               year(first_occurrence)             AS year,
               count(*)                           AS violations
        FROM transit_ace_violations
        WHERE bus_route_id IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 1, 2
        """
    ).df()
    _write(ace_year, "route_ace_by_year")

    con.close()
    print("[05] done ->", OUT)


if __name__ == "__main__":
    main()
