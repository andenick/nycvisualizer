// Single source of truth for BOROUGH GROUPING — the prefix parser, the colours, the
// labels and the display order — across every borough-grouped UI surface (the /bus
// route filter, the immersive route filter, the map legends' borough swatch rows, the
// workstation's optional borough mode, and the Observatory route picker).
//
// W2 (2026-07-24) moved `routeGroup` / `GROUP_COLORS` / `boroughLabel` here. They were
// duplicated VERBATIM in `pages/ImmersiveMapPage.tsx` and `pages/WorkstationPage.tsx`
// (and a third near-copy in `components/BusMap.tsx`) while this file already declared
// itself the single source of truth for borough grouping. Import from here; do not
// re-declare them.

// ---------------------------------------------------------------------------------
// ORDER
// ---------------------------------------------------------------------------------
// Route-prefix group codes: Bx=Bronx, B=Brooklyn, M=Manhattan, Q=Queens,
// S=Staten Island, SIM=Staten-Island express, X=Manhattan express.
// ALPHABETICAL by borough name, Bronx first — Bronx · Brooklyn · Manhattan · Queens ·
// Staten Island — then the express families last (they are not boroughs).
export const BOROUGH_GROUP_ORDER: string[] = ["Bx", "B", "M", "Q", "S", "SIM", "X"];

// Full borough names (Observatory `borough_group` values). Operators / unknowns
// (e.g. "MTA Bus Co.") sort after the five boroughs.
export const BOROUGH_NAME_ORDER: string[] = [
  "Bronx",
  "Brooklyn",
  "Manhattan",
  "Queens",
  "Staten Island",
  "MTA Bus Co.",
];

// ---------------------------------------------------------------------------------
// THE PARSER
// ---------------------------------------------------------------------------------
/**
 * Group a bus route by its SHORT NAME PREFIX — the way New Yorkers name routes.
 *
 * Evaluated against the full GTFS static universe (345 routes, 2026-07):
 *   Q 122 · B 62 · Bx 57 · M 42 · S 31 · SIM 27 · X 4 = 345, **zero fallbacks**.
 *
 * ⚠️ HONEST LIMIT — say this in any legend that uses these colours. This classifies a
 * route by its prefix ALONE, i.e. by its *home* borough. A Bx route that runs into
 * Manhattan is coloured Bronx along its entire length. There is no per-segment logic
 * anywhere in this codebase and none is planned; the legend wording is therefore
 * "coloured by the route's home borough", never "coloured by borough".
 *
 * ⚠️ Do NOT swap this for the backend's `borough` field. `backend/app/gtfs.py:18-25`
 * derives borough from the owning GTFS feed DIRECTORY, which files 92 routes (27%)
 * under "MTA Bus Co." — an operator, not a borough. The prefix parser is correct.
 */
export function routeGroup(routeId: string): string {
  const up = routeId.toUpperCase();
  if (up.startsWith("BX")) return "Bx"; // Bronx — must precede the bare-B check
  if (up.startsWith("SIM")) return "SIM"; // Staten Island express — precedes S
  if (up.startsWith("X")) return "X"; // Manhattan express
  const c = up.charAt(0);
  return "MBQS".includes(c) ? c : "M";
}

/** Human label for a group code (short enough for a legend swatch row). */
export function boroughLabel(g: string): string {
  return (
    ({
      M: "Manhattan",
      B: "Brooklyn",
      Q: "Queens",
      Bx: "Bronx",
      S: "Staten Island",
      SIM: "SI Express",
      X: "Express",
    } as Record<string, string>)[g] ?? g
  );
}

/** Very short label for tight legend rows (the immersive collapsed legend). */
export function boroughShortLabel(g: string): string {
  return (
    ({ M: "Man", B: "Bklyn", Q: "Qns", Bx: "Bx", S: "SI", SIM: "SI exp", X: "Man exp" } as Record<
      string,
      string
    >)[g] ?? g
  );
}

