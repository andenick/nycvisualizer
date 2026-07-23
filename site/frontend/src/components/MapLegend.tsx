// MapLegend — the one shared, collapsible corner "Legend" chip for every map
// surface (ArkMap-stamped). A dumb container: each surface composes its own rows
// (true-scale shapes line · color meanings w/ swatches · motion semantics · state
// row) and folds its data-vintage / as-of stamps in via `stamps`. Collapsed by
// default on immersive /live/* pages; expanded-by-default elsewhere. Keep `items`
// to <= 8 lines (the "not crowded" pact); overflow goes behind the details expander.

import { useState, type ReactNode, type CSSProperties } from "react";

export interface MapLegendProps {
  /** Visible content rows — keep to <= 8 for the "not crowded" pact. */
  items: ReactNode[];
  /** Extra rows revealed by a "Details" expander (sources, per-layer notes). */
  details?: ReactNode[];
  /** Compact vintage / as-of / attribution block, folded into the legend foot. */
  stamps?: ReactNode;
  /** Collapsed by default on immersive /live/* pages; expanded elsewhere. */
  defaultOpen?: boolean;
  /** Extra positioning/variant class, e.g. "maplegend--imm". */
  className?: string;
  title?: string;
}

export default function MapLegend({
  items,
  details,
  stamps,
  defaultOpen = false,
  className = "",
  title = "Legend",
}: MapLegendProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [detOpen, setDetOpen] = useState(false);
  const visible = items.filter(Boolean);
  return (
    <div className={"maplegend" + (open ? " open" : "") + (className ? " " + className : "")}>
      <button
        type="button"
        className="maplegend-chip"
        aria-expanded={open}
        aria-label={open ? "Hide map legend" : "Show map legend"}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="maplegend-chip-ic" aria-hidden="true">▤</span>
        <span className="maplegend-chip-txt">{title}</span>
        <span className="maplegend-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="maplegend-body" role="region" aria-label="Map legend">
          {visible.map((it, i) => (
            <div className="maplegend-row" key={i}>
              {it}
            </div>
          ))}
          {details && details.filter(Boolean).length > 0 && (
            <div className="maplegend-det">
              <button
                type="button"
                className="maplegend-detbtn"
                aria-expanded={detOpen}
                onClick={() => setDetOpen((v) => !v)}
              >
                {detOpen ? "▾ Hide details" : "▸ Details"}
              </button>
              {detOpen &&
                details.filter(Boolean).map((it, i) => (
                  <div className="maplegend-row" key={i}>
                    {it}
                  </div>
                ))}
            </div>
          )}
          {stamps && <div className="maplegend-stamps">{stamps}</div>}
        </div>
      )}
    </div>
  );
}

// ---- shared presentational atoms (one visual vocabulary across every surface) ----

export type SwatchShape = "dot" | "sq" | "line" | "ring";
export function Swatch({
  color,
  shape = "dot",
  faded = false,
  style,
}: {
  color: string;
  shape?: SwatchShape;
  faded?: boolean;
  style?: CSSProperties;
}) {
  const s: CSSProperties =
    shape === "ring" ? { borderColor: color, ...style } : { background: color, ...style };
  return <span className={"mlg-sw mlg-sw--" + shape + (faded ? " mlg-faded" : "")} style={s} />;
}

/** A small subway line bullet (official color) for the color-meanings row. */
export function Bullet({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <span className="mlg-bullet" style={{ background: bg, color: fg }}>
      {label}
    </span>
  );
}
