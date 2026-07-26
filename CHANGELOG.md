# Changelog

All notable changes to nycvisualizer are recorded here.

> **Redaction note (2026-07-25).** Historical entries below were redacted for
> publication hygiene: internal research-archive identifiers (an internal corpus name
> and per-document ids) were replaced with plain descriptions of the same sources.
> **No factual content changed** — no date, version, number, or claim about what
> shipped was altered, and nothing was removed from the record. The identifiers
> resolved only inside our own workspace and are never offered publicly
> (`CODE_DATA_FIRST_STANDARD` §4.2); where a redacted entry cited real published
> work, that citation (e.g. NBER w33584, arXiv:2606.17530) is unchanged and remains
> the reader's referent.

## 2026-07-25 — Distance along the bus route · the phone breakpoint that was a device · house numbers become opt-in

Three things, one deploy. Stage 2 of the measure feature plus two defects a user hit in
real use the same day.

### Distance along the route (`/api/stops/along`, `/api/stops/card`)

The measure readout now answers a second question, and it is the one Google structurally
cannot: **how far the bus actually travels between two stops**, as opposed to how far
apart they are. On a real Bx12 pair those differ by 11 % — 2,850 ft straight line against
3,170 ft along the route — and for a planner the second number is the one that matters.

Nothing is estimated. `stop_offsets` already carries, for every (shape, stop), the
cumulative distance of that stop from the start of the shape in EPSG:2263 US survey feet;
the answer is a subtraction of two floats. 36,895 rows, covering **683 of the 683**
canonical (route, direction) shapes with no gaps.

The label **names the route and the direction** — *"Along the Bx12, toward Orchard
Beach"* — because "along the route" in the abstract is meaningless. And three rules are
enforced in code rather than left to care:

- **Per direction, always; never averaged across directions.** Service is not symmetric
  and a mean of the two describes no bus.
- **A headline only when one route and direction carries a bus across every leg**, in the
  direction the stops were picked. A chain that changes route gets no along-route total,
  because summing two routes' offsets is a distance nothing travels — it says so instead.
- **Picked against the direction of travel?** It says that too, and offers the figure the
  other way rather than silently flipping the sign.

The **stop card** now fills in from the same request-on-click endpoint: per route and
direction, the observed and scheduled gap, bunching, the worst hour, the stop's sequence
number, and the spacing to the stops before and after it; plus the stop's accessibility
index, shelter, curb ramps, sidewalk area, and the people and jobs within 400 m. Every
field we do not hold reads **`not captured` with the reason** — the NYC bus feeds publish
no `stop_code` (the id shown *is* the code riders text), no `wheelchair_boarding`, and no
stop-level ridership. The "worst hour" callout will not name an hour backed by fewer than
20 observed gaps; a 2 a.m. cell with three of them is noise wearing the clothes of a
finding.

Both endpoints are fetched **on click, never eagerly** — one request per newly-opened
card, one per selection change — and cached. 57 selected routes is thousands of stops, and
a fan-out over all of them is a defect this page has had once already.

### The mobile breakpoint was a device, not a breakpoint

Reported by a user on their phone. The Workstation's bottom-sheet layout was gated at
`max-width: 390px` — the CSS width of an iPhone 12/13/14 and of nothing else. An iPhone
14/15/16 Pro is 393. A Pixel 7 is 412. A Pro Max is 430. Every one of them fell through to
the **desktop** layout: a 300x766 px panel floating over the map, overlapping the data
rail by ~43,600 px², with "Selection data" rendering transparently on top of "Routes &
lines" and the map reduced to about 18 % of the screen.

Measured on the live site, before: at 390 the panel is 52 % of the viewport with one
trivial 92x25 px overlap; at 393 it is **90 %** with **four** overlapping pairs and
~101,000 px² of occlusion. After: 393, 412, 430 and 768 all engage the sheet, occlusion
drops to the same 3,835 px² of pre-existing corner furniture, and 834 and 1440 are
unchanged. The layout was already proven good at 390 — this extends it to a real
phone/small-tablet bound rather than inventing one.

This is a hotfix, not the mobile redesign. Even where the layout now engages correctly,
chrome still covers about 87 % of a phone screen and most controls are under the 40 px tap
minimum. That is honest and it is separate work.

### House numbers are now off by default

Reported the day after they shipped: *"when you zoom in too much the screen is too crowded
with all the numbers on each building. I don't want that information on the map."*

The description is exact. About 45 % of NYC building features carry `addr_housenumber`, so
a Park Slope block at z18 draws hundreds of them and the street names underneath are
nearly buried. They are now behind a **legend toggle, default off**, remembered like the
other map preferences — on every map surface, since they all share one basemap module.

Raising the zoom gate to z18 or z19 was considered and rejected: it moves the same wall one
zoom level deeper and the reader hits it on the next scroll.

(The report said "census tract numbers". A repo-wide search found **no** census-tract or
GEOID label rule on any layer — there is nothing else on these maps that draws a number on
a building, so the house numbers were the whole of it.)

**Street *names* are untouched** and still render at every zoom; they come from a different
layer.

**What the original verification missed, recorded because the lesson generalises:** the
house numbers were checked as *"do they render?"* — and they did, correctly, at every zoom
tested. The check nobody ran was **aggregate legibility**: not "does the label draw" but
"is the map still readable once they all draw." The basemap canary now asserts both the
data contract (the tiles must keep carrying the numbers, or the toggle would switch on an
empty layer) **and** the shipped default (that the gate requires an opt-in), 15 checks to
16. Deleting the first would have stopped protecting the layer underneath; keeping only the
first would have let the default silently flip back.

## 2026-07-25 — Workstation: stop cards you can keep, and a measure tool that snaps to stops

Stage 1 of the measure feature. Client-only: no API change, no container but
`nycvisualizer-web` touched.

### The stop card

Clicking a stop dot on the Planner Workstation now opens a **card that stays up**. Click
another and you get a second one; click a card's stop again (or its ✕) and it closes. The
selection is capped at **10, oldest evicted, with the count always on screen** — an
unbounded, accumulating panel is the exact failure mode the 2026-07-25 freeze fix removed,
and this feature does not get to reintroduce it.

**The stop code is the headline** — large, monospaced, and copyable, because it is the
number a planner reads off a pole and carries into a meeting. The card also names the stop,
lists every selected route serving it, and shows the surveyed coordinate to six decimals.
Fields we do not hold read **`not captured`**, never a blank and never a zero: the six NYC
bus GTFS feeds publish no `stop_code` and no `wheelchair_boarding` column, and saying so is
more useful than leaving a gap.

The per-marker Leaflet popup that used to answer a stop click is **gone**. The card holds
strictly more, it persists so several stops can be compared, and it is what the measure
tool measures over — two competing answers to one click was the worse design.

### Measure distance

