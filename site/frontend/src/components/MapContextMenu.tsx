// W11 — the map context menu. The workstation had NO context menu at all before this
// (verified: zero occurrences of `contextmenu` / `button === 2` in site/frontend/src),
// so right-click was entirely free.
//
// Grammar taken from the two independent confirmations in the research: Google Maps and
// CalTopo BOTH put measure in a right-click menu, and BOTH lead that menu with the
// identity of what you clicked — Google with the raw coordinate, CalTopo with the
// coordinate plus a "Measure Here" header group. We lead with the **stop**, because a
// named stop with a code is a fact about the network and a dropped pin on a sidewalk is
// not. And the menu is **mode-sensitive** (Google's single best idea): while measuring,
// the same gesture that started the tool extends and ends it.
//
// This is NOT the only door. A visible `⟷ Measure` button exists in the stop tray,
// because Google Maps mobile web has no measure tool at all (verified on an emulated
// Pixel 7) — there is no precedent to copy for touch, and right-click is undiscoverable
// to a non-technical planner. The button is the primary door; this is the fast one.

import { useEffect, useRef } from "react";

export interface ContextTarget {
  lat: number;
  lon: number;
  /** Snapped stop, if the right-click landed within the snap radius of one. */
  stopKey: string | null;
  stopId: string | null;
  stopName: string | null;
  routes: string[];
  alreadySelected: boolean;
}

export interface MapContextMenuProps {
  /** Container-relative pixel position of the click (menu's top-left anchor). */
  x: number;
  y: number;
  target: ContextTarget;
  measuring: boolean;
  onAddAndMeasure: () => void;
  onAdd: () => void;
  onRemove: () => void;
  onUndo: () => void;
  onClear: () => void;
  onCopyCoords: () => void;
  onClose: () => void;
}

export default function MapContextMenu(p: MapContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // The dismiss callback goes through a ref so the listeners below can be registered
  // ONCE, with an empty dependency list.
  //
  // This is not tidiness — it was a real, measured bug. With `[p]` as the dependency the
  // effect tore down and re-registered on every parent render, and the parent re-renders
  // inside its OWN document `keydown` handler (React flushes discrete events
  // synchronously). Per the DOM spec a listener removed *during* a dispatch is skipped
  // for that dispatch, so pressing Escape removed this listener before it was reached and
  // the menu never closed — verified in a browser: Escape left measure mode but left the
  // menu on screen. Registering once fixes it.
  const closeRef = useRef(p.onClose);
  closeRef.current = p.onClose;

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    // `capture` so the map's own click handler cannot swallow the dismiss.
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", esc);
    };
  }, []);

  const t = p.target;
  const onStop = !!t.stopKey;

  return (
    <div
      ref={ref}
      className="mctx"
      role="menu"
      style={{ left: Math.round(p.x), top: Math.round(p.y) }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Lead with WHAT YOU CLICKED, before offering any verb. */}
      <div className="mctx-head">
        <div className="mctx-head-name">{onStop ? t.stopName : "Map point"}</div>
        <div className="mctx-head-sub">
          {onStop ? (
            <>
              <span className="mctx-code">{t.stopId}</span>
              {t.routes.length ? " · " + t.routes.join(" · ") : ""}
            </>
          ) : (
            `${t.lat.toFixed(6)}, ${t.lon.toFixed(6)}`
          )}
        </div>
      </div>
      <div className="mctx-items">
        {onStop && !p.measuring && (
          <button type="button" role="menuitem" className="mctx-item" onClick={p.onAddAndMeasure}>
            Measure distance from here
          </button>
        )}
        {onStop && p.measuring && !t.alreadySelected && (
          <button type="button" role="menuitem" className="mctx-item" onClick={p.onAdd}>
            Measure to here
          </button>
        )}
        {onStop && t.alreadySelected && (
          <button type="button" role="menuitem" className="mctx-item" onClick={p.onRemove}>
            Remove this stop
          </button>
        )}
        {onStop && !t.alreadySelected && !p.measuring && (
          <button type="button" role="menuitem" className="mctx-item" onClick={p.onAdd}>
            Add stop card
          </button>
        )}
        {p.measuring && (
          <>
            <button type="button" role="menuitem" className="mctx-item" onClick={p.onUndo}>
              Undo last stop
            </button>
            <button type="button" role="menuitem" className="mctx-item" onClick={p.onClear}>
              Clear measurement
            </button>
          </>
        )}
        <button type="button" role="menuitem" className="mctx-item" onClick={p.onCopyCoords}>
          Copy coordinates
        </button>
        {!onStop && (
          <div className="mctx-note">
            No stop within reach of that click. Measuring snaps to bus stops and subway
            stations only — free map points are deliberately not offered, because a
            distance between two sidewalk pixels is not a fact about the network.
          </div>
        )}
      </div>
    </div>
  );
}
