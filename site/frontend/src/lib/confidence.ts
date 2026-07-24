// Confidence taxonomy registry (Q2.1). Every public claim/stat/finding/league row
// that carries a ConfidenceBadge is described HERE — the badge is data-driven, not
// hardcoded per page. Three tiers, applied by a single rule:
//   established  🟢  descriptive fact on complete administrative data
//   preliminary  🟡  short archive / known gap (auto-tied to archive depth where it applies)
//   exploratory  🔵  a proxy / index / weighting choice sits between the data and the claim
//
// Popover fields (the "why this tier"): window (data window / vintage), n (sample
// size), upgrade ("what would upgrade this"). `note` is an optional short qualifier
// some callers render inline next to the stat. `dynamic` flags entries whose window
// text a page overrides at runtime from the live API archive block (archive_depth_days),
// so the badge text updates itself as the archive deepens.
export type ConfidenceTier = "established" | "preliminary" | "exploratory";

export interface ConfidenceEntry {
  tier: ConfidenceTier;
  /** data window / vintage — the "when" behind the number */
  window: string;
  /** sample size / N — the "how much" behind the number */
  n: string;
  /** what would upgrade this claim to a firmer tier */
  upgrade: string;
  /** optional short inline qualifier a caller may show beside the stat */
  note?: string;
  /** window text is expected to be overridden live from the API archive block */
  dynamic?: boolean;
}

export const TIER_META: Record<
  ConfidenceTier,
  { label: string; dot: string; short: string }
> = {
  established: { label: "Established", dot: "🟢", short: "ESTABLISHED" },
  preliminary: { label: "Preliminary", dot: "🟡", short: "PRELIMINARY" },
  exploratory: { label: "Exploratory", dot: "🔵", short: "EXPLORATORY" },
};

export const CONFIDENCE: Record<string, ConfidenceEntry> = {
  // ---------------------------------------------------------------- Observatory
  // Reliability leagues + realtime headline stats: short live archive, auto-tied
  // to depth. Pages pass a live `window` override built from archive_depth_days.
  "obs-leagues": {
    tier: "preliminary",
    window: "live GTFS-RT archive (building toward 14-day depth)",
    n: "qualifying routes only; thin/gap-dominated routes excluded",
    upgrade:
      "≥14 observed days of archive — the badge and named rankings promote themselves at depth.",
    dynamic: true,
  },

  // ---------------------------------------------------------------- Sidewalks
  "sw-coverage": {
    tier: "established",
    window: "DCP planimetric sidewalks, 2022 aerial flight × CSCL",
    n: "96,553 pedestrian street segments (complete network)",
    upgrade:
      "Already a near-complete administrative census; a fresher planimetric flight refreshes vintage.",
  },
  "sw-equity": {
    tier: "established",
    window: "DCP planimetric 2022 × ACS block-group income × 2020 Census population",
    n: "all populated census blocks citywide",
    upgrade:
      "Daytime (worker) population would resolve CBD crowding the nighttime per-capita proxy understates.",
    note: "per-frontage proxy",
  },
  "sw-width": {
    tier: "exploratory",
    window: "DCP planimetric 2022; 2·Area/Perimeter width proxy",
    n: "validated vs max-inscribed width at r = 0.47 (~0.69× inscribed)",
    upgrade:
      "The medial-axis method (Harvey 2020) on the planimetric polygons replaces the area/perimeter proxy — relative signal only until then.",
    note: "relative width only",
  },
  "sw-ramps": {
    tier: "established",
    window: "DOT pedestrian-ramp inventory; slope survey vintage varies by cycle",
    n: "48,717 intersections; 212,194 measured ramps",
    upgrade:
      "Ramp presence is a complete count; per-corner compliance (slope/condition graded to ADA) firms the quality read.",
    note: "presence, not full-corner compliance",
  },

  // Stop Accessibility Index — a weighted percentile composite, reused on the
  // Sidewalk and Renter pages. A weighting choice sits between data and claim.
  "sai-index": {
    tier: "exploratory",
    window: "SAI composite, 2026-07 build (within-NYC percentiles)",
    n: "13,621 bus stops",
    upgrade:
      "The borough gradient is weighting-robust (default vs equal-weight r = 0.85); ground-truthed amenity audits would firm individual mid-rank stops.",
    note: "weighted index — relative, not absolute",
  },

  // ---------------------------------------------------------------- Renters
  "rent-jobs": {
    tier: "established",
    window: "OpenTripPlanner routing, weekday 08:00 (AM-peak snapshot)",
    n: "LODES WAC 2023 jobs; 1,196-cell H3 grid → 37,507 blocks",
    upgrade:
      "Midday/evening departures + commuter rail (LIRR/MNR) and cross-border jobs would round out the all-day picture.",
    note: "AM-peak snapshot",
  },

  // ---------------------------------------------------------------- Ops Wall
  "ops-derived": {
    tier: "preliminary",
    window: "derive2 KPI rollup over the live realtime archive",
    n: "trailing-window derived metrics (bunching / headway deviation)",
    upgrade:
      "≥14 days of continuous archive; the 2026-07-21 poller-suspension gap is excluded, not smoothed.",
    dynamic: true,
  },

  // ---------------------------------------------------------------- Data page
  "data-headways": {
    tier: "preliminary",
    window: "observed from our 31-second GTFS-RT vehicle-position archive",
    n: "route × direction × stop × date × hour; grows daily",
    upgrade:
      "≥14 days of archive firms the reliability figures; arrival = trajectory crossing a stop's shape offset (positional), distinct from a true door-open arrival.",
    dynamic: true,
  },

  // ---------------------------------------------------------------- Reworded claims
  // (documented here so the FINDINGS markers and any future badge share a vocabulary.)
  "bus-recovery": {
    tier: "established",
    window: "MTA bus APC ridership, 2020-01 → 2026-07 (partial 2026)",
    n: "2.4B route-hours of boardings",
    upgrade:
      "The dataset starts in 2020, so no true pre-COVID benchmark exists here; transit_daily_ridership carries the pre-pandemic baseline for that comparison.",
  },
  "sai-crash-gradient": {
    tier: "exploratory",
    window: "NYPD Motor-Vehicle-Collisions pedestrian injuries, 2020+ × DOT demand rank",
    n: "crash COUNTS within 100 ft of ranked segments (not rate-adjusted)",
    upgrade:
      "Normalizing counts by pedestrian volume/exposure converts a count concentration into a genuine rate/safety gap.",
  },
  "acc-income": {
    tier: "established",
    window: "OpenTripPlanner routing, weekday 08:00 (AM-peak snapshot)",
    n: "population-weighted by income decile; 37,507 blocks",
    upgrade:
      "Off-peak departure windows and commuter-rail modes test whether the income gradient holds all day.",
    note: "AM-peak snapshot",
  },
};

/** Build the live "N days observed" window string for archive-tied (dynamic) badges. */
export function archiveWindow(depthDays: number | null | undefined): string {
  if (depthDays == null) return CONFIDENCE["obs-leagues"].window;
  return `${depthDays} day${depthDays === 1 ? "" : "s"} of live archive observed${
    depthDays < 14 ? " (of 14 for full depth)" : ""
  }`;
}
