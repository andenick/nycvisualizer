// MAP THEMES (W4, 2026-07-24) — four purpose-built basemap looks, plus the user's
// choice of them.
//
// WHY THIS FILE EXISTS AT ALL, AND WHY IT IS CHEAP NOW.
//   On protomaps-leaflet **4.1.1** this was painful: the `themes` record was not
//   exported, the package `exports` map blocked deep imports, and you had to hand-roll
//   an 81-field Theme *and* re-author ~32 paint + 9 label rules. On **5.1.0** (what W0
//   put us on) `@protomaps/basemaps@5` exports LIGHT / DARK / WHITE / GRAYSCALE / BLACK
//   as plain `Flavor` objects, and protomaps-leaflet exports the `paintRules(flavor)` /
//   `labelRules(flavor, lang)` generators. So a theme is: spread a base flavor, override
//   the fields you care about, regenerate the rules. That is all this file does.
//
// HOW IT PLUGS IN — and the one trap.
//   `leafletLayer()` treats `flavor:` and `paintRules:`/`labelRules:` as MUTUALLY
//   EXCLUSIVE (leaflet_layer.ts: `if (options.flavor) {…} else {…}`). Passing a custom
//   theme therefore means passing explicit rules and NOT passing `flavor`. That does not
//   revive the pre-W0 bug: the empty-rules failure came from an *unknown option name*
//   yielding empty arrays, and `lib/basemap.ts` guard (1) still asserts that road paint
//   AND label rules exist in whatever we hand it.
//
// TOKENS (ARKMAP_STANDARD §7). Map *chrome* — panels, legend, popups — stays on the
// site-kit `--ark-*` tokens and is untouched here. This file only styles the basemap
// itself. Thematic data ramps (coverage, SAI, borough bus colours) are chosen for
// colourblind-safety in their own modules and stated in the legend; a map theme never
// recolours data.

import {
  LIGHT,
  DARK,
  GRAYSCALE,
  type Flavor,
} from "@protomaps/basemaps";
import {
  paintRules as pmPaintRules,
  labelRules as pmLabelRules,
  type LabelRule,
  type PaintRule,
} from "protomaps-leaflet";

export type MapThemeId = "planner-light" | "night-ops" | "paper" | "focus";
/** "auto" = follow the site's light/dark theme (Planner Light / Night Ops). */
export type MapThemeChoice = MapThemeId | "auto";

export const MAP_THEME_STORAGE_KEY = "nycv-map-theme";
/** Fired on `document` when the user picks a different map theme. */
export const MAP_THEME_EVENT = "nycv:maptheme";

// ---------------------------------------------------------------------------------
// tiny colour helpers (hex or `rgba(r, g, b, a)` — the landcover fields use rgba)
// ---------------------------------------------------------------------------------
type RGBA = { r: number; g: number; b: number; a: number };

function parseColor(c: string): RGBA | null {
  const s = c.trim();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (h.length === 6) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: 1,
      };
    }
    if (h.length === 3) {
      return {
        r: parseInt(h[0] + h[0], 16),
        g: parseInt(h[1] + h[1], 16),
        b: parseInt(h[2] + h[2], 16),
        a: 1,
      };
    }
    return null;
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return null;
  const p = m[1].split(",").map((v) => parseFloat(v.trim()));
  if (p.length < 3 || p.some((v) => Number.isNaN(v))) return null;
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}

function fmt(c: RGBA): string {
  const b = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  if (c.a >= 1) return "#" + [c.r, c.g, c.b].map((v) => b(v).toString(16).padStart(2, "0")).join("");
  return `rgba(${b(c.r)}, ${b(c.g)}, ${b(c.b)}, ${c.a})`;
}

/** Perceived luminance (Rec. 709), 0..255. */
function grayOf(c: RGBA): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Pull a colour `amt` (0..1) of the way toward its own gray — hue survives, chroma dies. */
function desaturate(color: string, amt: number): string {
  const c = parseColor(color);
  if (!c) return color;
  const g = grayOf(c);
  return fmt({ r: c.r + (g - c.r) * amt, g: c.g + (g - c.g) * amt, b: c.b + (g - c.b) * amt, a: c.a });
}

/** Mix toward a target colour by `t` (0..1). */
function mix(color: string, toward: string, t: number): string {
  const a = parseColor(color);
  const b = parseColor(toward);
  if (!a || !b) return color;
  return fmt({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a });
}

/** Keys of a Flavor that are NOT colours (font family names). Never transform these. */
const NON_COLOR_KEYS = new Set(["regular", "bold", "italic"]);

