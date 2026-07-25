// MapThemePicker (W4) — the one control that switches the basemap look.
//
// Deliberately a plain <select>: it lives inside the legend's "Details" fold, it has
// five options, and a native select is the only thing that is reliably reachable by
// touch, keyboard and screen reader inside a floating map panel. The four themes are
// purpose-built, not decorative — the blurb under the control says what each is FOR, so
// the choice is informative rather than a paint-swatch menu.
//
// Changing it writes localStorage and fires `nycv:maptheme` on `document`; every mounted
// basemap listens for that (lib/basemap.ts) and rebuilds itself in place. No page
// reload, no per-surface wiring.

import { useEffect, useState } from "react";
import {
  MAP_THEME_EVENT,
  MAP_THEME_IDS,
  MAP_THEME_LABELS,
  buildMapTheme,
  getMapThemeChoice,
  setMapThemeChoice,
  siteIsDark,
  type MapThemeChoice,
} from "../lib/mapThemes";

export default function MapThemePicker({
  /** what this surface uses when the visitor has never chosen — shown in the "auto"
   *  option's label so the default is not a mystery. */
  surfaceDefault,
  id = "mapThemeSel",
}: {
  surfaceDefault?: MapThemeChoice;
  id?: string;
}) {
  const [choice, setChoice] = useState<MapThemeChoice>(() => getMapThemeChoice());
  const [, tick] = useState(0);

  // keep every mounted picker in sync (two maps can be on screen at once) and re-render
  // the blurb when the site theme flips under an "auto" choice.
  useEffect(() => {
    const sync = () => {
      setChoice(getMapThemeChoice());
      tick((v) => v + 1);
    };
    document.addEventListener(MAP_THEME_EVENT, sync);
    document.addEventListener("ark:themechange", sync);
    return () => {
      document.removeEventListener(MAP_THEME_EVENT, sync);
      document.removeEventListener("ark:themechange", sync);
    };
  }, []);

  const dark = siteIsDark();
  const effective =
    choice === "auto"
      ? surfaceDefault && surfaceDefault !== "auto"
        ? buildMapTheme(surfaceDefault, dark)
        : buildMapTheme(dark ? "night-ops" : "planner-light", dark)
      : buildMapTheme(choice, dark);

  return (
    <span className="mapthemepick">
      <label htmlFor={id}>Map theme</label>
      <select
        id={id}
        value={choice}
        onChange={(e) => {
          const v = e.target.value as MapThemeChoice;
          setChoice(v);
          setMapThemeChoice(v);
        }}
      >
        <option value="auto">{MAP_THEME_LABELS.auto}</option>
        {MAP_THEME_IDS.map((t) => (
          <option key={t} value={t}>
            {MAP_THEME_LABELS[t]}
          </option>
        ))}
      </select>
      <span className="mlg-note">
        {effective.label} — {effective.blurb}
      </span>
    </span>
  );
}