Measurement is a **mode of the stop card**, not a separate tool: the path is the selection,
in click order. Two doors — a visible **`⟷ Measure`** button and **right-click → "Measure
distance from here"** — because the desktop convention has no touch equivalent to copy, and
right-click is undiscoverable to a non-technical reader. The context menu **leads with what
you clicked** (the stop's name, code and routes) before offering any verb, and it is
**mode-sensitive**: while measuring it offers *Measure to here · Undo last stop · Clear
measurement*.

- **Arming the tool emphasises every stop on screen**, so the map says what it can snap to
  before the first click.
- **The readout docks and never grows.** It is the same size at 2 stops and at 10; the
  incremental numbers live on the geometry, as a graduated tape with `0` at the origin and
  cumulative + per-leg distances at each vertex.
- **Click a stop again to remove it**, and the chain re-stitches across the gap. **Ctrl+Z**,
  **Backspace** and **Delete** undo the last stop; an **↺ Undo** button does the same for
  touch. **Escape** leaves the mode and **keeps your stops and your number** — committing
  must never destroy the answer.
- **There is no finish gesture**, deliberately: `dblclick` is already the map's zoom.
- **Both units at once, no toggle**: feet primary, miles in parentheses.

### The numbers, and how honest they are

Distances are **geodesic** — a local-radius WGS84 reduction, exact to far better than a
foot at this scale. A Web-Mercator *pixel* distance would be wrong by about 30 % at New
York's latitude, which is a correctness bug rather than a rounding question.

They are measured **between surveyed stop positions and never from live bus locations**.
Stop coordinates are uniformly six decimal places — about 0.3–0.4 ft — against a
~160–200 ft positional floor on live vehicle tracking, so this is one of the few numbers on
this site that is genuinely exact, and the page says so. Results are **rounded to the
nearest 10 ft**: the geometry is better than that, but a stop coordinate is one surveyed
point standing for a ~40 ft kerbside zone, and finer precision would be false.

Distance **along the bus route** and **walking distance** are named in the readout and
currently say they are not measured, rather than letting the straight line quietly stand in
for either. Snapping is to bus stops and subway stations only — free map points are not
offered, because a distance between two sidewalk pixels is not a fact about the network.

### Bus direction arrows

A legend toggle draws each bus as an **arrow pointing the way it is travelling**, slightly
larger than the marker it replaces and keeping its route colour. The heading comes from the
**route-shape tangent** the motion engine already computes for positioning — smooth, and
always consistent with the path the bus is drawn on. (The feed's own `bearing` field was
checked and is 100 % populated, 2,208 of 2,208 live vehicles; the tangent is a quality
choice, not a coverage workaround.) A bus that is dwelling at a stop, or whose heading is
unknown, **keeps the plain marker** rather than pointing somewhere arbitrary. The choice is
remembered with the other map preferences.

### Cost

The freeze that was fixed earlier today stays fixed, and this feature was built to the same
rules and measured against the same reproduction (57 Bronx routes, Bronx z14, 4× CPU
throttle, ten drag-pan gestures, three runs each):

| | pan median | frame P50 | frame P95 | frames over 33 ms |
|---|---|---|---|---|
| before this change | 539 ms | 16.7 ms | 33.4 ms | 5.7 % |
| after, nothing selected | 517 ms | 16.7 ms | 33.3 ms | 4.7 % |
| after, four stop cards open | 574 ms | 16.7 ms | 33.3 ms | 5.1 % |
| after, measuring | 535 ms | 16.7 ms | 33.4 ms | 6.2 % |
| after, arrows on | 543 ms | 16.7 ms | 33.3 ms | 4.6 % |

60 fps stays locked at every route count, and the arrows are free to within measurement
noise. The whole feature binds **three** map-level listeners and **zero** per-stop
listeners; the snap index is built once per selection change (1,985 distinct stops in
1.5–4.9 ms, from data already in the browser) and queried in O(1); the measure path is at
most `2 × points + 1` elements in its own pane; and it never triggers a stop redraw.
Emphasising the stops when the tool arms is a single restyle pass — 3,098 markers in
6–10 ms, twice per measure session.

## 2026-07-25 — API: honest alert severity, real subway train identity, a depth gate that counts qualifying days, and auto-stats

The backend half of the 2026-07-25 work, deployed together (one API image rebuild).

### Publication hygiene (visitor-facing)

- `/api/downloads` no longer ships an internal research-archive identifier in the
  Hub-Bound Parquet note. The reader's provenance is the published report series:
  *NYMTC Hub Bound Travel Report*. This string was rendered on the public Data page.
- The realtime poller's outbound `User-Agent` carried a **personal email address** —
  published in this repository and transmitted to the feed host on every fetch. It now
  points at this repository: the same courtesy signal to MTA, without the PII.
- `OTP_URL` **lost its built-in default**. The routing engine is deployment-specific
  infrastructure, so its address comes from the environment and nowhere else; the
  hostname and private network name are gone from the source. This is a **functional**
  change: with `OTP_URL` unset, `/api/isochrone` returns an honest 503 naming the missing
  variable instead of resolving a guessed internal hostname. It has never faked a polygon
  and still does not.

### Service alerts are classified by MTA's own taxonomy, not by a field MTA never sets

GTFS-RT `effect` is a proto2 default on these feeds — every alert decodes as
`UNKNOWN_EFFECT`, so the previous severity table classified **100% of alerts "low"**
(417/417 on the live feed). MTA's real classification rides in the Mercury `alert_type`
extension, which the stock bindings cannot see.

- New `pipeline/realtime/gtfs_ext.py` decodes the NYCT, Mercury and OneBusAway vendor
  extensions straight from the wire, with the three `.proto` files vendored under
  `pipeline/realtime/proto/` as the normative reference (no codegen step). Every decode is
  fault-isolated: a changed extension yields `None`, never an exception.
- `/api/wall` now tiers alerts by `alert_type`, and an alert with nothing on the wire is
  **"unclassified"** — never "low". Measured live at deploy: 71 high / 251 medium /
  20 low / 76 unclassified, `severity_basis: mercury_alert_type`. The 76 are the bus feed,
  which genuinely carries no Mercury extension; that is reported, not guessed at.
- `/api/rt/alerts` gains `description_text` (the "What's happening?" copy and the
  suggested alternative), `active_period`, `active_now`, `alert_type`, `created_at`,
  `updated_at`, `count`, `stale` and a `severity_note` stating what MTA does and does not
  publish.

### Subway trains have an identity again

Subway `vehicle_id` is 100% NULL on these feeds, so a train could not be followed across
trip-id changes. The NYCT `TripDescriptor` extension supplies `train_id`, and
`/api/rt/subway` now carries it (238/238 non-null at deploy) alongside `nyct_direction`,
`is_assigned`, `current_stop_seq`, and `header_ts` + `obs_age_s` — MTA's own publication
time versus when the train was observed, which is not a formality on a feed whose p90 gap
is over nine hours. Rows archived before this change return `null`; nothing is substituted.

### The archive depth gate counts qualifying service days

`archive_depth_days` was a bare count of `date=` partition directories, and a partition is
written for any day with a single observed arrival — so a two-hour day and a
twenty-four-hour day counted the same. A day now qualifies only if its own per-hour
data-quality report shows enough usable hours on the feed the derivation actually reads.
Live at deploy: **6 qualifying days of 9 partitions** (2026-07-17 begins mid-morning;
2026-07-21 lost the day to the disk guard, 1 usable hour; today is in progress), each
exclusion published with its reason and row counts under `archive.excluded_dates`.
`partition_days` keeps the raw count visible. Rankings stay locked until 14 qualifying
days — unchanged, and now honestly measured.

### New: `/api/autostats/*`

Six read-only endpoints that answer a planner's question in words rather than a chart:
`/completeness` (which days and hours are partial, missing, a known gap or in progress,
plus an equivalent-complete-days number), `/route/{id}/today`, `/profile`, `/boroughs`,
`/route/{id}/slowspots`, `/ladder`. Every payload carries the same `archive` honesty block
and a coverage stamp; a thin sample is reported as thin, never smoothed over.

### Internals

- `config.REALTIME_PKG_DIR` resolves the directory the API imports `gtfs_ext` from. The
  development tree and the container image put the pipeline in different places, and the
  three import sites fault-isolate to all-`None` extension fields — so a wrong path would
  have degraded **silently** in production, classifying every alert "unclassified" and
  nulling every `train_id`, with no error anywhere. It is resolved explicitly and
  overridable with `NYCV_REALTIME_DIR`.
- The archive readers project newly-written optional columns (`header_ts`,
  `occupancy_status`, `passenger_count`, `passenger_capacity`, `train_id`,
  `is_assigned`, `nyct_direction`) only when the scanned files actually carry them, so
  older Parquet files still read.

## 2026-07-25 — Publication hygiene: the Methodology tabs stop leaking the build environment

A visitor who clicked a **Methodology** tab was shown our build environment. The
pre-rendered methodology pages are generated by `site/tools/build_content.py` from the
pipeline's own working markdown — documents written for us — and that markdown carried a
literal Windows interpreter path, absolute workspace output paths, the internal container
and docker-network names of the routing engine, and internal research-archive document
ids. `chartdata.json` carried archive ids in a chart's source line; `kb_callouts.json`
shipped twelve of them in the JS bundle and into a `title=` attribute.

### Fixed at the source, never in the generated HTML

The generated HTML is rewritten on every content build, so a patch there is silently
reverted. Every fix went into the source document:

- Interpreter paths **removed** (`python <script>.py`). A reader does not need to know
  which interpreter we run.
- Absolute workspace paths → the **public repository layout**
  (`pipeline/analysis/<spoke>/`), or the **dataset's public name** where the path was
  really naming a dataset. Each methodology page now links the repository directly.
- Every run-order step gained a **plain-language description of what it does**, so the
  script names read as reproduction instructions rather than internal codenames.
- Citations keep their **real public identifiers** (NBER w33584, arXiv:2606.17530) and
  years; only the internal archive ids are gone.
- The routing-engine page keeps **every routing fact** — OTP 2.5.0, the sandbox isochrone
  endpoint, graph inputs, walk speed, the 503 honesty contract — but describes the host as
  a private, internal-only service rather than naming the container, network and hardware.
- "From the archive" callouts still name their **published source and year**; the internal
  id that used to ride along is stripped by the generator and has nowhere to render.

**No methodological content was lost** — heading counts are identical on all seven
methodology pages.

### A gate, so it cannot come back

`site/tools/hygiene.py` is a self-contained scrub gate (standard library only, so it runs
for an outside cloner): drive-letter and workspace paths, knowledge-base artefact paths and
chunk-marker residue, extraction batch ids, archive document ids, private IP addresses,
operator accounts and deploy-host paths. `build_content.py` checks every artefact against
it **before writing**, then re-checks the whole content directory, and **exits non-zero** on
any hit — a leak cannot be built, let alone deployed. It also runs standalone over a built
tree (`python site/tools/hygiene.py site/frontend/dist`).

Proven with three negative controls (an interpreter path in a source doc; a workspace path,
which also proved the poisoned HTML never reaches disk; and a document id hand-edited back
into the curated JSON, caught by the whole-directory pass) plus a 33-case pattern self-test
that confirms no false positive on `https://` URLs, EPSG codes, clock times or minified
JavaScript regex literals.

tsc/vite clean · vitest 65/65 · rule_canary 15/15 · cvd_check 19/19 · paint_canary 12/12
against live · live bundle re-fetched after deploy with zero hits.

## 2026-07-25 — W1/W5/W7: maps first, data in the Data tab, planner-first language

The information-architecture flip. Nothing was deleted; the front door was reordered for
the audience the site now names as primary — the **non-technical city planner**
(SITE_SPEC v1.5).

### W1 — the home page leads with the live map

- `/` is now the **live ant farm as a full-bleed hero**, then four entry buttons
  (Open the full map · Subway · Planner Workstation · Ops Wall), then **three doors in plain
  language** (Watch the city move / Look up a route / Explore a place), a two-sentence
  "what this is", and a small-print line to data · methodology · code · about.
- The hero is the **existing renderer, embedded** — `components/LiveHero.tsx` mounts the same
  `VehicleFlowLayer` (→ `src/flow/` FlowEngine) that `/bus`, `/live/*` and `/workstation`
  mount, on the same basemap, from the same `/api/rt/vehicles` snapshot + SSE stream, in the
  same borough palette. No second engine, no screenshot.
- **Weight discipline**, measured before and after on the live edge at 1440×900:
  the hero is `React.lazy`'d, so the landing's entry JS got *smaller*
  (198.5 KB → 184.2 KB decoded; 69.6 KB → 63.0 KB transferred) and first paint got *faster*
  (FCP 616 ms → 392 ms; longest long-task 197 ms → 57 ms; DOMContentLoaded 245 ms → 293 ms).
  Total page weight rose 102 KB → 972 KB transferred, essentially all of it the map itself:
  the 288 KB basemap chunk (88 KB gzipped), ~708 KB of pmtiles range requests for the
  citywide z11 view, and a 48 KB vehicle snapshot — all of which a visitor who opens any map
  pays once and then has cached.
  **Hero frame cost: 0.24 ms/frame at 60 fps with 777 buses on screen** (the flow engine's
  own EMA, read via `?perf`). rAF interval median 16.7 ms / p95 16.7 ms — identical to the
  no-hero baseline. No jank.
- Three scroll/zoom traps avoided by construction: wheel-zoom is off, **drag is disabled on
  touch** (a one-finger drag on a full-width hero would otherwise strand a phone visitor),
  and an `IntersectionObserver` **removes the flow layer when the hero scrolls out of view**,
  which unmounts the engine and cancels its rAF.
- `prefers-reduced-motion: reduce` is honoured: the animated glide is not started at all; the
  hero draws last-reported positions as plain markers and the stamp says so.
- **Nav 6 items → 4**: `Maps · Observatory · Ops Wall · Data`. Methodology folds under Data
  (`/methodology` and `/code` light the Data item); About moved to the footer.
- 🔴 **Fixed a 404 that was one of three above-the-fold buttons.** The Research Triad's
  "Explore the Outputs" pointed at **`/explore`, which was never a route** — it existed only
  as `outputs.href` in `ecosystem.json` with no matching `path`, so it fell through to
  NotFound. Outputs now points at `/maps`, and `/explore` redirects there so any already
  shared link keeps working.

### W5 — data and code moved to the Data tab

Moved, not deleted. `/data` is one click from primary nav and now opens with the triad.

- Landing `ArkTriad` → **`/data`**, directly under the title, above the fold.
- The **second** `ArkTriad` on `/about` → deleted (one site, one hero triad).
- `<h2>Downloads</h2>` + `DownloadRow` on the **map page** `/sidewalks` → `/data`; the literal
  internal string **"(Carson DNA D-4)"** that was shipping to visitors → deleted (also on
  `/data`, along with the workstream codes **"(S4 …)"** and **"(S7)"**).
- "JSON feed" + "RSS" on `/observatory/changes` were **above the fold**, before the reader had
  seen a single change → moved into a fold at the foot. RSS stays a link; the JSON feed is
  shown as a **path, not an `<a href>`**, because the no-JSON rule / D13 check (f) treats a
  `.json` href as a data offering and the carve-out for syndication feeds is still an open
  decision. No capability is lost, and the gate is not quietly broken while it is pending.
- The landing's Plotly chart (OMNY vs MetroCard) moved to **`/observatory`**, where a bus
  ridership chart belongs. Its source line shipped two raw Socrata dataset IDs and the
  internal analysis codename `01_route_demand`; the visible line now names the source in
  words and points at the Data catalogue for the IDs.
- The badge-taxonomy explainer moved from the landing page to **`/methodology`** — it taught a
  vocabulary to a visitor who had not yet seen a badge.
- Footer badges **"Reproducible · Offline · Real data"** → three provenance facts a planner
  can act on: *Live feeds refresh every 30 s · Derived figures published daily, 04:30 ET ·
  Real data only — nothing simulated*. ("Offline" read as *the site is offline*.)
- Public frame-time telemetry (`12.3 ms/frame (tick-jump)`, fps, prediction error) on `/bus`,
  `/live/*` and `/workstation` → **gated behind `?perf` / dev builds** (`lib/devFlags.ts`).
  The perf harness passes `?perf`, so it still measures.
- **Kept**: the per-chart Download CSV (`ArkPlotly`) — that is the Universal Graph Contract.

#### Governance: the gate was amended, not bypassed

Demoting the triad breaks **D13** (`CODE_DATA_FIRST_STANDARD.md` §1.1 mandates the triad above
the fold on `/`). Per the user's ratification the standard was amended to **v1.1** with a new
**`tool-first` exception class (§9.1)**: sites whose product *is* an interactive tool with a
non-technical audience relocate the hero triad to a `/data` page one click from primary nav,
keep the compact triad in the action footer on every page, and change nothing about
`/llms.txt`, stable bundle URLs, data dictionaries or the no-JSON rule. `check_cdf.py` gained
a `--tool-first` mode (implied by `cdf.tool_first: true` in the ecosystem entry) that
retargets checks (a) and (b) to `/data` **at the same 40% above-fold threshold**, adds check
**(h)** — `/` must link to `/data` — and prints the mode in its JSON and its human table so a
tool-first PASS can never be mistaken for a default PASS. nycvisualizer is registered as the
first member. Measured: **D13 PASS** in tool-first mode (triad on `/data`, offset_ratio
0.063), and the same run **FAILs check (b) without the flag** (offset 0.810) — the amendment
retargets the rule, it does not loosen it. The action footer carrying the compact triad is new
on every chromed page; that is the condition of the exception, discharged.

### W7 — planner usability

**Framing** (the `/renters` paragraph is the template):
- `/maps` said **"Three ways"** while rendering **six** cards → rewritten around the three
  questions the six maps answer.
- `/bus` opened with ~95 words of plumbing (GTFS-RT, poller, interpolation) → what you can do
  first, the honesty second, the plumbing in a fold.
- `/sidewalks` opened with nine unexplained GIS terms in 60 words → same treatment.
- The **route dossier had no explanatory sentence at all** → one paragraph that says what the
  Marey chart shows before showing it.

**Jargon removed or explained**: `2·Area/Perimeter proxy, validated vs max-inscribed width at
r = 0.47` · "the bus feed's `current_status` is 100% NULL" · the bare column header
**"Headway CV"** (now "Gap consistency", with both it and "Bunching" defined under the table) ·
the internal pipeline codename **"derive2"** as a public tab label · workstream codes
**"(S4 …)" / "(S7)"** · **"one-hot color"** and **"tippecanoe"** in a public legend · internal
research-archive IDs in the callout source line (source and year stay; the code moves
to a `title`) · the
confidence popover reading *"LODES WAC 2023 jobs; 1,196-cell H3 grid → 37,507 blocks"*.

**Controls**:
- The workstation rail's **Hw · Sched · Bunch · On-rt** headers had their meanings ONLY in
  `title=` tooltips — which do not exist on touch, i.e. on the device a planner uses in the
  field. The headers are now words, and an on-screen key defines every one of them. The bare
  **"P"** badge now reads **"prelim"**.
- `/bus`'s **345-item `<select>`** gained a free-text filter (route number or street name),
  keeping the borough groups and never dropping the current selection.
- `/sidewalks` asked a planner to choose between two equity metrics with no guidance; each
  now states the question it answers (they can point opposite ways — the poorest fifth of
  blocks has the *highest* provision per frontage foot and the *lowest* per person).
- **One name for one metric**: "Stop Accessibility Index (SAI)" everywhere — it had been
  "Stop Accessibility Index" / "Stop Access Index" / bare "SAI" across three surfaces.

**Honesty**:
1. 🔴 **The live copy described a model the engine does not have.** The ⓘ panel said movement
   was modelled from *"per-segment speeds we've logged since July"*. There are no per-segment
   speed profiles anywhere in this codebase — that is unstarted backlog. `flow/core.ts` holds
   **one speed per vehicle, the speed that vehicle itself last reported**, advances it along
   the route shape for up to `STALE_S` (40 s) and then eases to a stop. Rewritten to describe
   the running engine on `/live/*`, `/bus` (legend and prose) and `/workstation`.
2. 🔴 **The depth gate was bypassed one section above itself.** `/observatory` printed each
   route's bunching index to two decimals, colour-coded green/amber/red, on **all 345 route
   chips** — a ranking of every route in the city, rendered directly above the league section
   that refuses to name a best or worst until 14 observed days. The chips no longer carry it;
   the number is on each route's own dossier with its observed-days count and PRELIMINARY
   stamp.
3. **Precision inflation**: three decimals on a ~6-day archive (`/observatory`, `/leagues`) →
   two; unrounded API floats in the segment-speed popup → one decimal; 0.1-ft precision on a
   width *estimate* → whole feet; and `/sidewalks` no longer says "**all** 96,553 … a
   **near-complete** census" in one sentence (the network is complete; the aerial survey the
   shapes are traced from is what is approximate).