/** Apply `fn` to every colour field of a flavor, including the nested `pois` /
 *  `landcover` maps. Returns a new Flavor; the input is never mutated. */
function mapFlavorColors(flavor: Flavor, fn: (c: string, key: string) => string): Flavor {
  const out = { ...flavor } as Record<string, unknown>;
  for (const [k, v] of Object.entries(flavor)) {
    if (NON_COLOR_KEYS.has(k)) continue;
    if (typeof v === "string") {
      out[k] = fn(v, k);
    } else if (v && typeof v === "object") {
      const nested: Record<string, string> = {};
      for (const [nk, nv] of Object.entries(v as Record<string, string>)) {
        nested[nk] = typeof nv === "string" ? fn(nv, `${k}.${nk}`) : nv;
      }
      out[k] = nested;
    }
  }
  return out as unknown as Flavor;
}

// ---------------------------------------------------------------------------------
// THE FOUR THEMES
// ---------------------------------------------------------------------------------

/** PLANNER LIGHT — the workstation default in light mode.
 *  Street legibility IS the job here: white road fills over darker casings so the grid
 *  reads as a grid, labels pushed well past protomaps LIGHT's very pale #91888b, and
 *  landuse muted so parks/hospitals/schools stop competing with the network. */
function plannerLight(): Flavor {
  const muted = (c: string) => desaturate(c, 0.55);
  return {
    ...LIGHT,
    background: "#e9e7e1",
    earth: "#f7f6f2",
    buildings: "#e4e0d8",
    water: "#c3dbe6",
    // landuse: keep the category readable, drop the saturation
    park_a: muted(LIGHT.park_a),
    park_b: muted(LIGHT.park_b),
    wood_a: muted(LIGHT.wood_a),
    wood_b: muted(LIGHT.wood_b),
    scrub_a: muted(LIGHT.scrub_a),
    scrub_b: muted(LIGHT.scrub_b),
    hospital: "#efe7e6",
    school: "#efeae2",
    industrial: "#e7ecee",
    pedestrian: "#efece1",
    zoo: "#e2ebeb",
    military: "#e8e8e8",
    // roads — white ribbons, darker casings, so the grid reads at every zoom
    other: "#ffffff",
    minor_service: "#ffffff",
    minor_a: "#ffffff",
    minor_b: "#ffffff",
    link: "#ffffff",
    major: "#ffffff",
    highway: "#ffffff",
    minor_service_casing: "#d3cfc5",
    minor_casing: "#cbc6ba",
    link_casing: "#b3aca0",
    major_casing_early: "#ada699",
    major_casing_late: "#ada699",
    highway_casing_early: "#948c7e",
    highway_casing_late: "#948c7e",
    bridges_other: "#ffffff",
    bridges_minor: "#ffffff",
    bridges_link: "#ffffff",
    bridges_major: "#ffffff",
    bridges_highway: "#ffffff",
    railway: "#b6b0a4",
    boundaries: "#9b958a",
    // labels — prominent, which protomaps LIGHT deliberately is not
    roads_label_minor: "#4a463f",
    roads_label_minor_halo: "#ffffff",
    roads_label_major: "#2c2924",
    roads_label_major_halo: "#ffffff",
    subplace_label: "#5f5b53",
    subplace_label_halo: "#ffffff",
    city_label: "#33302a",
    city_label_halo: "#ffffff",
    // W3: deliberately lighter than roads_label_minor (#4a463f) — house numbers are the
    // densest label class on the map (1,213 candidates in one Midtown z15 tile) and must
    // sit UNDER the street names in the reading order, not compete with them.
    address_label: "#8b857a",
    address_label_halo: "#ffffff",
  };
}

/** NIGHT OPS — the ops wall and the ant farms.
 *  Near-black so a moving vehicle is the brightest thing on screen; road casings all but
 *  gone; minor street NAMES suppressed entirely (see `labelPolicy: "minimal"`), major
 *  ones kept dim for orientation. */
