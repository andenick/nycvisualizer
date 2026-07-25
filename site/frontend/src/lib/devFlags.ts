// Dev-only display flags (W5 P2, 2026-07-24).
//
// Frame-time / fps / prediction-error readouts are ENGINEERING telemetry. They were
// shipping in the public UI ("12.3 ms/frame (tick-jump)") on /bus and /live/*, where a
// non-technical planner reads them as a defect report about their own machine. They are
// still valuable — the perf harness reads them — so they are not deleted, only gated.
//
// Visible when EITHER:
//   * the URL carries ?perf   (the same opt-in hook the harness already uses to expose
//     window.__nycvFlow / window.__nycvMap), or
//   * the build is a dev build (import.meta.env.DEV).
//
// Evaluated once per page load; the harness sets ?perf before navigation.

let _perf: boolean | null = null;

export function perfVisible(): boolean {
  if (_perf !== null) return _perf;
  let flag = false;
  try {
    flag = new URLSearchParams(window.location.search).has("perf");
  } catch {
    flag = false;
  }
  _perf = flag || Boolean(import.meta.env?.DEV);
  return _perf;
}
