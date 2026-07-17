"""Shared helpers for the Jane NYC-Platform Stop Accessibility Index (SAI) suite (B5.2 item 4 + B5.3).

Connection to jane_geo.duckdb (read-only), standardized writers (Parquet + one-sheet XLSX),
and small geometry/scoring utilities. Every number a writer serializes came from a real query —
nothing is fabricated. EPSG:2263 (ftUS) is the canonical CRS for all distance/area math.
"""
from __future__ import annotations
import os
import duckdb
import numpy as np
import pandas as pd

_PIPELINE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # analysis/sai -> pipeline
DB = os.environ.get("JANE_GEO_DB", os.path.join(_PIPELINE, "db", "jane_geo.duckdb"))
OUT = os.environ.get("NYCV_OUTPUTS", os.path.join(_PIPELINE, "outputs", "sai"))
CHARTS = os.path.join(OUT, "charts")

os.makedirs(OUT, exist_ok=True)
os.makedirs(CHARTS, exist_ok=True)

# Walkshed radius: 400 m = 1312.336 ftUS (2263 units are US survey feet).
WALKSHED_FT = 400.0 / 0.3048006096012192  # = 1312.336...
FT_PER_M = 1.0 / 0.3048006096012192

# GTFS local-bus feeds (excludes express-only company overlaps handled via feed union).
BUS_FEEDS = (
    "'bus_bronx','bus_brooklyn','bus_manhattan','bus_queens',"
    "'bus_staten_island','bus_mta_bus_company'"
)


def connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(DB, read_only=True)
    try:
        con.execute("LOAD spatial;")
    except Exception:
        pass
    con.execute("PRAGMA threads=8;")
    return con


def write_table(df: pd.DataFrame, name: str, sheet: str | None = None) -> None:
    """Write a DataFrame as Parquet + a single-sheet XLSX (one sheet per file)."""
    pq = os.path.join(OUT, f"{name}.parquet")
    xl = os.path.join(OUT, f"{name}.xlsx")
    df.to_parquet(pq, index=False)
    sheet = (sheet or name)[:31]
    with pd.ExcelWriter(xl, engine="openpyxl") as w:
        df.to_excel(w, index=False, sheet_name=sheet)
    print(f"  wrote {name}: {len(df):,} rows -> {os.path.basename(pq)} + .xlsx")


def savefig(fig, name: str) -> None:
    p = os.path.join(CHARTS, f"{name}.png")
    fig.savefig(p, dpi=130, bbox_inches="tight")
    print(f"  chart -> charts/{name}.png")


def minmax_0_100(s: pd.Series, invert: bool = False) -> pd.Series:
    """Min-max normalize a numeric series to 0-100. invert=True flips (higher raw -> lower score).

    NaNs are preserved (they carry no signal); a degenerate constant series maps to 50.
    """
    x = s.astype(float)
    lo, hi = np.nanmin(x.values), np.nanmax(x.values)
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        out = pd.Series(np.where(np.isnan(x.values), np.nan, 50.0), index=s.index)
        return out
    z = (x - lo) / (hi - lo) * 100.0
    if invert:
        z = 100.0 - z
    return z


def pctile_0_100(s: pd.Series, invert: bool = False) -> pd.Series:
    """Percentile-rank normalize to 0-100 (robust to skew/outliers). invert flips direction."""
    x = s.astype(float)
    r = x.rank(pct=True, na_option="keep") * 100.0
    if invert:
        r = 100.0 - r
    return r
