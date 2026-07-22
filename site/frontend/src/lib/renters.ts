// Renter's Map — shared UI helpers: metric metadata (good-direction + honest
// plain-language phrasing), value formatting, the SAI color ramp, and a tiny
// WKT-polygon parser for the approximate isochrone fallback.
//
// The backend scores carry `higher_is` ("more" of the thing, or "better"
// composite) but that does NOT encode good/bad — more noise is bad, more trees
// is good. So the good-direction lives here, per metric, and every one-liner
// inverts honestly where lower is better ("Quieter than 80% of NYC").
import type { RenterScore, RenterScoreKey } from "./api";

export interface MetricUI {
  title: string;
  /** Is a HIGH citywide percentile the GOOD outcome for this metric? */
  goodWhenHigh: boolean;
  /** Plain-language one-liner. `p` = the good-direction percentile (0-100,
   *  always "better than p% of NYC"). */
  phrase: (p: number) => string;
  /** Render the raw ranked value with its unit. */
  fmtValue: (v: number | null) => string | null;
}

const pct = (v: number | null) => (v == null ? null : `${Math.round(v * 100)}%`);
const num = (v: number | null) => (v == null ? null : Math.round(v).toLocaleString());

export const METRIC_UI: Record<RenterScoreKey, MetricUI> = {
  transit_supply: {
    title: "Bus service",
    goodWhenHigh: true,
    phrase: (p) => `More scheduled bus service than ${p}% of NYC`,
    fmtValue: (v) => (v == null ? null : `${num(v)} AM peak trips within 400 m`),
  },
  transit_access_sai: {
    title: "Stop access",
    goodWhenHigh: true,
    phrase: (p) => `Better stop accessibility than ${p}% of NYC`,
    fmtValue: (v) => (v == null ? null : `best Stop Access Index ${v.toFixed(0)} / 100 nearby`),
  },
  jobs_45min: {
    title: "Jobs reachable",
    goodWhenHigh: true,
    phrase: (p) => `More jobs reachable in 45 min than ${p}% of NYC`,
    fmtValue: (v) => (v == null ? null : `${num(v)} jobs by transit, 8am`),
  },
  noise: {
    title: "Quiet",
    goodWhenHigh: false,
    phrase: (p) => `Quieter than ${p}% of NYC`,
    fmtValue: (v) => (v == null ? null : `${num(v)} 311 noise complaints nearby`),
  },
  sidewalk_complaints: {
    title: "Sidewalk & curb",
    goodWhenHigh: false,
    phrase: (p) => `Fewer sidewalk/curb complaints than ${p}% of NYC`,
    fmtValue: (v) => (v == null ? null : `${num(v)} 311 sidewalk/curb complaints nearby`),
  },
  rodent_failures: {
    title: "Rodent-free",
    goodWhenHigh: false,
    phrase: (p) => `Fewer rodent problems than ${p}% of NYC`,
    fmtValue: (v) => (v == null ? null : `${pct(v)} of nearby inspections failed`),
  },
  pedestrian_crashes: {
    title: "Pedestrian safety",
    goodWhenHigh: false,
    phrase: (p) => `Safer for pedestrians than ${p}% of NYC`,
    fmtValue: (v) => (v == null ? null : `${num(v)} pedestrian-injury crashes nearby`),
  },
  street_trees: {
    title: "Street trees",
    goodWhenHigh: true,
    phrase: (p) => `More street trees than ${p}% of NYC`,
    fmtValue: (v) => (v == null ? null : `${num(v)} street trees within 400 m`),
  },
  sidewalk_coverage: {
    title: "Sidewalk coverage",
    goodWhenHigh: true,
    phrase: (p) => `Better sidewalk coverage than ${p}% of NYC`,
    fmtValue: (v) => (v == null ? null : `${pct(v)} of nearby segments fully covered`),
  },
};

/** Ordered list of metric keys for consistent scorecard rendering. */
export const METRIC_ORDER: RenterScoreKey[] = [
  "transit_supply",
  "transit_access_sai",
  "jobs_45min",
  "noise",
  "pedestrian_crashes",
  "rodent_failures",
  "sidewalk_coverage",
  "sidewalk_complaints",
  "street_trees",
];

/** Good-direction percentile: always "better than N% of NYC" (0-100), or null. */
export function goodPercentile(key: RenterScoreKey, s: RenterScore): number | null {
  if (s.percentile == null) return null;
  const g = METRIC_UI[key].goodWhenHigh ? s.percentile : 100 - s.percentile;
  return Math.round(g);
}

/** Viridis-ish colorblind-safe ramp for a 0..100 SAI/percentile value.
 *  (Mirrors SidewalkMap.saiColor so stop dots read consistently across the site.) */
export function saiColor(v: number): string {
  const stops: [number, string][] = [
    [0, "#440154"],
    [25, "#3b528b"],
    [50, "#21918c"],
    [75, "#5ec962"],
    [100, "#fde725"],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [v0, c0] = stops[i - 1];
      const [v1, c1] = stops[i];
      const t = (v - v0) / (v1 - v0);
      const p = (c: string) => [1, 3, 5].map((j) => parseInt(c.slice(j, j + 2), 16));
      const a = p(c0);
      const b = p(c1);
      const mix = a.map((x, j) => Math.round(x + (b[j] - x) * t));
      return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
    }
  }
  return "#fde725";
}

/** Parse a WKT POLYGON / MULTIPOLYGON into Leaflet [lat,lon] ring arrays.
 *  Used only for the approximate isochrone fallback (which returns geom_wkt in
 *  EPSG:4326 lon/lat). Returns an array of polygons, each an array of rings. */
export function wktToLatLngs(wkt: string): [number, number][][][] {
  const kind = wkt.trim().toUpperCase();
  const isMulti = kind.startsWith("MULTIPOLYGON");
  if (!isMulti && !kind.startsWith("POLYGON")) return [];
  const parseRing = (s: string): [number, number][] =>
    s
      .trim()
      .split(",")
      .map((pair) => {
        const [lon, lat] = pair.trim().split(/\s+/).map(Number);
        return [lat, lon] as [number, number];
      })
      .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
  // Grab each parenthesized ring "(x y, x y, ...)".
  const rings = [...wkt.matchAll(/\(([-0-9.eE\s,]+)\)/g)].map((m) => parseRing(m[1]));
  if (!rings.length) return [];
  // For our purpose (fill the reachable blob), treating every ring as its own
  // polygon shell is visually correct; holes are negligible for a coverage blob.
  return isMulti ? rings.map((r) => [r]) : [[rings[0]]];
}
