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
export const SNAP_FT = 200; // a fresh report >200 ft off the prediction → fast (≤1 s) snap-correct
export const EASE_TAU_MS = 550; // normal ease time-constant toward the predicted offset
export const SNAP_TAU_MS = 220; // fast ease during a snap window (~<1 s to close a big gap)
export const SNAP_EASE_MS = 900; // how long a snap-correct stays in fast-ease mode
export const DWELL_FPS = 2.0; // offset advancing slower than this between reports ⇒ docked/dwelling
export const PRED_ERR_CAP = 4000; // ring-buffer size for between-tick prediction-error samples

// ---- motion trails (F4) ----  [VehicleFlowLayer.ts L86-88]
export const TRAIL_CAP = 12;
export const TRAIL_SAMPLE_MS = 1650; // 12 * 1.65 s ≈ 20 s tail
export const TRAIL_MAX_ALPHA = 0.5; // head of the tail; ramps to 0 at the oldest point