4. **Charts bypassing the Universal Graph Contract**: the four Ops Wall `OpsSparkline` trends
   had no title, no legend and no download. They now carry an accessible name and a top-right
   **Download CSV** with per-bin labels.
5. **Mobile, measured not inferred**: `/renters` used the **non-collapsible** `.nyc-legend`,
   which permanently held the lower-right quadrant while the control panel held the
   upper-left. It now uses the shared collapsible `MapLegend`. Measured on the live edge at
   390×844: the legend is **89×25 px = 1%** of the map (it was an always-open panel up to
   `min(76vw, 320px)` wide); legend + controls together **10%**, well under the
   `ARKMAP_STANDARD §6` one-third ceiling.

### W8 (the frontend half) — pageview telemetry

`/__track` was **error-only**: 42 lines ever, every one from our own HeadlessChrome canary, so
`/api/kpis` reported nycvisualizer `present: False` and "is anyone using this?" was
structurally unanswerable. One `{page, kind:"pageview", ref}` emit was added to the beacon
that already existed, was already proxied and was already excluded from the Cloudflare cache
rule — no new endpoint, no new transport, no third party, no cookie or id, DNT/GPC still
respected, and `ref` is the referrer **hostname only**. Verified landing on the box.

### Verification

`tsc --noEmit` clean · `vite build` clean · **vitest 65/65** · **rule_canary 15/15** ·
**cvd_check 19/19** · **paint_canary 12/12 against the live edge** · **D13 PASS (tool-first)**.
Visual: the C4 harness re-run unchanged against live gives **24 shots / 8 defect findings —
exactly the documented W0/W2–W4 baseline, zero new defects**; a wider 72-shot run over the 12
changed surfaces (1440 / 834 / 390 × light + dark, before and after on the live edge) shows
**zero new real findings**. The four pre-existing horizontal-overflow surfaces (`/data` mobile,
`/observatory` mobile, `/ops` mobile + tablet, `/sidewalks` at all three widths) are identical
before and after and remain open.

## 2026-07-24 — W2/W3/W4: borough colouring by default, street numbers, map themes

Three map-layer packages, all unlocked by the W0 upgrade to `protomaps-leaflet` 5.1.0
(below). Shipped together with the W6a Ops Wall honesty fixes.

### W2 — buses are coloured by home borough by default

The GTFS `route_color` we had been using is not route identity. Across all **345 routes
there are only 7 distinct values**, the largest covering 77 routes: they encode MTA
**service type** (local / limited / SBS / express). Borough grouping gives 6 meanings for
the same 7 colours — a lateral move in colour count, a large gain in meaning.

- Default flipped to borough on **`/live/bus`** and **`/bus`**. `/bus` previously had **no
  borough branch at all**: it always used `route_color` and reached the borough palette only
  through a `!== "#ffffff"` fallback that, measured over the full GTFS universe, **never
  fires** — 0 of 345 routes have a white/blank colour. The palette was dead code while the
  legend already claimed "Buses by borough".
- `?color=route` opts back in and is carried in the shared URL; the toggle is unchanged
  (borough now sits first).
- **`routeGroup` / `GROUP_COLORS` / `boroughLabel` moved into `src/lib/boroughs.ts`.** They
  were duplicated verbatim across `ImmersiveMapPage.tsx`, `WorkstationPage.tsx` and
  `BusMap.tsx` while `boroughs.ts` already declared itself the single source of truth.
- **`/workstation` deliberately keeps its per-selection palette as the default** — collapsing
  a 15-route selection into 5 borough colours would make the selections indistinguishable,
  a regression on the planner's own comparison tool. Borough is offered there as opt-in,
  with an on-screen note saying what it costs.

#### The palette was re-derived, and the old one was measurably unsafe

The shipped palette was not drawn from `lib/palette.ts CATEGORICAL_12` and failed twice:

- **Bronx `#dc2626` vs Brooklyn `#16a34a` is the textbook red/green deuteranopia collision.**
  Simulated they become `#898900` and `#88884f` — CIEDE2000 **ΔE00 9.61** (protanopia 17.77).
  Two of the five boroughs were near-indistinguishable for ~6% of men.
- **X and SIM were the identical hex** (`#0891b2`), ΔE00 **0.00**.

The replacement takes its five borough hues from `CATEGORICAL_12` and derives the two express
families as a +58% lightness shift of their home borough (the same `lightnessShift` the
palette already uses for its >12 wrap), so an express route reads as "a paler <home borough>".
Verified with a Brettel-Viénot-Mollon dichromat simulation + CIEDE2000 over all 21 pairs:

| vision | min ΔE00 | worst pair |
|---|---|---|
| normal | 17.34 | Bronx vs SI-express |
| deuteranopia | 12.21 | Manhattan vs Queens |
| protanopia | 13.07 | Queens vs Man-express |
| tritanopia | 12.53 | Man-express vs SI-express |

- **New canary `tools/cvd_check.py`**, wired into `paint_canary.py` (11 → 12 checks). It reads
  the palette out of `boroughs.ts` and fails the deploy gate if any pair drops below ΔE00 10
  under any of the four vision types. A screenshot cannot see this class of defect.
- New unit tests for the prefix parser's two ordering traps (Bx-before-B, SIM-before-S/X)
  and for palette completeness/distinctness. vitest 55 → 65.
- **Legend honesty:** `routeGroup` classifies by short-name prefix only, so a Bx route keeps
  its Bronx colour all the way into Manhattan. There is no per-segment logic and none is
  planned. Every borough legend now says "coloured by the route's home borough".
- The backend `borough` field is still **not** used: `app/gtfs.py` derives it from the owning
  GTFS feed directory and files 92 routes (27%) under "MTA Bus Co.", which is not a borough.

### W3 — OSM house numbers at z17+

Zero new data and zero new bytes: the `buildings` layer already carries `kind: "address"`
point features with `addr_housenumber` at data zoom 15 (Midtown 1,213 of 2,665 features;
Park Slope 2,110; Bayside 1,603 with Queens hyphenation preserved — `215-29`, `48-01`), and
`maxDataZoom: 15` keeps them available over-zoomed. One `CenteredTextSymbolizer` label rule.
Already ODbL/OSM and already attributed.

- **Coverage is partial and uneven and the legend says so** — 0.83–1.56 address points per
  mapped building across five sampled tiles, denser in Manhattan and Brooklyn. The tiles carry
  the number only; `addr_street` is not present, so a label can never be "42 W 42nd St".
- **The zoom gate is not the rule's `minzoom`.** protomaps keys its labeler on the Leaflet
  *tile* zoom, which we clamp at 16, so `minzoom: 17` would never fire. The rule is declared at
  16 and gated on the map's *display* zoom at runtime.
- W0 inferred that protomaps' internal over-zoom path still drops roads on 5.1.0. **That was
  re-tested rather than trusted**: built with `maxNativeZoom` 19 and shot Midtown at z18 —
  street names render natively and crisply, but road casings and fills are gone. The defect
  survives the major, so the z16 clamp stays, and house numbers (like street names) are
  CSS-upscaled above z16: larger and softer than a native label.