// ---------------------------------------------------------------------------------
// THE COLOURS  (re-derived 2026-07-24 under CVD simulation — W2.5)
// ---------------------------------------------------------------------------------
// PROVENANCE. Every borough hue below is a member of `lib/palette.ts` CATEGORICAL_12,
// the set already documented as contrast-checked against deuteranopia / protanopia /
// tritanopia. The two express families are the SAME machinery as palette.ts's >12 wrap:
// a +58% lightness shift of their home borough's hue (`lightnessShift`), so an express
// route reads as "a paler <home borough>" — which is exactly what it is.
//
//   Bx  Bronx          gold    #edc948   (CATEGORICAL_12 "gold")
//   B   Brooklyn       brown   #9c755f   (CATEGORICAL_12 "brown" — brownstone)
//   M   Manhattan      blue    #4e79a7   (CATEGORICAL_12 "blue")
//   Q   Queens         teal    #00a4a6   (CATEGORICAL_12 "teal")
//   S   Staten Island  olive   #8c9a2b   (CATEGORICAL_12 "olive" — greenbelt)
//   X   Man. express   #b5c7da  = lighten(M, 0.58)
//   SIM SI express     #cfd5a6  = lighten(S, 0.58)
//
// WHY THE OLD PALETTE WAS REPLACED — measured, not asserted. The previous set
// (M #2563eb · B #16a34a · Q #d97706 · Bx #dc2626 · S #7c3aed · X = SIM #0891b2) was
// not drawn from CATEGORICAL_12 and failed twice:
//   * **Bronx #dc2626 vs Brooklyn #16a34a is the textbook red/green deuteranopia
//     collision** — under simulation they become #898900 and #88884f, CIEDE2000 ΔE00
//     **9.61** (protanopia 17.77). Two of the five boroughs were near-indistinguishable
//     for ~6% of men.
//   * **X and SIM were the identical hex** (#0891b2), ΔE00 **0.00** — the two express
//     families could not be told apart by anyone.
//
// VERIFICATION ACTUALLY PERFORMED — and committed as a re-runnable canary,
// `site/tools/cvd_check.py` (wired into `paint_canary.py`, so a future "tidy-up" that
// reintroduces a collision FAILS the deploy gate rather than shipping silently):
// Brettel-Viénot-Mollon 1999 dichromat projection (sRGB → linear → LMS via the
// Hunt-Pointer-Estevez matrices → project onto the dichromat plane → back), then
// CIELAB + **CIEDE2000** pairwise distance, for all 21 pairs under normal /
// deuteranopia / protanopia / tritanopia vision:
//
//     min ΔE00  normal 17.34 · deutan 12.21 · protan 13.07 · tritan 12.53
//     worst pair overall: Manhattan vs Queens, ΔE00 12.21 under deuteranopia
//
// i.e. the WORST pair in the new palette is ~27% better separated than the worst pair
// in the old one, and the old palette's true worst pair was 0.00. Every colour also
// keeps WCAG contrast ≥ 1.53 against white and ≥ 4.30 against the Night Ops near-black,
// and every vehicle is additionally drawn with a dark contrast outline
// (`flow/core.ts:682`), so the fill carries identity, not detectability.
//
// KNOWN RESIDUAL, stated rather than hidden: SIM #cfd5a6 is pale, so on the light
// "Paper" map theme it separates from the page mostly via that outline (ΔE00 2.33 vs
// the grey earth fill under tritanopia). Acceptable — Paper exists for print/screenshot,
// and 27 of 345 routes are SIM — but it is the weakest cell in the table.
export const GROUP_COLORS: Record<string, string> = {
  Bx: "#edc948",
  B: "#9c755f",
  M: "#4e79a7",
  Q: "#00a4a6",
  S: "#8c9a2b",
  X: "#b5c7da",
  SIM: "#cfd5a6",
};

/** Fallback used when a route id somehow parses to an unknown group (should not
 *  happen — the parser has zero fallbacks over the 345-route GTFS universe). */
export const GROUP_COLOR_FALLBACK = "#6b7280";

/** The colour for a route's home-borough group. */
export function boroughColor(routeId: string): string {
  return GROUP_COLORS[routeGroup(routeId)] ?? GROUP_COLOR_FALLBACK;
}

/** Ordered legend rows: [group code, colour, short label]. */
export const BOROUGH_LEGEND: { g: string; color: string; label: string; short: string }[] =
  BOROUGH_GROUP_ORDER.map((g) => ({
    g,
    color: GROUP_COLORS[g] ?? GROUP_COLOR_FALLBACK,
    label: boroughLabel(g),
    short: boroughShortLabel(g),
  }));

/** The one sentence every borough-coloured legend must carry (see routeGroup's
 *  honest limit). Kept here so all surfaces say the same true thing. */
export const BOROUGH_LEGEND_NOTE =
  "Coloured by the route's home borough (its number prefix) — a Bx route keeps its Bronx colour all the way into Manhattan.";
