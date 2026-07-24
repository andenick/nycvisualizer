// FlowControls (F4) — the only standing chrome the restrained-enhancements pact
// adds to a live map: a minimal "Following …" pill while follow mode is active,
// and a small "Focused: …" chip while focus-dim is active. Nothing renders when
// neither is on (the not-overcrowding pact). Shared by /bus and /live/*.

export interface FollowInfo {
  label: string; // e.g. "M15"
  sub: string; // e.g. "bus 4821"
}
export interface FocusInfo {
  label: string; // e.g. "M15" or "L"
  kind: "bus" | "train";
}

export default function FlowControls({
  follow,
  onStopFollow,
  onFocusFromFollow,
  focus,
  onClearFocus,
}: {
  follow: FollowInfo | null;
  onStopFollow: () => void;
  onFocusFromFollow: () => void;
  focus: FocusInfo | null;
  onClearFocus: () => void;
}) {
  if (!follow && !focus) return null;
  return (
    <div className="flowctl" role="status" aria-live="polite">
      {follow && (
        <div className="flowctl-pill flowctl-pill--follow">
          <span className="flowctl-live" aria-hidden="true" />
          <span className="flowctl-txt">
            Following <strong>{follow.label}</strong> {follow.sub}
            <span className="flowctl-hint"> — tap map or press ESC to stop</span>
          </span>
          {!focus && (
            <button type="button" className="flowctl-act" onClick={onFocusFromFollow}>
              ◎ Focus
            </button>
          )}
          <button
            type="button"
            className="flowctl-x"
            aria-label="Stop following"
            onClick={onStopFollow}
          >
            ✕
          </button>
        </div>
      )}
      {focus && (
        <div className="flowctl-pill flowctl-pill--focus">
          <span className="flowctl-txt">
            Focused: <strong>{focus.label}</strong>
            <span className="flowctl-hint"> · others dimmed</span>
          </span>
          <button
            type="button"
            className="flowctl-x"
            aria-label="Clear focus"
            onClick={onClearFocus}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