function nightOps(): Flavor {
  const sink = (c: string) => mix(desaturate(c, 0.55), "#080a0e", 0.62);
  return {
    ...mapFlavorColors(DARK, (c, k) => (k.includes("label") ? c : sink(c))),
    background: "#05060a",
    earth: "#0a0c10",
    buildings: "#111419",
    water: "#0a1220",
    pier: "#12151a",
    // roads: a quiet grey skeleton, casings merged into the earth
    other: "#1e222a",
    minor_service: "#1e222a",
    minor_a: "#272c35",
    minor_b: "#22262e",
    link: "#333a46",
    major: "#333a46",
    highway: "#3f4753",
    minor_service_casing: "#0a0c10",
    minor_casing: "#0a0c10",
    link_casing: "#0a0c10",
    major_casing_early: "#0a0c10",
    major_casing_late: "#0a0c10",
    highway_casing_early: "#0a0c10",
    highway_casing_late: "#0a0c10",
    bridges_other: "#1e222a",
    bridges_minor: "#22262e",
    bridges_link: "#333a46",
    bridges_major: "#333a46",
    bridges_highway: "#3f4753",
    railway: "#191d24",
    boundaries: "#3a424f",
    roads_label_minor: "#59616d",
    roads_label_minor_halo: "#05060a",
    roads_label_major: "#8b95a3",
    roads_label_major_halo: "#05060a",
    subplace_label: "#59616d",
    subplace_label_halo: "#05060a",
    city_label: "#8b95a3",
    city_label_halo: "#05060a",
    ocean_label: "#3f4753",
    // W3: dimmer than roads_label_major — secondary annotation, not a headline.
    address_label: "#565e69",
    address_label_halo: "#05060a",
  };
}

/** PAPER — screenshots, print, embedding in a report. Every field forced to its own
 *  gray, then lightened, so the map survives a black-and-white printer and never fights
 *  a thematic overlay for hue. */
function paper(): Flavor {
  const gray = mapFlavorColors(GRAYSCALE, (c, k) => {
    const p = parseColor(c);
    if (!p) return c;
    const g = grayOf(p);
    // lighten the field, keep the labels dark
    if (k.includes("label") && !k.includes("halo")) return fmt({ r: g * 0.35, g: g * 0.35, b: g * 0.35, a: p.a });
    return fmt({ r: 255 - (255 - g) * 0.55, g: 255 - (255 - g) * 0.55, b: 255 - (255 - g) * 0.55, a: p.a });
  });
  return {
    ...gray,
    background: "#ffffff",
    earth: "#f8f8f6",
    buildings: "#e6e5e1",
    water: "#ececeb",
    other: "#ffffff",
    minor_service: "#ffffff",
    minor_a: "#ffffff",
    minor_b: "#ffffff",
    link: "#ffffff",
    major: "#ffffff",
    highway: "#ffffff",
    minor_service_casing: "#cfcecb",
    minor_casing: "#c6c5c2",
    link_casing: "#a8a7a4",
    major_casing_early: "#9d9c99",
    major_casing_late: "#9d9c99",
    highway_casing_early: "#807f7c",
    highway_casing_late: "#807f7c",
    roads_label_minor: "#4a4a48",
    roads_label_minor_halo: "#ffffff",
    roads_label_major: "#232322",
    roads_label_major_halo: "#ffffff",
    city_label: "#232322",
    city_label_halo: "#ffffff",
    subplace_label: "#4a4a48",
    subplace_label_halo: "#ffffff",
    address_label: "#7e7e7b",
    address_label_halo: "#ffffff",
  };
}

/** FOCUS — for any surface with a thematic overlay (sidewalk coverage, SAI, renter
 *  scores). The basemap is desaturated almost to neutral and its contrast compressed, so
 *  the DATA carries every hue on the screen. Follows the site's light/dark theme. */
function focus(dark: boolean): Flavor {
  const base = dark ? nightOps() : plannerLight();
  const ground = dark ? "#0a0c10" : "#f4f3f0";
  return mapFlavorColors(base, (c, k) => {
    const flat = desaturate(c, 0.92);
    if (k.includes("label")) return k.includes("halo") ? flat : mix(flat, ground, dark ? 0.28 : 0.34);
    return mix(flat, ground, 0.42);
  });
}

// ---------------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------------
export interface MapThemeDef {
  id: MapThemeId;
  /** user-facing name */
  label: string;
  /** one line the legend / picker can show */
  blurb: string;
  /** whether map CHROME should read this as a dark or light surface */
  tone: "dark" | "light";
  /** built flavor for the current site theme */
  flavor: Flavor;
  /** "minimal" drops minor street NAMES (ops-wall density); "full" keeps everything */
  labelPolicy: "full" | "minimal";
}

export function buildMapTheme(id: MapThemeId, siteDark: boolean): MapThemeDef {
  switch (id) {
    case "night-ops":
      return {
        id,
        label: "Night Ops",
        blurb: "Near-black, minimal labels — maximum vehicle contrast for the ops wall.",
        tone: "dark",
        flavor: nightOps(),
        labelPolicy: "minimal",
      };
    case "paper":
      return {
        id,
        label: "Paper",
        blurb: "Grayscale, for screenshots, print and report figures.",
        tone: "light",
        flavor: paper(),
        labelPolicy: "full",
      };
    case "focus":
      return {
        id,
        label: "Focus",
        blurb: "Desaturated basemap so a thematic overlay carries all the colour.",
        tone: siteDark ? "dark" : "light",
        flavor: focus(siteDark),
        labelPolicy: "full",
      };
    case "planner-light":
    default:
      return {
        id: "planner-light",
        label: "Planner Light",
        blurb: "High-contrast streets and prominent labels — street legibility is the job.",
        tone: "light",
        flavor: plannerLight(),
        labelPolicy: "full",
      };
  }
}

