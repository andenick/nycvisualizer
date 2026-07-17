"""Shared helpers for the Jane B5.1 sidewalk-coverage analysis suite.

All measurement geometry is EPSG:2263 (NY State Plane Long Island, ftUS).
DB: Technical/NYCPlatform/db/jane_geo.duckdb (read-only). Outputs:
Projects/Jane/Outputs/NYCPlatform/sidewalk/.
"""
import os
import duckdb
import pandas as pd

DB = os.path.join(os.path.dirname(__file__), "..", "..", "db", "jane_geo.duckdb")
DB = os.path.abspath(DB)
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..",
                                   "..", "Outputs", "NYCPlatform", "sidewalk"))
os.makedirs(OUT, exist_ok=True)

# CSCL "Borough Code" -> name
BORO = {"1": "Manhattan", "2": "Bronx", "3": "Brooklyn", "4": "Queens", "5": "Staten Island"}
# Census/BBL leading borocode 1..5 same mapping
FT_PER_MILE = 5280.0


def connect():
    c = duckdb.connect(DB, read_only=True)
    c.execute("LOAD spatial;")
    c.execute("SET threads TO 8;")
    return c


def opath(name):
    return os.path.join(OUT, name)


def write_outputs(df: pd.DataFrame, stem: str, sheet: str = "data",
                  extra_sheets: dict | None = None):
    """Write a parquet + one-sheet (or multi-sheet) XLSX for a dataframe."""
    pq = opath(stem + ".parquet")
    df.to_parquet(pq, index=False)
    xlsx = opath(stem + ".xlsx")
    with pd.ExcelWriter(xlsx, engine="openpyxl") as xw:
        df.to_excel(xw, sheet_name=sheet[:31], index=False)
        if extra_sheets:
            for sn, sdf in extra_sheets.items():
                sdf.to_excel(xw, sheet_name=sn[:31], index=False)
    print(f"  wrote {pq}  ({len(df):,} rows)")
    print(f"  wrote {xlsx}")
    return pq, xlsx
