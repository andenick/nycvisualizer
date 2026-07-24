// nycviz-flow — engine constants (extracted VERBATIM from VehicleFlowLayer.ts).
//
// Every true-scale dimension, zoom threshold, easing time-constant, decay/snap rule
// and trail budget the ant farm depends on lives here as a single, testable source of
// truth. Changing any value here changes on-screen motion/geometry — treat as a defect
// unless deliberately re-tuned. (old→new mapping in ../flow/FLOW_ENGINE.md)

// ---- true-scale constants (meters) ----  [VehicleFlowLayer.ts L30-48]
export const BUS_LEN_M = 12;
export const BUS_LEN_SBS_M = 18; // articulated / SBS (optional, when identifiable)
export const BUS_W_M = 2.9;
export const TRAIN_LEN_M = 160;
export const TRAIN_W_M = 3.6;
export const MIN_LEN_PX = 3; // city-zoom clamp — a moving speck, never invisible
export const MIN_W_PX = 1.6;
export const SLAB_ZOOM = 12; // below this: simplified moving specks (veins); 12+ = full shapes
export const LABEL_ZOOM = 13; // subway line-bullet drawn at/above this zoom
export const APPEAR_MS = 480;
export const FADE_MS = 800;
export const STALE_TICKS = 3; // keep a missing unit up to N ticks, then fade + remove
export const FRAME_BUDGET_MS = 12;
export const DEG = Math.PI / 180;
// Nominal report cadence (~30 s ticks). Each new report starts a dead-reckoning glide
// over this duration from the currently-displayed position, so units move continuously
// between ticks instead of snapping.
export const GLIDE_MS = 30000;

// ---- Ant Farm v3 shape-following dead-reckoning ----  [VehicleFlowLayer.ts L58-64]
export const DECAY_S = 45; // ease a stale bus to a stop over ~45 s (sparse-data core rule)
// Hold-last-speed-until-stale (motion-continuity study, 2026-07-24, 14.95M transitions):
// advance at the reported speed WITHOUT decay for up to STALE_S, then the honest decay-to-
// stop engages. The old code decayed from t=0, biasing every moving bus −101 ft/tick toward
// a stop that usually doesn't happen (median correction 92 ft). Holding speed for a normal
// ~31 s tick removes that bias (bias −101 → 0 ft; median correction 92 → 44 ft measured).
export const STALE_S = 40; // hold last speed unbiased up to here; decay-to-stop only beyond
export const SNAP_FT = 200; // a fresh report >200 ft off the prediction → fast (≤1 s) snap-correct
export const EASE_TAU_MS = 550; // normal ease time-constant toward the predicted offset
export const SNAP_TAU_MS = 220; // fast ease during a snap window (~<1 s to close a big gap)
export const SNAP_EASE_MS = 900; // how long a snap-correct stays in fast-ease mode
export const DWELL_FPS = 2.0; // offset advancing slower than this between reports ⇒ docked/dwelling
export const PRED_ERR_CAP = 4000; // ring-buffer size for between-tick prediction-error samples

// ---- per-vehicle report-time anchoring (motion-continuity study, 2026-07-24) ----
// Each unit carries its own report `timestamp` (epoch s); reports are naturally staggered
// across ~23 s of every poll window (σ≈9.6 s over 8.4M rows). The engine anchors each unit's
// motion clock to ITS OWN report time (not the shared poll instant), which kills the
// synchronized citywide "all jump together" pulse with zero backend work.
export const REPORT_ANCHOR_LAG_MS = 0; // newest report in a batch → performance.now() − this.
//   0 = freshest report treated as "now"; older reports in the batch are then dead-reckoned
//   by their true epoch-delta behind it (the median report lands at ≈ its median age without
//   ever over-advancing the freshest — honesty rule #1 preserved, no invented forward motion).
export const CLOCK_DRIFT_CLAMP_MS = 2000; // max epoch→perf offset adjustment per batch (anti-lurch)
export const REPORT_MAX_AGE_MS = 5 * 60 * 1000; // >5 min stale → fall back to poll-time anchor
export const ANCHOR_FUTURE_TOL_MS = 60 * 1000; // >60 s in the future → clock bug → fall back

// ---- motion trails (F4) ----  [VehicleFlowLayer.ts L86-88]
export const TRAIL_CAP = 12;
export const TRAIL_SAMPLE_MS = 1650; // 12 * 1.65 s ≈ 20 s tail
export const TRAIL_MAX_ALPHA = 0.5; // head of the tail; ramps to 0 at the oldest point