/** Menu order for the picker. `auto` is prepended by the component. */
export const MAP_THEME_IDS: MapThemeId[] = ["planner-light", "night-ops", "paper", "focus"];

export const MAP_THEME_LABELS: Record<MapThemeChoice, string> = {
  auto: "Match site theme",
  "planner-light": "Planner Light",
  "night-ops": "Night Ops",
  paper: "Paper",
  focus: "Focus",
};

// ---------------------------------------------------------------------------------
// user choice (persisted + event-driven, mirroring the site's own `ark:themechange`)
// ---------------------------------------------------------------------------------
export function siteIsDark(): boolean {
  if (typeof document !== "undefined") {
    const a = document.documentElement.getAttribute("data-theme");
    if (a === "dark") return true;
    if (a === "light") return false;
  }
  return (
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
}

/** The user's EXPLICIT choice, or null if they have never picked one. The null case is
 *  what lets a surface supply its own sensible default (the thematic-overlay maps
 *  default to Focus) without overriding somebody who has actually chosen. */
export function getStoredMapThemeChoice(): MapThemeChoice | null {
  try {
    const v = localStorage.getItem(MAP_THEME_STORAGE_KEY);
    if (v === "auto" || (v && (MAP_THEME_IDS as string[]).includes(v))) return v as MapThemeChoice;
  } catch {
    /* storage blocked */
  }
  return null;
}

export function getMapThemeChoice(): MapThemeChoice {
  return getStoredMapThemeChoice() ?? "auto";
}

export function setMapThemeChoice(choice: MapThemeChoice): void {
  try {
    localStorage.setItem(MAP_THEME_STORAGE_KEY, choice);
  } catch {
    /* storage blocked — the event still moves every live map this session */
  }
  if (typeof document !== "undefined") {
    document.dispatchEvent(new CustomEvent(MAP_THEME_EVENT, { detail: { choice } }));
  }
}

/** Resolve to a concrete theme.
 *
 *  Precedence: the user's EXPLICIT choice > the surface's default > "auto".
 *  "auto" means Planner Light in a light site theme and Night Ops in a dark one — so
 *  out of the box the ant farms and the ops wall get Night Ops on a dark site and the
 *  workstation gets Planner Light on a light one, which is what each was designed for.
 *
 *  `surfaceDefault` is a DEFAULT, not a pin: `/sidewalks` and `/renters` pass "focus"
 *  because a desaturated basemap is right when a thematic ramp owns the colour budget,
 *  but a planner who has picked Paper still gets Paper everywhere. */
export function resolveMapTheme(surfaceDefault?: MapThemeChoice): MapThemeDef {
  const dark = siteIsDark();
  const choice = getStoredMapThemeChoice() ?? surfaceDefault ?? "auto";
  if (choice === "auto") return buildMapTheme(dark ? "night-ops" : "planner-light", dark);
  return buildMapTheme(choice, dark);
}

// ---------------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------------
/** The generated paint rules for a theme. Structurally identical to the ones
 *  `flavor: "light"|"dark"` would produce — same generator, same filters — so
 *  `site/tools/rule_canary.mjs` still speaks for these. Only the colours differ. */
export function themePaintRules(theme: MapThemeDef): PaintRule[] {
  return pmPaintRules(theme.flavor);
}

/** The generated label rules for a theme, after the theme's label policy.
 *
 *  "minimal" drops exactly one rule: the `roads` rule gated at minzoom 16, which is
 *  protomaps' MINOR street-name rule. Major/arterial names (the two minzoom-12 road
 *  rules), water, and place labels are all kept — an ops wall still needs to know which
 *  avenue it is looking at. Verified against the 9 rules protomaps-leaflet 5.1.0
 *  emits: roads@16, roads@12, roads@12, water, water, places, places, places@9,
 *  places(max 8). */
export function themeLabelRules(theme: MapThemeDef, lang = "en"): LabelRule[] {
  const rules = pmLabelRules(theme.flavor, lang);
  if (theme.labelPolicy !== "minimal") return rules;
  return rules.filter((r) => !(r.dataLayer === "roads" && r.minzoom === 16));
}