- `tools/rule_canary.mjs` gains a **street-number data contract** check (14 → 15) that decodes
  the served archive and asserts the address points still carry numbers. A future basemap
  rebuild that drops them would otherwise pass every existing guard.

### W4 — four purpose-built map themes, and two wiring defects fixed

**Night Ops** (near-black, minor street names suppressed — ops wall and ant farms) ·
**Planner Light** (white road ribbons over dark casings, prominent labels, muted landuse) ·
**Paper** (grayscale, for print and report figures) · **Focus** (desaturated, so a thematic
overlay owns the colour budget). Auto follows the site theme: Planner Light in light,
Night Ops in dark. `/sidewalks` and `/renters` default to Focus; an explicit choice always
wins. Picker lives in each map legend's Details fold.

Two defects fixed at the root, both of which existed regardless of themes:

1. **The basemap read only the OS `prefers-color-scheme`** and never
   `document.documentElement[data-theme]`, so the in-app theme toggle did not move it —
   while `SidewalkMap.tsx` *did* read `data-theme`. Overlay and basemap could disagree.
2. **`addBasemap` is called from `[]`-dep effects at all 7 map sites**, so the theme was fixed
   at mount and nothing listened for `ark:themechange`. The listeners now live with the layer
   inside `addBasemap`, so no call site had to change its effect deps, and they are torn down
   on Leaflet's `unload`.

The sidewalk coverage overlay now takes its light/dark tone from the theme the basemap
actually painted, not from `data-theme` — one source of truth, and it follows a Paper or
Night Ops choice too.

Custom themes pass explicit `paintRules`/`labelRules` rather than a `flavor` name (the two are
mutually exclusive in `leafletLayer`). They come from protomaps' own generators, so the
filters are identical to `flavor: "light"` and `rule_canary.mjs` still speaks for them.

## 2026-07-24 — W0: the basemap had no roads. It does now.

**The site has been shipping a basemap that draws no roads and no street labels.** Not
degraded — absent. Confirmed by browser screenshots at z16 Midtown in both themes on
2026-07-24: zero road casings, zero road fills, not one named street. Building footprints,
landuse and water drew normally, and **the "street grid" everyone saw was the negative space
between ~2,665 building polygons.**

**Root cause.** The default style bundled with `protomaps-leaflet` 4.1.1 filters on
`pmap:kind` — the Protomaps **v2** tile schema. The tileset we serve is **v4.15.0**, whose
property is a bare `kind`. Every road, landuse and place rule therefore evaluated false: in a
Midtown z15 tile, **86 road features → 0 rule matches**, landuse 246 → 0, places 4 → 0.
`earth`, `water` and `buildings` happened to match, so the map looked populated.

**Why nothing caught it — both guards were structurally blind.**

- `lib/basemap.ts` only asserted `paintRules.length === 0` (the 2026-07-23 `flavor`→`theme`
  failure mode). The array was fully populated — ~34 rules, all matching nothing.
- `tools/paint_canary.py` counts painted pixels, and the painted pixels were real. A pixel
  check **provably cannot** detect a schema mismatch. It also asset-checked the **retired**
  `/basemap/nyc-basemap.pmtiles` — a file the app had not loaded since the z15b cache-bust —
  so it never touched the archive in use. It passed 10/10 throughout.

### Fixed

- **`protomaps-leaflet` 4.1.1 → 5.1.0** (pinned exact). Its default style has zero `pmap:kind`
  occurrences and its dataLayers match the v4.15.0 tileset. Same Midtown tile now yields
  **86/86 road paint matches** and **66 street-label matches** over 61 name-bearing roads.
- ⚠️ **`theme:` → `flavor:` — this INVERTS a standing project rule.** On 4.x the option was
  `theme` and passing `flavor` was the bug (see 2026-07-23 below); on 5.x the option **is**
  `flavor`, backed by `namedFlavor()` from `@protomaps/basemaps`. Every "never `flavor`"
  warning in code, docs and `ARKMAP_STANDARD.md` is updated in this same commit and now states
  plainly that **the rule is version-specific**. New failure mode to know: 5.x `namedFlavor()`
  *throws* on an unknown flavor **value**, so layer construction is now wrapped in a try/catch
  that degrades to the raster fallback; *omitting* the option still yields empty rules.

### Guards, so this class of failure cannot recur

- **New `tools/rule_canary.mjs` — a rule-match canary.** Decodes a real tile out of the archive
  actually being served, runs the real paint/label filters over the real features, and asserts
  **> 0 matches** for roads, buildings, water, earth and landuse, plus that named streets reach
  a label rule — for both `light` and `dark`. Negative control: run against the old 4.1.1 style
  it reports **6/14 FAIL** with roads at 0, exactly reproducing the shipped defect; against
  5.1.0 it reports **14/14 PASS**. Wired into `paint_canary.py` as a first-class check.
- **`paint_canary.py` now reads the basemap path out of `lib/basemap.ts`** instead of restating
  it, so it can never again assert a retired artifact. (`rule_canary.mjs` does the same.)
- **`lib/basemap.ts` guard strengthened**: also verifies the style declares `roads` paint *and*
  label rules, and carries an explicit written statement of what it still cannot see — a green
  rules check is not evidence that anything renders.

### The basemap is now reproducible

- **New `tools/build_basemap.sh`.** There was no basemap build script in the tree at all, and
  `site/README.md` documented a superseded `--maxzoom=14` recipe. The committed script
  reproduces the shipped archive **byte-for-byte** (99,248,382 B, sha256 `6fee904a…5e72b79`,
  verified 2026-07-24 with go-pmtiles 1.31.2):

  ```
  pmtiles extract https://build.protomaps.com/20260722.pmtiles nyc-basemap-z15b.pmtiles \
    --bbox=-74.28,40.49,-73.69,40.92 --maxzoom=15
  ```

  It refuses to overwrite an existing archive (immutable cache ⇒ new filename per rebuild) and
  runs the rule canary on its output before you can ship it.
- **Correction to the 2026-07-24 (W6.1) entry below and to `PERF_BASELINE.md`:** the z15
  basemap was **not** "built with Planetiler". It is a `pmtiles extract` of a Protomaps daily
  planet build that Planetiler 0.10.2 produced *upstream*; the `planetiler:*` metadata is
  inherited verbatim by the extract. Proof: the archive still contains whole-planet low-zoom
  tiles (z4 covers Toronto, Cuba and the Bahamas), which a bbox-bounded Planetiler build cannot
  emit. Owning OSM ingest with Planetiler remains open future work, not something already done.
- Also corrected: `PERF_BASELINE.md`'s claim *"Roads verified rendering at z16/z17/z19 … bold
  street grid"* was wrong at the time it was written.

## 2026-07-24 — C4: visual re-shoot fixes (floating-chrome collisions + clipped rail column)

CSS-only. A 24-shot re-shoot of the changed surfaces (unified `/workstation` with a mixed bus+subway
selection, a 15-selection stress case, and both post-C1 ant farms) at 1440 / 834 / 390 px × light/dark
found four measured layout defects. All four are fixed; no behaviour, data or copy changed.

- **Unified rail clipped its last column at every width.** C3 added a kind badge, an expand chevron and
  an ALERTS column to the old 7-column bus table, taking its natural width to ~441 px — but the rail was
  still `min(92vw, 400px)`, so the INFO (dossier / live-map link) column sat outside the visible box at
  1440 and 834 px (43 px hidden) and 390 px (69 px). Rail widened to `min(92vw, 460px)`, restoring the
  stated intent of "show the dossier link without horizontal scroll". At 390 px the table still has to
  scroll; `.ws-table-wrap` now uses `scrollbar-width: thin` so that scroll is visible rather than an
  invisible overlay.
