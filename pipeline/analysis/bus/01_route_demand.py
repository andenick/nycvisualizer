"""01 - Route-level bus DEMAND from transit_ridership_bus_hourly (APC).

Source: transit_ridership_bus_hourly  (Socrata kv7t-n8in 2020-24 + gxb3-akrn 2025+)
Grain : bus_route x payment_method x fare_class_category x hour.  583.8M rows.

DATA FLAG: this dataset is ROUTE-LEVEL only. It has NO stop and NO direction
column (the master plan's "stop-level boardings" claim does not match the data;
the honest unit is the route). All demand here is per route.

Outputs (Parquet + one-sheet XLSX each) under Outputs/NYCPlatform/bus/ +
headline PNGs under charts/.
"""
from __future__ import annotations
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
from common import connect, borough_expr, write_table, savefig

con = connect()
print("[01] route-level demand from transit_ridership_bus_hourly (583.8M rows)")

bor = borough_expr("bus_route")

# --- 1. Total boardings per route (full history) -> top/bottom league tables ---
route_tot = con.execute(f"""
    SELECT bus_route AS route,
           {bor} AS borough,
           SUM(ridership)  AS total_boardings,
           SUM(transfers)  AS total_transfers,
           MIN(transit_timestamp)::DATE AS first_date,
           MAX(transit_timestamp)::DATE AS last_date
    FROM transit_ridership_bus_hourly
    GROUP BY 1,2
    ORDER BY total_boardings DESC
""").df()
write_table(route_tot, "01_route_total_boardings", "route_totals")
top25 = route_tot.head(25).copy()
bot25 = route_tot[route_tot.total_boardings > 0].tail(25).copy()
write_table(top25, "01_route_top25_boardings", "top25")
write_table(bot25, "01_route_bottom25_boardings", "bottom25")

# --- 2. Weekday hourly demand profile (system + per borough) ---
hourly = con.execute(f"""
    WITH d AS (
      SELECT hour(transit_timestamp) AS hod,
             {bor} AS borough,
             isodow(transit_timestamp) AS dow,
             ridership
      FROM transit_ridership_bus_hourly
    )
    SELECT hod,
           SUM(CASE WHEN dow<=5 THEN ridership END) AS weekday_boardings,
           SUM(CASE WHEN dow>=6 THEN ridership END) AS weekend_boardings
    FROM d GROUP BY hod ORDER BY hod
""").df()
write_table(hourly, "01_hourly_profile_system", "hourly_system")

hourly_bor = con.execute(f"""
    SELECT hour(transit_timestamp) AS hod, {bor} AS borough,
           SUM(ridership) AS boardings
    FROM transit_ridership_bus_hourly
    WHERE isodow(transit_timestamp) <= 5
    GROUP BY 1,2 ORDER BY 1,2
""").df()
write_table(hourly_bor, "01_hourly_profile_borough_weekday", "hourly_borough")

# --- 3. Recovery trend 2020 -> 2026 (yearly + monthly) ---
yearly = con.execute("""
    SELECT year(transit_timestamp) AS yr, SUM(ridership) AS boardings
    FROM transit_ridership_bus_hourly GROUP BY 1 ORDER BY 1
""").df()
yearly["yoy_pct"] = (yearly["boardings"].pct_change() * 100).round(1)
base = yearly.loc[yearly.yr == 2020, "boardings"]
if len(base):
    yearly["index_vs_2020"] = (yearly["boardings"] / base.iloc[0] * 100).round(1)
write_table(yearly, "01_recovery_yearly", "yearly")

monthly = con.execute("""
    SELECT date_trunc('month', transit_timestamp)::DATE AS month,
           SUM(ridership) AS boardings
    FROM transit_ridership_bus_hourly GROUP BY 1 ORDER BY 1
""").df()
write_table(monthly, "01_recovery_monthly", "monthly")

# --- 4. Borough aggregates (full history) ---
borough = con.execute(f"""
    SELECT {bor} AS borough,
           COUNT(DISTINCT bus_route) AS n_routes,
           SUM(ridership) AS total_boardings
    FROM transit_ridership_bus_hourly GROUP BY 1 ORDER BY total_boardings DESC
""").df()
write_table(borough, "01_borough_aggregates", "borough")

# --- 5. Fare-type mix: OMNY vs MetroCard adoption over time + fare class ---
fare_year = con.execute("""
    SELECT year(transit_timestamp) AS yr, payment_method,
           SUM(ridership) AS boardings
    FROM transit_ridership_bus_hourly GROUP BY 1,2 ORDER BY 1,2
""").df()
write_table(fare_year, "01_fare_payment_by_year", "payment_by_year")

fare_class = con.execute("""
    SELECT fare_class_category, SUM(ridership) AS boardings
    FROM transit_ridership_bus_hourly GROUP BY 1 ORDER BY 2 DESC
""").df()
fare_class["share_pct"] = (fare_class.boardings / fare_class.boardings.sum() * 100).round(2)
write_table(fare_class, "01_fare_class_mix", "fare_class")

# ---------------- charts ----------------
fig, ax = plt.subplots(figsize=(9, 5))
ax.bar(hourly.hod, hourly.weekday_boardings / 1e6, color="#2166ac", label="Weekday")
ax.set_xlabel("Hour of day"); ax.set_ylabel("Total boardings (millions, 2020-2026)")
ax.set_title("NYC bus demand by hour of day (weekday, full history)")
ax.set_xticks(range(0, 24, 2)); ax.legend()
savefig(fig, "01_hourly_profile"); plt.close(fig)

fig, ax = plt.subplots(figsize=(9, 5))
ax.plot(monthly.month, monthly.boardings / 1e6, color="#b2182b")
ax.set_xlabel("Month"); ax.set_ylabel("Boardings (millions)")
ax.set_title("NYC bus ridership recovery, monthly (2020-2026, 2026 partial to Jul 7)")
ax.grid(alpha=.3)
savefig(fig, "01_recovery_monthly"); plt.close(fig)

fig, ax = plt.subplots(figsize=(9, 6))
t = top25.iloc[::-1]
ax.barh(t.route, t.total_boardings / 1e6, color="#1a9850")
ax.set_xlabel("Total boardings (millions, 2020-2026)")
ax.set_title("Top 25 NYC bus routes by total boardings")
savefig(fig, "01_top25_routes"); plt.close(fig)

fig, ax = plt.subplots(figsize=(9, 5))
piv = fare_year.pivot(index="yr", columns="payment_method", values="boardings").fillna(0)
piv_sh = piv.div(piv.sum(axis=1), axis=0) * 100
ax.stackplot(piv_sh.index, [piv_sh[c] for c in piv_sh.columns], labels=list(piv_sh.columns),
             colors=["#4393c3", "#f4a582"])
ax.set_xlabel("Year"); ax.set_ylabel("Share of boardings (%)")
ax.set_title("Fare-payment mix: OMNY vs MetroCard adoption"); ax.legend(loc="center left")
savefig(fig, "01_fare_mix"); plt.close(fig)

print("[01] done.")
