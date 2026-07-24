// nycviz-flow — the graceful, REVERSIBLE degrade ladder (VERBATIM state machine).
//
// Under sustained frame-budget pressure the renderer sheds work in a fixed order and
// recovers (with hysteresis) when the view is cheap again, so a transient spike never
// permanently freezes the glide. Level ladder:
//   0 full · 1 trails-dropped · 2 30fps · 3 tick-jump
// Trails are the FIRST thing shed (the F4 perf pact); tick-jump is the last resort.
// Extracted verbatim from VehicleFlowLayer.ts L657-691 + the loop pacing L641-655.

import { FRAME_BUDGET_MS } from "./constants";

export class DegradeLadder {
  fpsDivisor = 1; // 1 = full rAF, 2 = ~30 fps
  tickJump = false;
  trailsDropped = false; // degrade ladder shed trails (recovers when cheap)
  private degradedLogged = false;
  frameParity = 0;

  /** Advance the 30 fps frame-pacing parity counter; returns true if this frame should be
   *  SKIPPED for pacing. [VehicleFlowLayer.ts L645-646] */
  shouldSkipForPacing(): boolean {
    this.frameParity = (this.frameParity + 1) % this.fpsDivisor;
    return this.fpsDivisor > 1 && this.frameParity !== 0;
  }

  /** Current ladder level (0 full → 3 tick-jump). [VehicleFlowLayer.ts L664-665] */
  level(trailsEnabled: boolean): number {
    return this.tickJump
      ? 3
      : this.fpsDivisor === 2
        ? 2
        : trailsEnabled && this.trailsDropped
          ? 1
          : 0;
  }

  /** Re-evaluate the ladder from the EMA frame time. Sheds/recovers one step at a time and
   *  logs the FIRST real degrade only. [VehicleFlowLayer.ts L660-691] */
  maybeDegrade(emaMs: number, unitCount: number, trailsEnabled: boolean): void {
    const b = FRAME_BUDGET_MS;
    const before = this.level(trailsEnabled);
    const trailsLive = trailsEnabled && !this.trailsDropped;
    if (emaMs > b * 2.4) {
      this.tickJump = true;
    } else if (emaMs > b) {
      if (trailsLive)
        this.trailsDropped = true; // shed trails BEFORE dropping frame rate
      else if (this.fpsDivisor === 1) this.fpsDivisor = 2; // 60 -> 30 fps
    } else if (emaMs < b * 0.5) {
      // hysteresis recovery: climb back one step at a time (reverse order)
      if (this.tickJump) this.tickJump = false;
      else if (this.fpsDivisor !== 1) this.fpsDivisor = 1;
      else if (this.trailsDropped) this.trailsDropped = false;
    }
    const after = this.level(trailsEnabled);
    if (after !== before && !this.degradedLogged && after > before) {
      // log the first real degrade only (not per-frame; not on recovery)
      this.degradedLogged = true;
      const what = after === 3 ? "tick-jump" : after === 2 ? "30 fps" : "trails-off";
      // eslint-disable-next-line no-console
      console.warn(
        `[VehicleFlowLayer] ${emaMs.toFixed(1)}ms/frame, ${unitCount} units → ` +
          `${what} (auto-recovers when the view is cheaper).`,
      );
    }
  }
}
