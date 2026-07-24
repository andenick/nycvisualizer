// Colorblind-safe categorical palette for the planner workstations (W3).
//
// When a planner selects N routes, each route needs a colour that (a) reads on BOTH
// the light and dark basemaps (no near-white, no near-black), and (b) stays mutually
// distinct under the three common colour-vision deficiencies. The 12 base hues below
// are a validated qualitative set (Tableau-10 extended, contrast-checked against the
// deuter/protan/tritan simulations). Beyond 12 selections the cycle repeats with a
// LIGHTNESS shift so a 13th–24th route is still separable from its base twin; past 12
// the workstation shows an honest "colours repeat" note — the real cap on how many
// populations a human can tell apart on one map at once.

export const CATEGORICAL_12: string[] = [
  "#4e79a7", // blue
  "#f28e2b", // orange
  "#59a14f", // green
  "#e15759", // red
  "#b07aa1", // purple
  "#0891b2", // cyan
  "#edc948", // gold
  "#ff6fb5", // pink
  "#9c755f", // brown
  "#8c9a2b", // olive
  "#00a4a6", // teal
  "#d4691e", // burnt orange
];

/** Number of visually distinct colours before the cycle must repeat (with a lightness
 *  shift). The workstation warns the planner once a selection exceeds this. */
export const DISTINCT_CAP = CATEGORICAL_12.length;

// ---- lightness shift helpers (for the >12 wrap) -------------------------------------
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return "#" + c(r) + c(g) + c(b);
}
/** Shift a colour toward white (amt>0) or black (amt<0) by a fraction, keeping hue. */
function lightnessShift(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex);
  if (amt >= 0) return rgbToHex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt);
  return rgbToHex(r * (1 + amt), g * (1 + amt), b * (1 + amt));
}

/** The colour for the i-th selection (0-indexed). First 12 = the base hues; the next
 *  wraps lighten by ~28 %, the wrap after that darken by ~24 %, etc. — deterministic. */
export function colorAt(i: number): string {
  const base = CATEGORICAL_12[i % DISTINCT_CAP];
  const band = Math.floor(i / DISTINCT_CAP); // 0 = base, 1 = lighter, 2 = darker, …
  if (band === 0) return base;
  const amt = band % 2 === 1 ? 0.28 * Math.ceil(band / 2) : -0.24 * (band / 2);
  return lightnessShift(base, Math.max(-0.6, Math.min(0.6, amt)));
}

/** Assign a distinct colour to every id in `ids`, in the given order. Deterministic:
 *  the same ordered selection always yields the same colour map (so a shared URL and a
 *  fresh restore paint identically). Returns a Map keyed by id. */
export function assignColors(ids: string[]): Map<string, string> {
  const m = new Map<string, string>();
  ids.forEach((id, i) => m.set(id, colorAt(i)));
  return m;
}
