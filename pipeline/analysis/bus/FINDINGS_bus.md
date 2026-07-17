# Bus Service & Ridership — Best-Answers Brief (Jane NYC-Platform, B5.2)

Flagship #1. Each claim carries a caveat and a pointer to the exact output/query.
All figures trace to a query on `jane_geo.duckdb`; nothing is fabricated.

> **Two standing data flags** (apply to every claim below):
> **(A) Bus APC ridership is ROUTE-LEVEL only** — `transit_ridership_bus_hourly` has no stop/direction
> column, so all *demand* is per route (genuine stop-level data exists only on the GTFS *supply* side).
> **(B) Realtime headway/bunching/adherence (Claim 8) are PRELIMINARY** — computed over only ~1.9 h of
> live archive; they strengthen as the poller accumulates. See `04_archive_stamp.txt`.

---

**1. Queens is the ridership heavyweight; five routes each cleared ~30M lifetime boardings.**
Of 2.4B route-hours of boardings (2020-01→2026-07), Queens routes carry 34.4%, Brooklyn 24.9%,
Manhattan 19.8%, Bronx 15.9%, Staten Island 5.0%. The busiest single routes are **M15+ (38.2M), Q58
(36.0M), B6 (34.0M), Q44+ (27.5M), Bx12+ (27.5M)**.
*Caveat:* borough is derived from route-name prefix (express routes → home borough); lifetime totals
mix pandemic-suppressed 2020 with recovery years. *Pointer:* `01_borough_aggregates`, `01_route_top25_boardings`.

**2. Bus ridership fully recovered and set a post-2020 high in 2025 — 176% of 2020.**
Annual boardings rose 234M (2020) → 412M (2025), an index of 176 vs 2020; 2026 is partial (to Jul 7).
*Caveat:* 2020 is a pandemic-depressed base, not a pre-COVID benchmark; the dataset starts 2020 so no
true pre-pandemic comparison is available here (use `transit_daily_ridership`'s pre-pandemic-% for that).
*Pointer:* `01_recovery_yearly`, `01_recovery_monthly`, chart `01_recovery_monthly.png`.

**3. OMNY has all but replaced MetroCard on buses — 1.1% of boardings in 2020, 98.6% in 2026.**
OMNY share by year: 2020 1.1% → 2022 20.3% → 2024 40.8% → 2025 71.7% → 2026 98.6%. "OMNY - Full Fare"
is now the single largest fare class (29.8% of all lifetime boardings).
*Caveat:* fare-class labels are the agency's; "Fair Fare"/student/senior categories are small but policy-relevant.
*Pointer:* `01_fare_payment_by_year`, `01_fare_class_mix`, chart `01_fare_mix.png`.

**4. Demand is sharply double-peaked; the 7–8 AM hour is the system's busiest.**
Weekday boardings peak at 07:00 (182M lifetime in that hour) and 08:00 (166M), with a broad PM peak at
16:00–17:00. Weekend demand is a flat midday hump roughly a fifth of weekday peak.
*Caveat:* hour is boarding timestamp, route-aggregated. *Pointer:* `01_hourly_profile_system`, chart `01_hourly_profile.png`.

**5. NYC buses crawl — Manhattan crosstown/Lexington corridors are the slowest in the city.**
Trip-weighted weekday-peak speeds: the 20 slowest **segments** are all ~2.7–3.5 mph on Lexington Ave
(M101/M103) and Queens Blvd/Main St; the slowest **routes** are **M57 (4.6), M42 (4.7), M31 (4.8),
M125 (4.8) mph**. Boroughwide weekday means: Manhattan 6.2, Brooklyn 7.3, Bronx 7.6, Queens 8.8,
Staten Island 12.6 mph.
*Caveat:* speeds are MTA timepoint-segment averages (2023-2026); layover/terminal artifacts filtered out.
*Pointer:* `02_slowest_segments_peak`, `02_route_peak_speed`, `02_speed_by_borough_hour`, charts `02_*`.

**6. ACE camera enforcement shows NO clean average speed gain at this resolution (23 routes faster / 27 slower, mean ≈ 0.0 mph).**
Across 50 ACE routes with valid ±120-day windows, the descriptive pre/post trip-weighted peak-speed
change averaged **−0.01 mph** (best Bx12+ +0.62; worst Bx20 −0.36).
*Caveat — read carefully:* this is **descriptive, heavily confounded, and NOT causal** (seasonality,
COVID recovery, concurrent redesigns; ACE targets blocked-lane delay, not through-speed). Interpret as
"no clean speed signal at crude segment resolution," not "enforcement is ineffective." A proper
difference-in-differences vs matched control routes is the right follow-up.
*Pointer:* `02_ace_before_after`, chart `02_ace_before_after.png`.

**7. Supply vs demand flags the crowding pressure points: M15-SBS, M11, Q25, B1, Q44-SBS carry the most riders per scheduled trip.**
On a representative weekday (54,273 scheduled trips), boardings-per-trip is highest on **M15-SBS (56.4),
M11 (46.0), Q25 (45.8), B1 (44.6), Q44-SBS (44.1)** — the "under-served / most-crowded" tail. Systemwide
scheduled supply peaks at 08:00 (4,087 trip starts); median AM-peak scheduled headway is ~11 min.
*Caveat:* demand is route-level APC, supply is GTFS scheduled (not delivered); local+SBS corridors are
combined for the join, so branded-route load is slightly diluted. *Pointer:* `03_most_crowded_routes`,
`03_demand_vs_supply`, `03_scheduled_headways_by_period`, chart `03_most_crowded.png`.

**8. [PRELIMINARY] Early-AM observed headways track the schedule on the median but bunching is already visible.**
Over ~1.9 h of live archive (2026-07-17 05:51–07:43 ET, AM-peak edge; 341 routes, 117.6k passages), the
median route's observed headway missed schedule by just **+0.8 min**, but the median bunching CV was
**0.70** with the worst routes (Q49, Q111, BxM7, Q43, B6) at CV > 1.0 — i.e. highly irregular spacing.
*Caveat:* **~2 hours of data — illustrative only, not a stable reliability finding.** Passages are
approximated from `stop_id` transitions (leads true arrival). Re-run `04_realtime_headways.py` as the
archive deepens. *Pointer:* `04_observed_headways_route`, `04_adherence_vs_scheduled`, `04_archive_stamp.txt`,
chart `04_bunching_index.png`.

---

### Suggested headline for the site
"New York's buses carry 2.4 billion rides that move at a jogger's pace — and OMNY just quietly finished
off the MetroCard." (Claims 1–3, 5.)
