# Stop Accessibility Index — Best-Answers Brief

Headline findings from the Stop Accessibility Index (SAI) across all **13,621 NYC local-bus stops**.
Format: **claim · caveat · pointer**. Every number traces to a query in `analysis/sai/`; see `METHODS.md`.
Generated 2026-07-17.

---

### 1. Pedestrian access to the bus is sharply unequal across boroughs — Staten Island is the worst-served.
Median SAI by borough: **Manhattan 60.8 · Bronx 53.8 · Brooklyn 53.2 · Queens 47.6 · Staten Island 35.0**.
A typical Staten Island bus stop ranks in the bottom third of the city on pedestrian access; a typical Upper-Manhattan
stop in the top quarter.
· *Caveat:* SAI is a within-NYC percentile composite (citywide mean = 50 by construction), so these are relative
positions, not absolute accessibility. · *Pointer:* `sai_borough_summary.parquet`, `charts/02_sai_by_borough_box.png`,
`charts/05_sai_map_all_stops.png`.

### 2. Nearly three-quarters of NYC bus stops have no shelter.
Only **26.8% of stops (3,644) have a bus shelter within 100 ft**; **9,977 stops are unsheltered**. The gap is
worst in the outer boroughs: **Staten Island 13.7%** and **Queens 27.1%** sheltered vs **Manhattan 35.9%**.
· *Caveat:* shelter dataset is a planimetric snapshot (t4f2-8md7); recent installs/removals may lag. · *Pointer:*
`sai_scores.parquet` (`shelter_100ft`), `charts/04_amenity_coverage_borough.png`.

### 3. Select Bus Service stops are almost twice as likely to be sheltered as local stops.
**48.2% of SBS stops** have a shelter within 100 ft vs **25.7% of local stops** — the premium-branded routes
get the premium waiting environment. · *Caveat:* SBS stops are also disproportionately on dense trunk corridors,
which partly confounds the comparison. · *Pointer:* `charts/10_shelter_sbs_gap.png`.

### 4. Ramp coverage is near-universal; seating is not.
**94.5% of stops** have a pedestrian ramp within 150 ft (ADA curb access is broadly present), but only **33.2%**
have any bench/seating within 250 ft — and just **7.8% on Staten Island**. Comfort, not curb access, is the binding
amenity gap. · *Caveat:* ramp *presence* is scored, not ramp *compliance* (slope/condition not graded). · *Pointer:*
`sai_borough_summary.parquet`, `charts/04_amenity_coverage_borough.png`.

### 5. The worst-served stops are isolated stops in parks, stadiums, and the far urban edge.
Lowest-SAI stops cluster around Citi Field / Flushing Meadows (Seaver Way, Roosevelt Av/Shea), the Eltingville
SI transit center, and Soundview's ferry-edge Bx27 stops — high crash exposure and/or almost no walkshed population,
sidewalk, or shelter. The best-served are dense Upper-West-Side Manhattan stops (Broadway/Columbus Av, M4/M7/M11/M86-SBS)
with ~20-28k residents in the walkshed and frequent service. · *Caveat:* a few worst stops score low simply because
they serve near-empty land (6 residents in the walkshed) — low *need*, not only low *provision*. · *Pointer:*
`sai_worst50.parquet`, `sai_best50.parquet`, `charts/06_worst50_map.png`.

### 6. The weighting doesn't drive the story (robustness).
The default-weighted SAI and an equal-weight (1/7 each) SAI correlate at **Pearson r = 0.85**; the borough gradient
and best/worst tails hold under both. · *Caveat:* r = 0.85 leaves mid-table reordering, so individual mid-rank stops
are weighting-sensitive even though the aggregate pattern is not. · *Pointer:* `sai_weights.json`,
`charts/09_weight_sensitivity.png`.

---

## Municipal context (B5.3)

### 7. Pedestrian-crash exposure rises monotonically with DOT's own demand ranking.
On the segments DOT ranks highest for pedestrian demand (Rank 1), each averages **11.2 pedestrian-injury crashes
within 100 ft (2020+)**; the gradient falls cleanly to **6.4 (Rank 2) · 4.2 (3) · 2.3 (4) · 1.0 (Rank 5)**. The
places the city has already identified as most walked are precisely where pedestrians are most often hurt — a
prioritization-vs-safety gap. Worst individual corridors: **East Fordham Rd (330), Webster Av (288), E 125 St (210)**.
· *Caveat:* raw crash counts near a segment, not rate-adjusted for exposure/volume; longer/denser segments accrue more.
· *Pointer:* `ctx_pmi_crash_gradient.parquet`, `ctx_pmi_worst50_segments.parquet`, `charts/12_pmi_crash_gradient.png`.

### 8. Population density spans nearly 9x across boroughs.
**Manhattan 74,190 residents/sq mi** -> Brooklyn 39,431 -> Bronx 34,581 -> Queens 22,049 -> **Staten Island 8,512** —
the same gradient that drives the SAI walkshed-population subscore. · *Pointer:* `ctx_borough_pop_density.parquet`,
`charts/11_pop_density_gradient.png`.

### 9. Subway travel is overwhelmingly a Midtown-Downtown Manhattan story.
Top 2024 origin->destination station pairs are all Grand Central <-> Fulton St <-> Times Sq <-> Union Sq
(est. avg riders ~375k on the top Grand Central-Fulton St pair). · *Caveat:* `estimated_average_ridership` is MTA's
modeled O-D estimate, 2024 only. · *Pointer:* `ctx_subway_od_top100.parquet`, `ctx_subway_od_top100_8am.parquet`.

---

## The one-line headline
**NYC's bus network reaches most people, but the *quality* of that reach is deeply uneven: three-quarters of stops
lack shelter, Staten Island and Queens riders wait in the least walkable, least comfortable environments, and the
corridors the city knows are busiest with pedestrians are also where pedestrians are most often struck.**
