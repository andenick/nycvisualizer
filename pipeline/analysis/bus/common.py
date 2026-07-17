"""Shared helpers for the Jane NYC-Platform bus analysis suite (B5.2).

Connection to jane_geo.duckdb (read-only), borough-from-route-prefix SQL,
and standardized output writers (Parquet + ONE-sheet XLSX per file).
No fabricated numbers: every writer just serializes a DataFrame that came
from a real query.
"""
from __future__ import annotations
import os
import duckdb
import pandas as pd

_PIPELINE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # analysis/bus -> pipeline
DB = os.environ.get("JANE_GEO_DB", os.path.join(_PIPELINE, "db", "jane_geo.duckdb"))
OUT = os.environ.get("NYCV_OUTPUTS", os.path.join(_PIPELINE, "outputs", "bus"))
CHARTS = os.path.join(OUT, "charts")

os.makedirs(OUT, exist_ok=True)
os.makedirs(CHARTS, exist_ok=True)


def connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(DB, read_only=True)
    try:
        con.execute("LOAD spatial;")
    except Exception:
        pass
    # generous but bounded memory; giants are external parquet scans
    con.execute("PRAGMA threads=8;")
    return con


# Borough from MTA bus route short-name prefix. Longest prefixes first.
# Express prefixes (BM/BXM/QM/SIM/X) attributed to their home borough.
BOROUGH_CASE = """
CASE
  WHEN regexp_matches(upper({col}), '^SIM') THEN 'Staten Island'
  WHEN regexp_matches(upper({col}), '^BXM') THEN 'Bronx'
  WHEN regexp_matches(upper({col}), '^QM')  THEN 'Queens'
  WHEN regexp_matches(upper({col}), '^BM')  THEN 'Brooklyn'
  WHEN regexp_matches(upper({col}), '^BX')  THEN 'Bronx'
  WHEN regexp_matches(upper({col}), '^M[0-9]') OR regexp_matches(upper({col}), '^X[0-9]') THEN 'Manhattan'
  WHEN regexp_matches(upper({col}), '^B[0-9]') THEN 'Brooklyn'
  WHEN regexp_matches(upper({col}), '^Q[0-9]') THEN 'Queens'
  WHEN regexp_matches(upper({col}), '^S[0-9]') THEN 'Staten Island'
  ELSE 'Other/MTA Bus Co.'
END
"""


def borough_expr(col: str) -> str:
    return BOROUGH_CASE.format(col=col)


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
