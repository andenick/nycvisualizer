// ConfidenceBadge (Q2.1) — the site-wide confidence-taxonomy chip.
//
// A small chip that names its tier (🟢 Established / 🟡 Preliminary / 🔵 Exploratory)
// and, on hover OR tap, opens a popover with the three "why this tier" fields:
// data window/vintage, N, and "what would upgrade this". Every claim it decorates
// is described once in lib/confidence.ts (data-driven, never hardcoded per page).
//
// Accessibility: the tier word is ALWAYS rendered (never color-alone), the dot
// emoji is aria-hidden, and the chip is a real <button> with an aria-label that
// spells out the tier + all three fields for screen readers. Desktop opens the
// popover on hover/focus (CSS); tap toggles it (state) for touch. Theme-aware via
// kit tokens + dark overrides in index.css.
import { useEffect, useId, useRef, useState } from "react";
import { CONFIDENCE, TIER_META, type ConfidenceTier } from "../lib/confidence";

interface Props {
  /** key into lib/confidence.ts */
  claimKey: string;
  /** live override for the data-window text (e.g. archive depth) */
  window?: string;
  /** rare tier override (registry tier is the default) */
  tier?: ConfidenceTier;
  /** hide the tier word in the chip (kept in aria-label); use only in dense rows */
  compact?: boolean;
  className?: string;
}

export default function ConfidenceBadge({ claimKey, window: windowOverride, tier, compact = false, className }: Props) {
  const entry = CONFIDENCE[claimKey];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const popId = useId();

  // close the tapped-open popover on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!entry) return null; // unknown key — fail quiet, never render a broken badge
  const t = tier ?? entry.tier;
  const meta = TIER_META[t];
  const win = windowOverride ?? entry.window;

  const aria =
    `Confidence: ${meta.label}. ` +
    `Data window: ${win}. Sample: ${entry.n}. What would upgrade this: ${entry.upgrade}`;

  return (
    <span className={"conf-badge conf-" + t + (className ? " " + className : "")} ref={ref}>
      <button
        type="button"
        className="conf-chip"
        aria-label={aria}
        aria-expanded={open}
        aria-describedby={popId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="conf-dot" aria-hidden="true">{meta.dot}</span>
        {!compact && <span className="conf-word">{meta.label}</span>}
      </button>
      <span className={"conf-pop" + (open ? " open" : "")} id={popId} role="tooltip">
        <span className="conf-pop-tier">
          <span aria-hidden="true">{meta.dot}</span> {meta.short}
        </span>
        <dl className="conf-pop-fields">
          <dt>Data window</dt>
          <dd>{win}</dd>
          <dt>N</dt>
          <dd>{entry.n}</dd>
          <dt>What would upgrade this</dt>
          <dd>{entry.upgrade}</dd>
        </dl>
      </span>
    </span>
  );
}