- **Workstation as-of chip collided with the rail and the panel at tablet widths.** Below ~1330 px the
  viewport-centred chip cannot clear a 300 px panel and a 460 px rail: measured at 834 px it covered the
  rail by 164×56 px (hiding the "Selection data" title) and the panel head by 64×56 px (hiding "Clear
  all"). In the 391–1329 px band the chip now drops to the bottom corridor between the panel and the
  bottom-right chip column.
- **Workstation as-of chip overlapped the rail at 390 px** by 272×38 px. The rail's `max-height` goes
  34dvh → 30dvh and the chip becomes full-width (wrapping to ~2 lines instead of 4), giving a clean
  rail → clock → as-of → bottom-sheet stack.
- **Ant-farm as-of chip covered the route/line filter at narrow widths.** At 390 px the top-right chip
  overlapped the top-left filter card by 221×36 px (`/live/bus`) and 209×36 px (`/live/subway`),
  obscuring the selector. Below 720 px it now sits in the bottom-right column above the clock chip.
  Scoped `:not(.ws-asof)` so the workstation keeps its own placement.
- Also at 390 px the workstation clock chip landed on the bottom-sheet route grid (160×29 px); it moves
  into the free band between the rail and the as-of chip. The corner ⓘ button and legend chip stay in
  the corner — they are z-lifted above the sheet, fully visible and tappable.

Verified: `tsc --noEmit` clean, vite build clean, vitest 55/55 green, paint canary 10/10 PASS against
the live edge, and a 24-shot live re-shoot with zero geometry findings other than the two accepted
corner-furniture overlaps at 390 px.

## 2026-07-24 — C3: unified Planner Workstation (`/workstation`, host `work.`)

Merges the two former single-mode planner workstations (`/workstation/bus` + `/workstation/subway`,
plural hosts `buses.`/`subways.`) into ONE unified Planner Workstation at `/workstation`. Bus routes
and subway lines are now freely mixable in a single selection (e.g. the Bx12 and the D together).
Reuses existing endpoints only — no new dataset, metric, or analytical claim.

- **One left panel, two sections** — Bus routes (borough-grouped, Bronx-first, select-all per borough,
  search) AND Subway lines (official-bullet checkboxes, group select-alls). The count chip and clear-all
  span both selections.
- **One map, all selected populations** — bus stop dots (validated colourblind-safe palette, "colours
  repeat" note past 12) + subway station dots (official MTA colour), NO connecting lines (route-lines
  toggle default OFF), live buses + subway track-worms via the SAME `VehicleFlowLayer` motion model
  (`setVisibility(true, true)`), each selection its own colour — so bus + subway populations are always
  visually distinct.
- **One unified right rail** — one sortable row per selection: buses show active-now · observed vs
  scheduled headway · bunching · on-route position quality; subway lines show trains-active · active
  alerts (still NO fabricated subway headway). A per-row expandable detail drawer reuses
  `/api/obs/dossier` headline fields (buses) / active alerts (lines) — no new claims. Mixed-selection
  CSV export (`text/csv`, no JSON).
- **URL state `?routes=BX12,B44&lines=D,7`** (+ `ll`/`z`), shareable, restored on load.
- **Redirects** — `/workstation/bus?routes=…` → `/workstation?routes=…` and `/workstation/subway?lines=…`
  → `/workstation?lines=…` (client-side, query-preserving), so any shared workstation URL keeps its
  selection.
- **Host map** — the SPA boot map routes `work.nycvisualizer.com` → `/workstation`; the plural
  `buses.`/`subways.` host mappings were **removed** (their CF hostnames were never created and are no
  longer wanted). The singular `bus.`/`subway.` immersive ant-farm hosts are unchanged.
- Full-window immersive-chrome pattern (floating strip + ⓘ overlay + legend chip + honest clock), both
  themes, 390 px bottom-sheet. Landing + Maps hub now show ONE "Planner Workstation" card. Engine
  (`src/flow/`) and backend untouched. `tsc`+build clean; vitest 55/55 green; deployed + verified live
  (mixed Bx12+D two-population render; legacy-path redirects preserve selection; paint canary 10/10).

## 2026-07-24 — nycviz-flow C1: continuous motion (shape-residency fix + hold-last-speed + per-vehicle anchoring)

Makes the live bus "ant farm" actually crawl continuously instead of freezing-and-jumping, and
de-synchronizes the citywide poll pulse. Grounded in the motion-continuity study (14.95 M
transitions) plus a fair on-the-live-feed 4-model measurement that corrected the study's premise.

- **Shape-residency fix (the big one)** — `RouteShapeCache` `LRU_MAX` 50 → 1200. The engine ingests
  the WHOLE fleet each snapshot (~550 shape_ids / ~285 routes), so a viewport-sized 50 evicted ~90 %
  of shapes every tick, bouncing buses OFF the dead-reckoning path onto the straight glide — they
  froze then jumped. Sizing the cache above the fleet keeps every bus stably dead-reckoning along
  its shape. Measured live: shape-following buses **0 → ~2650 (99.5 %)**; continuous-motion frame-
  delta **mean ×12** (0.7 → 8.8 changed-px/frame). Each shape is ~2 KB, so full-fleet resident is
  ~1–2 MB, and each route is fetched ONCE instead of re-fetched on every eviction.
- **Hold-last-speed-until-stale** (`advanceDist`, new `STALE_S` = 40 s) — a stale bus now holds its
  last speed unbiased for STALE_S, THEN eases to a stop over `DECAY_S`, instead of decaying from
  t = 0. Removes the systematic decay-to-stop bias (offline archive −101 → ~0 ft; live raw −66 → +30
  ft) that caused the coherent forward-lurch pulse. Honesty preserved: bounded hold, no fabricated
  motion past STALE_S + DECAY_S.
- **Per-vehicle report-time anchoring** — each shape bus / train is placed by ITS OWN `timestamp`
  (one clamped epoch→perf offset per feed, slewed off the batch's newest report) rather than the
  shared poll instant, with a poll-time fallback for absent/stale/future stamps
  (`getStats().anchorFallbacks`) and stale re-serves skipped. Measured: the citywide single-instant
  pulse became a diffuse ripple smeared across ~8 s of each poll window; poll-lag frame-delta
  autocorrelation **0.15 → 0.05**. (Batched 30 s snapshot delivery means reports still arrive
  together, so a residual staggered ripple remains — full removal needs streamed delivery.)
- **Dead-reckon on the segment prior, not observed speed** — the fair live 4-model comparison
  overturned the study on the RAW `route_offset_ft` feed: observed last-leg speed amplifies GPS/map-
  match jitter and measured WORSE (median 199 ft / p90 598) than the smooth `speed_est_fps` segment
  prior (median 188 / p90 420). The study's "observed beats segment / 92 → 44 ft" held only on its
  SMOOTHED derived trajectories; on live raw offsets all models sit ~160–200 ft. So the engine holds
  the segment prior (dwell-detection still uses observed advance).
- **Tests** (`vitest`): **46 → 55** assertions. New `advanceDist` hold-then-decay math; engine
  stagger / stale-decay-boundary / clock-offset-guard / re-serve / segment-prior-dead-reckoning
  cases. The decay-to-STOP and snap-correct golden-replay tests were retuned for the new
  hold-then-decay terminal (updates noted inline). Clean `tsc` + build; paint canary **10/10**.
- **Honest caveat**: the study's headline "predErr 92 → 44 ft live" is NOT achieved — that number is
  a property of smoothed derived trajectories, not the live raw feed. What ships is genuinely
  continuous motion, the systematic bias removed, and a de-synchronized pulse.
- **Option B tested + reverted (raw-feed floor stands)**: a bounded server-side smoother
  (`motion.py`, median-of-last-3-reports + monotonic clamp, `offset_raw_ft` kept) was deployed and
  A/B-measured over ~11 min against the raw offset on identical payloads (n≈18 k transitions). It
  made the between-tick error WORSE, not better — shipped hold+segment median **194.9 → 227.3 ft
  (−16.6 %)**, all four models worse smoothed — because a median-of-3 lags ~1 report and the lag
  mismatches the prediction interval more than it removes projection noise. Per the keep-only-if->20 %-
  drop rule it was **reverted**; the api serves raw `route_offset_ft`. Realizing the study's ~44 ft
  live would need the heavier offline derive2-style per-trip processing, not a light real-time filter.

## 2026-07-24 — nycviz-flow: ant-farm engine formalized (host-agnostic, tested)

Pure internal refactor of the live-vehicle "ant farm" renderer — **zero user-visible change**.
The bespoke `VehicleFlowLayer` canvas engine was extracted VERBATIM into a documented, tested,
host-agnostic module `src/flow/` (the "nycviz-flow" engine), behind a one-file `FlowHost` seam so
a future MapLibre swap is a new host, not a renderer rewrite. Every constant, easing curve,
threshold and honesty rule moved unchanged; `VehicleFlowLayer` is now a thin Leaflet back-compat
wrapper, so `BusMap` / `ImmersiveMapPage` / `WorkstationPage` needed zero changes.

- **Modules** (`src/flow/`): `core` (rAF loop, unit store, tween/decay-to-stop/snap-correct state
  machine, draw orchestration), `project` (Web-Mercator, meters-per-pixel), `shapes` (offset/
  cumulative-length walks + worm geometry), `draw` (slabs/worms/rings/trails/pulses), `hittest`,
  `ladder` (trails→30fps→tick-jump degrade), `types` + the **FlowHost interface**, and
  `hosts/leaflet.ts` (the ONLY `leaflet` importer). Architecture, contract, module map, perf
  budgets and honesty rules documented in `src/flow/FLOW_ENGINE.md`.
- **Tests** (`vitest`, `npm test`): 46 assertions across a pure-math suite (projection fixtures,
  offset/shape edge cases, decay/clamp, degrade-ladder, hit-test) and a deterministic "golden
  replay" engine suite (fake FlowHost + recording canvas on a simulated clock) that locks the
  draw-branch selection and the glide / 45 s decay-to-stop / >200 ft snap-correct honesty rules.
- **Parity**: clean `tsc` + build (basemap chunk unchanged at 76 KB gzip; engine ships as a shared
  ~8.7 KB gzip chunk); paint canary **10/10** before and after; live frame-time parity within
  ±1 ms (mean 2.09 → 2.36 ms, 60 fps, no tick-jump); motion continuous on both.

## 2026-07-24 — Ant Farm v3 W5: motion-model legend honesty + close-out gates

Wording-only fix closing the Ant Farm v3 gate pass. The map legends and info overlays now state
the motion model honestly and consistently: for buses, movement between reports is **modeled from
each route's recorded behavior** (the per-segment speeds logged since July), not a naive tween;
for trains it stays an honest **estimate along the track**. The report cadence is stated as the
real **~31 s** everywhere (was an inconsistent "~30 s").

- `/bus`, `/live/bus`, `/workstation/bus` legends + immersive/workstation ⓘ overlays: "Reports
  arrive ~31 s apart · between them movement is **modeled** from each route's recorded behavior."
- `/live/subway`, `/workstation/subway`: "…between them position is estimated along the track"
  (subway motion is interpolation, not per-segment speed telemetry — kept accurate, no overclaim).
- Full carson-visual re-shoot of all eight map surfaces × {1440, 834, 390} × {light, dark}
  (48 screenshots): zero rendering defects; paint canary 10/10 PASS; motion-honesty watch of
  `/live/bus` over 3+ ticks showed no on-screen teleports (large moves are off-viewport eased
  data-jumps), smooth steady-state glide (median between-tick prediction error ~34 ft), plus
  docked-pulse and decay-to-stop behavior confirmed.

## 2026-07-24 — Ant Farm v3 W3/W4: Planner Workstations

Two new full-window planner tools — an analytical monitoring workstation for a professional
transit planner — at `/workstation/bus` (host `buses.nycvisualizer.com`) and
`/workstation/subway` (host `subways.nycvisualizer.com`). Deployed + verified live (apex paths
200; paint canary 10/10 PASS; 20-route selection measured at 0.2 ms/frame @ 60 fps).

- **Bus Planner Workstation.** A left panel of **borough-grouped route checkboxes** (alphabetical,
  Bronx first) with **select-all per borough**, a search filter, a selected-count chip, and
  clear-all. Selecting N routes assigns each a **distinct colourblind-safe colour** (a validated
  12-hue categorical cycle with a lightness shift past 12, plus a visible "colours repeat" note).
  The map draws each route's **stops as colored dots — no connecting lines** (an optional "Show
  route lines" toggle, default OFF) plus its **live buses in the route colour**, using the same
  motion model as the ant farm (two routes = two visibly distinct populations). A right-hand
  **data rail** shows one sortable row per route — active buses now, observed median headway
  today, bunching index, scheduled headway, and on-route position quality — with a
  contract-compliant **CSV download** of the selection. Shareable URL state (`?routes=…&ll&z`).
- **Subway Planner Workstation.** The same package for a subway planner: **official-colour
  line-bullet** multi-select grouped (numbered / lettered / shuttle+SIR), stations of the
  selected lines as line-colored dots, live track-worms, and a rail of trains-active and
  active-alerts per line with dossier-equivalent "Live map" links. Shareable URL state
  (`?lines=…&ll&z`) + CSV.
- **Isolated family.** The workstations are their own full-window family (immersive chrome:
  floating strip + corner ⓘ overlay + legend chip). Every hop to the other workstation, or to a
  route dossier, is a **full page load** — never an in-SPA route swap — so each Leaflet family
  boots clean. Both set a `canonical` link to their apex path; both honour the light/dark theme
  and collapse the panel to a bottom sheet at ≤ 390 px.
- **No new data claims.** Reuses existing endpoints only — `/api/rt/vehicles`, `/api/rt/subway`,
  `/api/routes/{id}` (stops), `/api/obs/routes` (headway/bunching/scheduled), `/api/obs/adherence`
  (framed as *position quality*), `/api/rt/alerts`. Landing + Maps hub each gain two planner-toned
  cards. **Host repurpose:** the plural `buses.` host was previously a silent `/live/bus` alias —
  it now serves the workstation; the singular `bus.`/`subway.` keep the ant farms.

## 2026-07-24 — Standalone (de-federation) + keep-indefinitely telemetry retention

NYC Visualizer became a **standalone product** — no longer connected to any shared site
ecosystem. Deployed + verified live (paint canary 10/10 PASS; served bundle carries zero
cross-site links).

- **De-federation (chrome).** Removed the ecosystem site-switcher, all hub links, and the
  "research-project" framing from the header, footer, About page, immersive ⓘ overlay, and
  `llms.txt`. The header brand is now the site's own name linking to `/`; the footer is a
  single quiet **"Built by Nick Anderson — nickanderson.us"** line plus the data-source
  attributions (**MTA · NYC Open Data · OpenStreetMap / Protomaps**). Own favicon/name kept.
  The site still uses the shared Arcanum Site Kit chrome for its engineering standards — only
  the federation was dropped, not the standards.
- **Ecosystem manifest.** `ecosystem.json` trimmed to only this site's entry plus the author
  anchor (it now feeds just the Research Triad's Data/Code/Outputs block); the unused vendored
  switcher kit files were removed from `public/_shared`. The served bundle contains no
  cross-site or hub links.
- **Telemetry retention → keep-indefinitely.** The realtime raw archive is now **kept
  indefinitely** (was documented as 90-day rolling), preserving `vehicle_id`-level history as
  the raw material for future motion work; at ~200 GB the oldest whole month **moves** to cold
  storage, never deletes. There is no age-based pruning routine in the poller (a low-disk guard
  merely *suspends* archiving) — a docs-only change; see `pipeline/realtime/README.md`.

## 2026-07-24 — Ant Farm v3 W1 (client) + W6.1 basemap depth

The client half of the "make the ant farm appear continuous — simply, honestly" motion
upgrade, plus the "roads must never disappear" basemap fix. Deployed + verified live
(paint canary 10/10 PASS).

- **Shape-following motion model** (`VehicleFlowLayer` + `lib/shapeCache.ts`): a bus carrying
  a backend `shape_id` + `route_offset_ft` now glides ALONG its route shape from its last
  reported offset at `speed_est_fps` — never a straight line through blocks, never a teleport.
  Shape geometry is lazy-fetched per visible route from `/api/rt/route_shapes` into an
  LRU cache (~50 shapes), with precomputed cumulative-length arrays for an O(log n)
  offset→point lookup. Buses without shape data keep the straight prev→cur glide.
- **Decay-to-stop (sparse-data humility):** with no fresh report a gliding bus eases to a
  full stop over ~45 s and resumes on the next ping — it never sails on indefinitely.
  Dwelling buses (offset not advancing) dock in place with a subtle pulse; **no fake creep**.
- **Snap-correct, honestly:** a fresh report landing > 200 ft from the prediction closes the
  gap with a fast ease (≤ 1 s), never a visible rubber-band. Between-tick prediction error is
  sampled to a ring buffer — **median ~73 ft** live (via the `?perf` hook).
- **On/offline:** new vehicles fade in; a vehicle missing > 3 ticks fades out and emits a
  coalesced `bus_offline` telemetry beacon.
- **Frame budget:** z11–z13 with motion trails on measured **< 8 ms/frame @ 60 fps** live
  (peak z12 6.31 ms at ~825 units); the degrade ladder never engaged across z10→z19.
- **W6.1 — roads never disappear:** the NYC basemap is rebuilt at **maxzoom 15** with
  **Planetiler** (official Protomaps profile) — `nyc-basemap-z15b.pmtiles`, replacing the
  36 MB maxzoom-14 extract. `basemap.ts` sets `maxDataZoom: 15` + `maxNativeZoom: 16` so
  z16 resolves real z15 road data and z17–z19 CSS-scale that tile — every road stays
  rendered on the deepest overzoom instead of blanking. Verified at z16/z17/z19 in dense
  (Midtown) and suburban areas, light + dark. Size: 36 MB → ~95 MiB (range-served,
  edge-cached).

## 2026-07-23 — Ant Farm v3 W1 (server): shape-following motion model + route adherence

Backend half of the "make the ant farm appear continuous — simply, honestly" motion upgrade.
The client glide (W1-client) lands separately; this ships the data it needs. Deployed +
verified live (paint canary 10/10 PASS).

- **Bus route→shape LUT, built once at startup** (`app/busshapes.py`) — mirrors the subway
  seg-LUT pattern: a disk-cached pickle keyed by a GTFS-static content fingerprint, holding
  per (route_id, direction_id) the canonical (most-detailed) shape decimated with a
  Ramer–Douglas–Peucker pass in **EPSG:2263 feet**, carrying each kept vertex's *full-shape*
  cumulative offset so a projected offset stays in the same ft space as derive2's speed table.
  **683 route×directions / 345 routes**, median 47 verts/shape; build ~4 s cold, ~0 ms warm.
- **`/api/rt/vehicles` additive fields** (`app/motion.py`, enrichment folded into the existing
  10 s TTL cache — runs once per build, not per request): `shape_id`, `route_offset_ft`
  (nearest-point projection of the GPS onto the route shape), `speed_est_fps` + `speed_basis`.
  Honesty guards ported from `trajectories.py`: **off-shape > 200 ft** or a **> 500 ft backward
  (non-monotonic) offset jump** between a bus's prev and latest ping → shape fields **omitted
  and counted** (surfaced in a new `motion` summary block). Shape coverage **~99.5 %** of live
  buses. Projection validated: reconstructing a bus's position from `route_offset_ft` lands
  within **p50 2.3 ft / p99 12.5 ft** of its actual GPS.
- **Blended `speed_est_fps`** — observed displacement/Δt (archive path, sane 1–90 fps) →
  per-route×half-mile-segment median → per-route median → 12 fps citywide default, tagged by
  `speed_basis`. Medians come from a new consolidated **speed table** (`route_segment_speeds/`,
  13,396 segment rows over 23.1 M along-shape observations, citywide median **10.4 fps ≈ 7.1 mph**).
- **Route-adherence metric** (`pipeline/realtime/derive2/adherence2.py`, new stage folded into
  `run_derive.py`; backfilled all 8 archive days) — per route×day share of pings within 100 ft
  of the trip shape, first/last 500 ft excluded. **Honest finding: MTA BusTime reports positions
  already map-matched to the route path** (97 % of pings within 1 ft), so on-route reads
  **≈99.999 % citywide / 100 % median route** and chiefly confirms position quality; only genuine
  reroutes push a bus past 100 ft (worst routes BX46/S98/M8 ≈ 99.98 %). Exposed at
  **`/api/obs/adherence?route=`** (summary + daily series; citywide distribution when no route),
  with the snapping caveat baked into the payload.
- **`/api/rt/route_shapes?route=&direction=`** — the exact decimated lat/lon polyline
  `route_offset_ft` is measured against, with a cumulative `offset_ft` per vertex, so the motion
  client can place a bus along the same geometry.
- **Dep:** the API image now installs **pyproj** (coordinate transform only; projection +
  decimation are hand-rolled in numpy — no shapely in the API).

## 2026-07-23 — Ant Farm v2 F5: reliability (never ship a blank map silently)

Graceful degradation + observability + a mechanical deploy gate, so the F0 blank-basemap
class of bug can never ship or persist unseen. Deployed + verified live on nycvisualizer.com
(post-deploy paint canary **10/10 PASS**).

- **Raster basemap fallback, auto-engaged** — the OSM raster path was tree-shaken out of the
  build; it is now re-included and wired to the F0 regression guard. On **empty paint rules**
  (the exact `flavor`→`theme` failure) OR **>30 % tile errors in the first 15 s** (measured via
  `tileloadstart` vs `tileload`, since protomaps-leaflet swallows fetch errors) OR **zero painted
  pixels**, the guard swaps the broken vector basemap for OSM raster tiles and shows a visible
  **"simplified basemap"** chip — a real map instead of a blank void. Proven by a simulated
  failure (bogus theme → empty paint rules → auto-engage screenshotted), then reverted. The
  raster path is a deliberate, chip-labelled degraded-mode exception to the no-CDN rule, engaged
  only when the self-hosted basemap is provably broken.
- **Client error beacon** — map pages POST `{page, kind, detail, ua}` to `/__track` on caught
  map-init errors, guard-triggered fallback, zero-painted-tiles after 10 s, and SSE
  permanently-down (>5 consecutive failures). The backend `/__track` now appends events as
  greppable JSONL (`kind=map_error`); a Caddy route was added so the bare `/__track` path
  actually reaches the API instead of being swallowed by the SPA fallback. Ops: **grep the box
  telemetry for `kind=map_error`**.
- **Post-deploy paint canary** — `site/tools/paint_canary.py` drives a headless browser to prove
  the basemap paints **pixels** on /bus, /live/subway, /sidewalks and that the RT endpoints serve
  live counts + the pmtiles assets are servable. One PASS/FAIL line per check, exit code gates the
  deploy: **a deploy is not done until paint_canary PASSES against the live edge.** Added to the
  REFRESH.md regeneration/verify chain and the box deploy README.
- **Periodic synthetic check** — `JaneNYCCanary` (Windows Scheduled Task, every 6 h, offset 3 h
  from `JaneNYCGtfsSnap`) runs the canary against the live edge and logs PASS/FAIL to
  `realtime/logs/canary.log` — the silent-regression net.
- **bbox adoption on immersive + /bus** — rt polls now send `?bbox=<viewport>` (updated on
  `moveend`, debounced; **SSE unchanged**), and refetch on pan so units entering the viewport
  appear immediately. Measured live payload reduction: **79 % (borough view) → 92 % (neighborhood)
  → 97 % (few blocks)**; the whole-city default view trims ~23 % (little to cut there).

## 2026-07-23 — Ant Farm v2 F4: restrained live-map enhancements

Four subtle, intelligibility-serving additions to the live maps — nothing else (the
not-overcrowding pact holds). All four ride the shared `VehicleFlowLayer`, so /bus and
/live/* get them at once; theme-aware; verified live on nycvisualizer.com in both themes + 390px.

- **Follow mode** — click a vehicle → its popup gains a **▸ Follow** action; the camera then
  eases to track it (`panTo` easing, zoom kept) while a minimal *"Following M15 bus 4821 —
  tap map or press ESC to stop"* pill shows. Works for buses **and** subway worms (tracks the
  worm's head). Dismisses on ESC, map-tap, or the unit going away. No standing UI otherwise.
- **Focus dim** — from the vehicle popup (and the follow pill) **◎ Focus route/line** drops all
  other units to **25 % alpha with their trails off**, so the chosen flow pops; the focused
  bus route's **shape overlays** (subway is dim-only — line shape isn't cheap). One-tap clear
  chip. Plays with the legend + filters.
- **Motion trails** — a ~20 s fading tail per moving unit (thin, theme-aware, rendered from a
  per-unit ring buffer into the same canvas; ≤12 points, alpha ramp to 0, **banded** to ≤3
  strokes/unit). Perf-budgeted and measured headless at **3,000 units**: trails-on stays
  ≤ **8.9 ms/frame** at z11–13 (the ~9 ms at z12 is the base all-visible shape draw, not
  trails). Trails are the **first** thing the degrade ladder sheds (before dropping fps).
  Legend **"Motion trails"** toggle — default **ON** for /live/*, **OFF** for /bus.
- **Honest clock** — the as-of chip promoted to an always-visible, glanceable *"live · updated
  mm:ss ago"* corner chip on /live/*, stacked by the legend chip; real age, stale/error dot.

## 2026-07-23 — Ant Farm v2 F3: capacity hardening (origin O(1) in users)

Load-testing the live edge showed the RT poll endpoints re-read parquet/GTFS-RT via
duckdb on **every request** (no shared connection), so origin CPU scaled ~linearly with
concurrent users: the p95 < 5 s knee was **below 50 users**, and polls started timing out
and erroring at ~100 concurrent users. This wave makes the origin **O(1) in users**.

- **In-process TTL single-flight cache** (`app/runtime.py::TTLCache`,
  `NYCV_RT_CACHE_TTL_S=10`) wrapping `get_vehicles` / `get_subway`. The expensive read now
  runs at most once per 10 s per worker regardless of load; concurrent misses await ONE
  recompute (no thundering herd). Measured effect at 500 VU: poll errors **88.8 % → 23.4 %**,
  api-container CPU **~365 % → ~190 %**, box load **~10.2 → ~7.2**; **0 % errors through
  200 users** (was 20–29 %).
- **`Cache-Control: public, s-maxage=10, stale-while-revalidate=20`** on `/api/rt/vehicles`,
  `/api/rt/subway`, `/api/wall` (origin-side edge-cache hint; SSE stays `no-cache`). Worst-case
  data staleness bounded ~61 s, typical ~35 s; the `as_of` stamp always shows true age.
- **`?bbox=minLon,minLat,maxLon,maxLat`** viewport filter on the two RT endpoints —
  server-side, **additive, default = full**, applied to the cached payload (never mutated),
  sets `bbox_filtered` + recomputed `count`, malformed bbox → full payload. A Manhattan
  viewport cuts payload **−78 % (vehicles) / −63 % (subway)**.
- **SSE ceiling** (`app/runtime.py::SSELimiter`, `NYCV_SSE_MAX=200` per worker) shared across
  the vehicles/subway/wall streams; over cap → **`429` + `Retry-After: 30`**, and the client's
  existing 30 s poll fallback engages automatically.
- **uvicorn tuning** (`Dockerfile.backend`): `--workers 2 --timeout-keep-alive 15 --backlog 2048`.

See `CAPACITY.md` (project tree) for the full before/after tables and the ⛔ Cloudflare Cache
Rule paste-block (Cloudflare does **not** cache these JSON paths on `s-maxage` alone —
`cf-cache-status` stayed `DYNAMIC`; the rule is required to add the edge/bandwidth half).

## 2026-07-23 — Ant Farm v2 Wave 1: at-station train rings + shared legend

Trains reported *at a station* (~54% of the fleet at rush hour) were hidden under the
opaque white station discs at zoom ≥ 13 — the map looked like most trains had vanished.

- **At-station rings:** docked trains now render as a **line-colored ring** around the
  station position, drawn on the vehicle canvas which was raised to its own Leaflet pane
  at `z-index 450` (above the station SVG at 400). Moving units — in-transit worms and
  buses — now pass cleanly *over* stations instead of under them. Station discs shrink
  (r 3.5 → 2.5, fill-opacity 1 → 0.85) so the ring reads as "wrapped around" the stop.
  Every train now has a visible, distinct state: solid worm (moving) · faded (estimated
  between stations) · ring (docked).
- **Shared `MapLegend`:** one collapsible corner "Legend" chip across `/bus`,
  `/live/bus`, `/live/subway`, `/sidewalks`, and `/ops` (replacing the ad-hoc per-map
  legends). Shows true-scale shapes, color meanings (subway line bullets / borough
  colors / coverage classes / bunching severity), motion semantics ("updates ~30 s;
  movement between updates is estimated"), and a state row; folds the data-vintage /
  as-of stamps in. ≤ 8 visible lines with a "Details" expander; collapsed by default on
  immersive `/live/*`, expanded elsewhere. Both themes, verified at 390 px.
- **SSE console noise:** the `/api/rt/*/stream` `ERR_ABORTED` churn is silenced — the
  EventSource handlers are detached before each close, and the bus/subway streams no
  longer re-subscribe on visibility toggles (visibility is handled separately).
- **`seg_basis` (forward-compat):** the client consumes the backend's new
  `seg_basis` field ("straight" prev→next glide vs real "shape" polyline) when present,
  with a marginally simpler underlay for straight-basis worms; fully backward-compatible
  when the field is absent.

Verified with a real paint check (headless CDP; all five surfaces, both themes, 390 +
1280) locally and live on nycvisualizer.com: docked trains render as visible rings at
z13–15, worms pass over stations, legends present on every surface. Frontend-only deploy;
the paired subway seg-coverage backend change ships separately.

## 2026-07-23 — P0 fix: basemap now paints on every map page

> ⚠️ **SUPERSEDED 2026-07-24 (W0) — the rule below is inverted on the version we now ship.**
> This entry is correct history for protomaps-leaflet **4.x**. We are now on **5.1.0**, where
> the option **is** `flavor:` and `theme:` is the silent-failure. Do not apply "never `flavor`"
> to the current codebase. See the 2026-07-24 W0 entry and `ARKMAP_STANDARD.md §7.1`.


The Protomaps vector basemap was fetching tiles but painting nothing on every map
page, in production, for all users. Root cause: `addBasemap()` passed `flavor:` to
protomaps-leaflet's `leafletLayer()`, but that library (v4.1.1) reads `theme:` —
`flavor` is the separate MapLibre `@protomaps/basemaps` API. An unrecognized option
falls through to empty `paintRules`/`labelRules`, so the layer renders blank.

- `basemap.ts`: `flavor:` → `theme:` (`"dark"`/`"light"` are valid keys in the lib's
  themes registry). Basemap now paints in both light and dark.
- Regression guard: after layer construction, assert non-empty `paintRules`; on an
  empty rule set, `console.error` and show a "basemap style failed to load" chip in
  the map corner, so a silent recurrence can never ship again.
- Cosmetic: Leaflet container background now uses the theme bg token (Leaflet's
  default `#ddd` was a wrong-colored void in dark mode before tiles paint).

Verified with a real paint check (headless CDP; `/bus`, `/live/subway`, `/sidewalks`;
light + dark) locally and live: every basemap tile canvas paints (nonzero-alpha
pixels), guard silent.

## 2026-07-23 — Immersive full-window ant-farm views (`/live/bus` + `/live/subway`)

_Bus view canonical path is `/live/bus` (singular) on `bus.nycvisualizer.com`; the legacy
`/live/buses` path redirects to it client-side and `buses.` is a silent host alias, so nothing
previously shared breaks._

Two new chrome-less, full-window homes for the live ant farm — one for buses, one
for the subway — each on its own route and additive vanity subdomain. They REUSE
the existing `VehicleFlowLayer` renderer (not forked); no new data or claims.
Built, deployed, and verified live end-to-end (headless Chrome; both themes;
1440 / 834 / 390; motion confirmed).

### New `ImmersiveMapPage` (I1)
- `100dvw × 100dvh` map canvas with safe-area insets (`viewport-fit=cover`), **zero
  page scroll**, and no standard header/footer — the immersive routes render
  OUTSIDE the site chrome. Both themes.
- **Floating top strip** (the "links at the top"): identity mark → hub, a Buses/Subway
  mode switch, and links back into the site (Transit Map · Observatory · Ops Wall ·
  Sidewalks · Renter's Map · Data). Collapses to a menu at mobile widths; **auto-fades
  to a thin grab-tab after ~5 s idle** and reappears on any pointer / touch / key.
- **Corner ⓘ overlay** carries the mandated **dual anchors** (heterodata.org +
  nickanderson.us), basemap attribution, the data-vintage / honesty stamp (with a live
  ms/frame readout), and a **theme toggle** — so identity/D9 pass without page chrome.
- **Mode scoping:** `/live/bus` = ant-farm buses only, with a route filter (loads the
  shape + shape-snapped glide) and a borough-vs-route color toggle; `/live/subway` =
  track-worms only, with line filter chips (official MTA bullets), station dots at
  zoom ≥ 13, and estimated positions honestly faded.
- **Shareable URL state** (`?ll=&z=&route=|line=`), per-mode `document.title`, and a
  `canonical` link to the apex path (the subdomains are additive — no duplicate content).

### Wiring (I2.1)
- SPA boot host→path map extended: `bus.` (and silent alias `buses.`) → `/live/bus`,
  `subway.` → `/live/subway`.

### Integration (I3)
- Landing + Maps hub gain Bus/Subway Ant Farm cards; `/bus` links "full-window view →"
  for each mode; ecosystem manifest lists both immersive pages.

_The `bus.` / `subway.` Cloudflare Public Hostnames are a user-side (DNS/tunnel) step;
the apex paths `/live/bus` and `/live/subway` work standalone without them._

## 2026-07-23 — Live Transit Map "ant farm": animated true-scale vehicle canvas

The `/bus` Live Transit Map now renders every bus and subway train as a
TRUE-SCALE, bearing-oriented shape that MOVES CONTINUOUSLY, so at city zoom the
fleet reads as flowing veins and zooming in reveals individual units gliding.
Deployed and verified live (headless-Chrome CDP; light + dark; 1440 + 390).

### New `VehicleFlowLayer` (single animated canvas overlay)
- Replaces the discrete circle/bullet Leaflet markers with **one** rAF-driven
  `<canvas>` overlay pinned to the map (same zoom-animation transform as
  `L.Canvas`). Buses = true-scale rounded slabs (~12 m, 18 m for SBS/express)
  rotated to bearing; subway trains = ~160 m worms lying ALONG the actual
  inter-station GTFS track shape (backend now emits the segment + fraction).
- **Continuous motion (ant farm):** dead-reckoning tween — each report starts a
  ~30 s glide from the currently-displayed position toward the new one, so units
  walk their last displacement smoothly instead of snapping every tick. Bearing
  from the movement vector (payload bearing fallback). New units fade in; units
  missing > 3 ticks fade out. The **selected** bus route snaps + glides its buses
  ALONG the loaded shape polyline (no corner-cutting on the featured route).
- **True scale:** meters→pixels via Web-Mercator m/px at the viewport latitude;
  clamped to a ~3 px minimum (city zoom = moving specks / veins) with full shapes
  at zoom ≥ 12 and cheap moving specks below. Subway interpolated positions keep
  reduced opacity (honesty); official MTA line colors; theme-aware contrast
  outline for light + dark basemaps.
- **Performance:** one redraw/frame, viewport culling, alloc-free inline
  projection + typed-array hit store. Measured (headless, no-GPU worst case):
  **z11 default ~2.6 ms/frame @ ~4,450 units**, z14 ~4 ms, z16 ~1.8 ms, dark
  ~2.5 ms, mobile-390 ~8.5 ms — all under the 12 ms budget (real GPU users
  faster). Pauses on `document.hidden`; graceful **reversible** degrade to 30 fps
  then tick-jump only as a last resort, auto-recovering when the view is cheaper.
  An honest "N ms/frame" readout ships in the map's status line.
- Interaction preserved: click/tap hit-tests the nearest unit (~8 px) → existing
  popup; hover cursor; Buses/Subway toggles and the route filter keep working.
  Legend gains a "vehicle shapes at true scale — positions between reports are
  estimated" honesty line.

### Backend (`/api/rt/subway`)
- Interpolated trains now carry `seg` (rounded, ≤28-vertex inter-station track
  polyline in travel order) + `frac` (0→1 progress), so the client can lay the
  worm along the real shape and animate along it. Adds ~40 KB to the subway
  payload; at-station trains are unchanged (drawn as line bullets).

## 2026-07-23 — Q4.1/Q4.2 structure, flow & performance deep pass

IA/navigation rework + per-spoke code-split. Deployed and verified on the live
public site (headless Chrome, light+dark, 1440 + 390). Regression-guarded: the
Marey diagram, Ops Wall dark, Q1 coverage centerlines, confidence badges, KB
callouts, and reconciliation panels all render unchanged.

### IA / navigation (Q4.1)
- Flat 9-item bar → **spoke-first grouped nav**: `Maps · Observatory · Ops Wall ·
  Data · Methodology · About`. "Maps" and "Observatory" are section landings; the
  chrome nav stays flat (no dropdowns), so grouping is expressed with in-page
  sub-nav strips. "Code" drops off the bar (reachable from Data) to keep six items
  that wrap cleanly on mobile. Grouping-parent highlight: any `/bus /sidewalks
  /renters /maps` path lights **Maps**; any `/observatory*` lights **Observatory**.
- New **Maps hub** (`/maps`): hero + the three map cards.
- New shared `SectionSubnav`; `ObsSubnav` refactored onto it; new `MapsSubnav`
  (Overview / Transit Live / Sidewalks / Renter's Map) shown on the three map pages.
- Landing gains a **"how to read our badges"** taxonomy legend (the three
  ConfidenceBadge tiers, one line each, sourced from the same registry).
- **Breadcrumbs** on route dossiers (Observatory › M15).
- **Cross-links**: dossier → Reliability leagues + "Service changes for {route}"
  (Changes now reads `?route=` from the URL); sidewalk SAI/ADA popups gain an
  "Explore this location in the Renter's Map" link (lat/lon URL); the Renter
  scorecard's transit section links each nearby bus route to its dossier. All
  internal `<Link>`s; shareable URLs preserved.

### Performance (Q4.2)
- **Per-spoke code-split** (`React.lazy` per route). Main `index.js` **733 KB → 207
  KB raw** (244 → 69 KB gzip). Leaflet + protomaps hoisted into ONE shared `basemap`
  chunk (map pages only, cached) — no double-include. Plotly stays a deferred
  dynamic-import chunk (never on first paint).
- **Landing first paint ~263 → ~85 KB gzip (−68%)** — well under the < 1 MB target.
- Live TTFBs 76–115 ms (all < 150 ms target); `/api/wall` warm at 94 ms; assets +
  geo layers immutable/long-cached → warm loads under the 400 ms target.
- Full measured table + method notes + known-heavies: `PERF_BASELINE.md` (internal
  regression reference).

## 2026-07-23 — Q3.3 knowledge exploitation (history meets live)

Ingested-KB knowledge surfaced on the live pages. Verified live (public site +
API; observatory.nycvisualizer.com 200, `/api/downloads` = 47 items with the new
keys resolving).

### Hub-Bound "history meets live" chart (Observatory landing)
- New `analysis/cordon/build_hub_bound_series.py` assembles the **NYMTC Hub Bound**
  cordon series — 24-hour persons entering the Manhattan CBD (south of 60th St) by
  mode — from the 85 verified born-digital cordon CSVs in our research archive. Honest
  coverage: **14 report years** carry the clean by-mode Quick-Reference table
  (2007–09, 2012–20, 2023–24); 2010–11 & pre-2007 await GPU re-extraction, 2021–22
  were not surveyed (COVID). Six major modes (subway/auto/bus/rail/bike/tram)
  reconcile **exactly** with NYMTC's own all-modes summary (e.g. 2014 subway
  2,252,428 = NYMTC's 2,252K); ferry excludes the Staten Island Ferry (omitted
  sector) — documented, not silently patched.
- Observatory landing gains a stacked-bar hero chart (contract-compliant: Download
  CSV top-right, legend below). Gap years render as gaps (no fabricated
  continuity). **No live "today" tie-in**: our feeds count subway/bus systemwide,
  not cordon crossings — not comparable to a Hub-Bound entry count, stated plainly.
- Mode-mapping audit trail: `cordon/MODE_MAPPING.json`.

### Medial-axis sidewalk width — alternative estimate (NOT promoted)
- New `analysis/sidewalk/06_medial_axis_width.py` implements Meli Harvey's true
  **Voronoi medial-axis** width method on our planimetric polygons (50,773 polys).
- Validation is honest: **r = 0.727 vs Harvey's published widths** (n = 17,895) —
  **below** the r > 0.75 promotion bar — so the 2A/P proxy stays the **primary**
  width layer, the map `w` channel is unchanged, and width confidence stays
  **🔵 exploratory**. Shipped as an **alternative** download with the full
  comparison (r = 0.94 vs the 2A/P proxy; our median 8.6 ft vs Harvey's 8.1 ft,
  actually nearer Harvey than the proxy's 9.7 ft). Method + decision written into
  the sidewalk METHODS.

### Congestion-pricing framing (Jan 2025)
- Bus methodology tab + route-dossier speed sections carry a dated congestion-
  pricing context block: **NBER w33584** (CBD road speeds **+11%**) and
  **arXiv:2606.17530** (transit gains + spatially-uneven demand), both
  quote-verified. Notes that our 2025+ segment-speed panel is the post-CP era.
  Both papers added to the About sources & credit.

### Downloads
- `/api/downloads` gains `hub_bound_series.{csv,parquet}`, `hub_bound_series_wide.csv`,
  and the medial-axis `medial_axis_width_{segments,polys}.parquet` (alternative
  estimate), each with an honest note.

## 2026-07-23 — Q2.3–2.7 editorial calibration (honesty as a feature)

Certainty, commentary, and reconciliation surfaced site-wide. Verified live
(public site + API serving the new fields; distribution mode rendering at the
current 6-day archive depth).

### League gating (Q2.3)
- `/observatory/leagues` no longer names a "most" or "least" reliable route until
  the archive earns it. Below **14 observed days** the page renders the
  **bunching-index distribution** (a contract-compliant histogram over all
  qualifying routes) + an **unranked, client-sortable per-route table**
  (bunching, headway CV, observed-days per route — no rank column, no winner/loser
  framing) + an explainer that says rankings unlock at 14 days and how many days
  we have. The **Slowest-corridors** table stays in both modes (MTA administrative
  segment-speed data, not archive-gated).
- Auto-flip: the backend now reports `rankings_unlocked` (`archive_depth_days ≥ 14`)
  and a full `distribution` array on `/api/obs/leagues`; the leaderboard renders
  automatically at depth — verified against a mocked 14-day depth. The Observatory
  landing's ranked league cards are gated the same way.

### Reconciliation panels (Q2.4)
- New reusable `ReconciliationNote` ("Our figure vs the authority" — two columns,
  a why-they-differ paragraph, a what-would-close-it line, dated, quiet styling).
- **ACE** (dossier ACE section + methodology bus tab): our ≈0 mph unmatched
  citywide segment difference vs the MTA's reported **+5% average speed-up (up to
  +30%)** on its 39 ACE-enforced routes — reconciled as different estimands
  (unmatched citywide average vs targeted corridor before/after). Cites *MTA ACE
  program materials, 2024–25*.
- **Bus speed** (methodology bus tab, corroboration): our Manhattan ≈6.2 mph vs
  **NYC DOT's 7.44 mph citywide average (2017)** — two independent measurements
  agreeing in magnitude and the Manhattan-slow gradient.

### Know / don't-know panels (Q2.5)
- New reusable `KnowDontKnow` ("What we can say" / "What we can't yet — and what
  would change that"), one per flagship: Observatory, Sidewalks, Renter's Map, and
  the methodology Access section. Each open question names the exact data or method
  that would settle it.

### Research-archive context callouts (Q2.6)
- New reusable `ContextCallout` (quiet soft-surface card: a quote/fact + a "Doc,
  Year" source line naming our research archive), fed by a curated
  `content/kb_callouts.json` of **10 quote-verified passages** from that archive: the Hub-Bound
  1963-onward CBD cordon series (Observatory), the bunching definition and NYC
  DOT's since-2012 bus-speed tracking (Leagues), Vision Zero pedestrian-safety
  context (Sidewalks + SAI), the city's equity framing and the NYC Ferry access
  record (Renter's Map + Access), and Moses / Jacobs / subway network history
  (About). Every quote was checked against its source doc before shipping.

## 2026-07-23 — Q1 map visualization overhaul (dots → centerlines)

Streets become the canvas: sidewalk coverage and bus reliability now read ON the
road lines, not in dots. Verified live (containers serving new dist + retiled
tiles + new endpoints).

### Sidewalk Explorer
- Coverage centerlines are the HERO layer, ON by default, from a vector-tile
  overlay (`/layers/coverage.pmtiles`, Z10–16) via protomaps-leaflet paint rules
  — replacing the multi-MB per-borough GeoJSON fetch (files kept for downloads).
- Deficiency-forward: no-sidewalk = loud red + dashed (CVD redundancy), one-side
  = amber, both-sides = quiet thin green; zoom-scaled widths.
- Width-mode toggle: thickness ∝ √(median sidewalk width) — new `w` attribute
  joined from `02_width_segments` into the tiles (97% of segments measured).
- One-hot color law: SAI is mutually exclusive with hot coverage (coverage →
  neutral hairline when SAI active); SAI ramp swapped viridis → green-free
  magma-style; theme-aware paint; per-layer vintage stamps from the tile sidecar.

### Bus Observatory / dossier
- Reliability ribbon: stop-pair segments colored by within-route speed percentile
  (diverging red→gray→blue); live buses as oriented arrow markers. New additive
  `GET /api/obs/ribbon?route=` (parquet-only; `02_segment_geometry.parquet`).
  Width is color-only — per-segment ridership is not derivable, so none is faked.
- The /bus selected-route line is upgraded to the same ribbon coloring.

### Renter's Map
- Nested 15/30/45/60-min isochrone bands (darkest = nearest); compare mode =
  outlines only (A accent, B violet).

### Ops Wall
- Bunching connector line between the two paired buses (severity color + width);
  pulsing midpoint dot stays. `/api/wall` hotspots now carry both bus positions.

### Palette discipline
- Every ramp run through the dataviz `validate_palette.js` (light + dark); the
  one categorical risk (coverage amber↔green) is covered by the redundant width +
  dash channels.


## 2026-07-23 — Q0 hotfix wave

Refinement-campaign hotfix wave. Small, root-caused fixes; no map-rendering
overhaul (that lands in a later wave). All fixes verified live on
https://nycvisualizer.com.

### Fixed
- **Dark-mode white panels.** Defined the never-defined `--ark-surface` /
  `--ark-border` CSS tokens (aliased to the theming neutrals `--ark-bg-soft` /
  `--ark-line`). ~15 surfaces — hub cards, all Leaflet map controls/legends,
  observatory panels/chips, tables — were falling back to a light literal in
  dark mode. They now theme correctly in both schemes and under the manual
  theme toggle.
- **Renter's Map blank basemap on cold load.** Added `preferCanvas`, a
  `ResizeObserver → invalidateSize()`, and a post-mount re-center tick so the
  map is correctly sized (and its tile grid instantiated) even when it mounts
  before the flex container resolves height.
- **Mobile bus alert overlap.** Collapsed the stacked service-alert callouts
  into a single dismissible "⚠ N service alerts" pill (top-right) that expands
  to a scrollable drawer and never covers the top-left filter control.

### Added
- **Subdomain spoke routing.** On boot, a spoke subdomain root
  (`observatory.` / `ops.` / `renters.` / `changes.`) lands on its spoke path
  instead of the hub; deep/shared URLs are left untouched.
- **`/api/healthz`** health route (edge-reachable; a bare `/healthz` is shadowed
  by the SPA fallback at the edge).

### Changed
- **Typography.** Tabular-nums on data-table numeric cells; stray prose capped
  at a 72ch measure (landing "What this is", methodology intro/outro,
  observatory exclusion caption); methodology intro bumped to 15px; small
  green/amber status numerals darkened to AA-contrast (`#1a7f37` / `#b8860b`);
  Marey diagram gains a "live trip" legend entry and a wider y-axis label gutter
  with middle-truncation.

### Performance
- **Deferred Plotly.** The ~1.49 MB Plotly chunk now mounts via
  IntersectionObserver, so landing first-paint no longer fetches it (verified:
  0 fetches before scroll, 1 after).
- **Warm `/api/wall`.** A 25 s server-side background refresher keeps the Ops
  Wall aggregate warm so a cold visitor gets the cached payload.
- **SSE reconnect.** `streamJSON` now drives its own bounded exponential backoff
  (2 s → 30 s, reset on a good frame) instead of relying on the browser's
  uncontrolled EventSource auto-reconnect, eliminating the
  `/api/rt/vehicles/stream` `ERR_ABORTED` churn.
- **Dossier fetch dedupe.** The SBS "+" sibling dossier is probed only when the
  routes catalog confirms a sibling exists, instead of for every plain route.
- **Long-cache geo assets.** `/layers/*` and `/basemap/*` now serve
  `Cache-Control: public, max-age=86400, immutable` (edge Caddy config).
