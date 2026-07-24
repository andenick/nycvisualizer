#!/usr/bin/env node
/**
 * RULE-MATCH CANARY for the nycvisualizer basemap.
 *
 * WHY THIS EXISTS (read before deleting it):
 *   Between the z15b basemap deploy and 2026-07-24 the site shipped a basemap with
 *   NO ROADS AND NO STREET LABELS, in production, for weeks — and every guard passed.
 *   The bundled protomaps-leaflet 4.1.1 default style filtered on the Protomaps **v2**
 *   schema property `pmap:kind`, while the shipped tileset is **v4.15.0**, whose property
 *   is a bare `kind`. Every road, landuse and place rule therefore evaluated false:
 *   72 road features in a Midtown z15 tile -> 0 rule matches. The "street grid" people
 *   saw was the negative space between building footprints.
 *
 *   `paint_canary.py` could not see this, and no pixel-counting canary ever can: buildings,
 *   landuse and water DO match and DO paint, so painted-pixel counts stay healthy while an
 *   entire feature class is missing. (protomaps-leaflet 5.x makes this strictly worse for
 *   pixel checks — it fills each tile with `flavor.background` before painting anything.)
 *
 *   The only thing that catches a schema mismatch is decoding a REAL tile from the REAL
 *   shipped archive and running the REAL style filters over the REAL features, then
 *   asserting the match count is non-zero. That is this script.
 *
 * WHAT IT CHECKS
 *   For one known tile (default: Midtown Manhattan, the z16 acceptance view):
 *     * the archive is reachable and the tile decodes;
 *     * for every required dataLayer, the shipped paint/label rules MATCH > 0 features;
 *     * named streets specifically produce label matches (street NAMES, not just casings).
 *   Runs for every flavor the app can select (light + dark) — a flavor-specific style
 *   regression is a real possibility.
 *
 * SCOPE, STATED HONESTLY. The rules come from the WORKING TREE's installed protomaps-leaflet
 * (`frontend/node_modules`); the tiles come from whatever SOURCE you point it at. So it
 * answers "does the style we are about to ship agree with the tileset that is being served?"
 * It does NOT re-extract the rules from the deployed JS bundle, so it cannot by itself prove
 * the box is running the build you just made — the deploy's own asset-hash check does that.
 *
 * IT DOES NOT REPLACE THE PIXEL CANARY. Rule matches prove the style and the tileset agree;
 * painted pixels prove the browser actually drew them. Both are wired into `paint_canary.py`.
 *
 * Usage:
 *   node site/tools/rule_canary.mjs [SOURCE] [--lat LAT] [--lon LON] [--zoom Z]
 *                                   [--flavors light,dark] [--json] [--quiet]
 *
 *   SOURCE  a URL or a local path to the .pmtiles archive. Default: the LOCAL public-tree
 *           copy of whatever `src/lib/basemap.ts` says the app loads (never a hardcoded
 *           filename — hardcoding the retired `nyc-basemap.pmtiles` is precisely how
 *           paint_canary.py came to assert against a file the app had not loaded in weeks).
 *           Pass a base URL like https://nycvisualizer.com to check the LIVE archive.
 *
 * Exit code 0 iff every check passed.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, "..");
const FRONTEND = path.join(SITE, "frontend");
const BASEMAP_TS = path.join(FRONTEND, "src", "lib", "basemap.ts");

// The app is the source of truth for what it loads. Parse it; never restate it.
function loadedBasemapPath() {
  const src = fs.readFileSync(BASEMAP_TS, "utf8");
  const m = src.match(/VITE_BASEMAP_URL\s*\?\?\s*"([^"]+)"/);
  if (!m) {
    throw new Error(
      `could not read the basemap URL out of ${BASEMAP_TS} — the canary refuses to guess ` +
        "(guessing is the bug this file exists to prevent)",
    );
  }
  return m[1]; // e.g. /basemap/nyc-basemap-z15b.pmtiles
}

function maxDataZoom() {
  const src = fs.readFileSync(BASEMAP_TS, "utf8");
  const m = src.match(/BASEMAP_MAX_DATA_ZOOM\s*=\s*(\d+)/);
  return m ? Number(m[1]) : 15;
}

// --- module loading: the deps live in the frontend's node_modules ------------------
// (Deliberately explicit file URLs: this script sits in site/tools/, so bare-specifier
//  resolution would never reach site/frontend/node_modules.)
// The whole point of this canary is that it evaluates the style WE SHIP. If node_modules is
// missing, or holds a different protomaps-leaflet than package.json declares (a stale install,
// or running from the publish mirror), the result would be about some other library — worse
// than no check, because it looks authoritative. Refuse instead.
{
  const installed = path.join(FRONTEND, "node_modules", "protomaps-leaflet", "package.json");
  const declared = path.join(FRONTEND, "package.json");
  if (!fs.existsSync(installed)) {
    console.error(
      "rule_canary FAIL - frontend dependencies are not installed.\n" +
        `  expected: ${installed}\n` +
        "  run `npm ci` in site/frontend first. (The canary evaluates the REAL bundled style;\n" +
        "  it cannot be run from a source mirror that has no node_modules.)",
    );
    process.exit(1);
  }
  const want = JSON.parse(fs.readFileSync(declared, "utf8")).dependencies?.["protomaps-leaflet"];
  const got = JSON.parse(fs.readFileSync(installed, "utf8")).version;
  // package.json pins protomaps-leaflet EXACTLY (no range) precisely so this can be strict.
  if (want && /^\d+\.\d+\.\d+$/.test(want) && want !== got) {
    console.error(
      `rule_canary FAIL - installed protomaps-leaflet ${got} != package.json ${want}.\n` +
        "  This canary would be reporting on a library the site does not ship. Run `npm ci`.",
    );
    process.exit(1);
  }
}
const esm = (spec) =>
  import(pathToFileURL(path.join(FRONTEND, "node_modules", spec)).href);

// --- tile math ---------------------------------------------------------------------
function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { z, x, y };
}

// --- pmtiles sources ---------------------------------------------------------------
class NodeFileSource {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, "r");
  }
  getKey() {
    return this.file;
  }
  async getBytes(offset, length) {
    const buf = Buffer.alloc(length);
    fs.readSync(this.fd, buf, 0, length, offset);
    return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36 nycvisualizer-rule-canary";

class NodeFetchSource {
  constructor(url) {
    this.url = url;
  }
  getKey() {
    return this.url;
  }
  async getBytes(offset, length) {
    const r = await fetch(this.url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}`, "User-Agent": UA },
    });
    if (r.status !== 200 && r.status !== 206) {
      throw new Error(`HTTP ${r.status} range-requesting ${this.url}`);
    }
    return { data: await r.arrayBuffer() };
  }
}

// PMTiles archives are gzip-compressed per tile; supply a Node decompressor.
const decompress = async (buf, compression) => {
  // 1 = none, 2 = gzip, 3 = brotli, 4 = zstd (pmtiles Compression enum)
  if (compression === 2) return zlib.gunzipSync(Buffer.from(buf)).buffer;
  if (compression === 3) return zlib.brotliDecompressSync(Buffer.from(buf)).buffer;
  return buf;
};

// --- required coverage -------------------------------------------------------------
// dataLayer -> what MUST match in the tile. `label: true` means street/place NAMES must
// place, not just geometry. Keep this list honest: only layers that genuinely exist in a
// dense-urban tile belong here, or the canary becomes noise and gets ignored.
const REQUIRED = [
  { layer: "roads", paint: true, label: true },
  { layer: "buildings", paint: true, label: false },
  { layer: "water", paint: true, label: false },
  { layer: "earth", paint: true, label: false },
  { layer: "landuse", paint: true, label: false },
];

async function decodeTile(source, z, x, y) {
  const { PMTiles } = await esm("pmtiles/dist/index.js");
  const vt = await esm("@mapbox/vector-tile/index.js");
  const Pbf = (await esm("pbf/index.js")).default;
  const VectorTile = vt.VectorTile ?? vt.default?.VectorTile;

  const p = new PMTiles(source, undefined, decompress);
  const header = await p.getHeader();
  const resp = await p.getZxy(z, x, y);
  if (!resp) throw new Error(`tile ${z}/${x}/${y} not present in the archive`);
  const tile = new VectorTile(new Pbf(new Uint8Array(resp.data)));

  // Rebuild protomaps' internal Feature shape exactly: props / geomType / geom / bbox.
  const layers = new Map();
  for (const name of Object.keys(tile.layers)) {
    const layer = tile.layers[name];
    const feats = [];
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const geom = f.loadGeometry();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let numVertices = 0;
      for (const ring of geom) {
        for (const pt of ring) {
          if (pt.x < minX) minX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y > maxY) maxY = pt.y;
          numVertices++;
        }
      }
      feats.push({
        props: f.properties,
        geomType: f.type, // MVT 1/2/3 == protomaps GeomType Point/Line/Polygon
        geom,
        bbox: { minX, minY, maxX, maxY },
        numVertices,
      });
    }
    layers.set(name, feats);
  }
  return { header, layers };
}

async function evaluate(layers, flavorName, displayZoom) {
  const pml = await esm("protomaps-leaflet/dist/esm/index.js");
  const { namedFlavor } = await esm("@protomaps/basemaps/dist/esm/index.js");
  const flavor = namedFlavor(flavorName);
  const pr = pml.paintRules(flavor);
  const lr = pml.labelRules(flavor, "en");

  const tally = new Map(); // dataLayer -> {features, paintRules, labelRules, paint, label}
  const bump = (dl, key, n = 1) => {
    if (!tally.has(dl)) {
      tally.set(dl, {
        features: (layers.get(dl) || []).length,
        paintRules: 0,
        labelRules: 0,
        paint: 0,
        label: 0,
      });
    }
    tally.get(dl)[key] += n;
  };

  // Mirrors painter.ts:35-36,82 and labeler.ts:347-348,378 — zoom gate, then filter,
  // evaluated at the DISPLAY zoom (which is what preparedTile.z carries).
  const run = (rules, kind) => {
    for (const rule of rules) {
      bump(rule.dataLayer, kind === "paint" ? "paintRules" : "labelRules");
      if (rule.minzoom && displayZoom < rule.minzoom) continue;
      if (rule.maxzoom && displayZoom > rule.maxzoom) continue;
      const pool = layers.get(rule.dataLayer);
      if (!pool) continue;
      let matched = 0;
      for (const f of pool) {
        try {
          if (!rule.filter || rule.filter(displayZoom, f)) matched++;
        } catch {
          /* a throwing filter matches nothing — same as the renderer */
        }
      }
      bump(rule.dataLayer, kind, matched);
    }
  };
  run(pr, "paint");
  run(lr, "label");

  // Named streets specifically: how many road features carry a name, and did any
  // name-bearing feature survive a label rule? (Casings without names is the half-fixed
  // state; we want the labels too.)
  const roads = layers.get("roads") || [];
  const named = roads.filter((f) => typeof f.props.name === "string" && f.props.name).length;
  let namedMatched = 0;
  for (const rule of lr) {
    if (rule.dataLayer !== "roads") continue;
    if (rule.minzoom && displayZoom < rule.minzoom) continue;
    if (rule.maxzoom && displayZoom > rule.maxzoom) continue;
    for (const f of roads) {
      if (typeof f.props.name !== "string" || !f.props.name) continue;
      try {
        if (!rule.filter || rule.filter(displayZoom, f)) namedMatched++;
      } catch {
        /* ignore */
      }
    }
  }
  return { tally, roadsNamed: named, roadsNamedMatched: namedMatched };
}

function parseArgs(argv) {
  const a = {
    source: null,
    lat: 40.7549,
    lon: -73.984,
    zoom: 16,
    flavors: ["light", "dark"],
    json: false,
    quiet: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--lat") a.lat = Number(argv[++i]);
    else if (v === "--lon") a.lon = Number(argv[++i]);
    else if (v === "--zoom") a.zoom = Number(argv[++i]);
    else if (v === "--flavors") a.flavors = argv[++i].split(",").map((s) => s.trim());
    else if (v === "--json") a.json = true;
    else if (v === "--quiet") a.quiet = true;
    else rest.push(v);
  }
  a.source = rest[0] || null;
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loaded = loadedBasemapPath();
  const mdz = maxDataZoom();

  // Resolve the archive: explicit path/URL, a base URL (+ the app's own basemap path),
  // or the local public-tree copy of that same path.
  let src;
  let label;
  const raw = args.source;
  if (raw && /^https?:\/\//i.test(raw)) {
    const url = raw.endsWith(".pmtiles") ? raw : raw.replace(/\/+$/, "") + loaded;
    src = new NodeFetchSource(url);
    label = url;
  } else {
    const file = raw
      ? path.resolve(raw)
      : path.join(FRONTEND, "public", loaded.replace(/^\//, ""));
    if (!fs.existsSync(file)) throw new Error(`archive not found: ${file}`);
    src = new NodeFileSource(file);
    label = file;
  }

  // The data tile actually used at this display zoom (the app over-zooms z15 data).
  const dataZoom = Math.min(args.zoom, mdz);
  const t = lonLatToTile(args.lon, args.lat, dataZoom);
  const { header, layers } = await decodeTile(src, t.z, t.x, t.y);

  const checks = [];
  const report = {
    archive: label,
    appLoadsPath: loaded,
    tile: `${t.z}/${t.x}/${t.y}`,
    at: { lat: args.lat, lon: args.lon, displayZoom: args.zoom, dataZoom },
    archiveMaxZoom: header.maxZoom,
    layersInTile: Object.fromEntries([...layers].map(([k, v]) => [k, v.length])),
    flavors: {},
  };

  for (const flavorName of args.flavors) {
    const { tally, roadsNamed, roadsNamedMatched } = await evaluate(layers, flavorName, args.zoom);
    report.flavors[flavorName] = {
      perLayer: Object.fromEntries([...tally].map(([k, v]) => [k, v])),
      roadsNamed,
      roadsNamedMatched,
    };
    for (const req of REQUIRED) {
      const t2 = tally.get(req.layer);
      const feats = (layers.get(req.layer) || []).length;
      if (feats === 0) {
        checks.push([false, `[${flavorName}] ${req.layer}: features present in tile`, "0 features decoded"]);
        continue;
      }
      if (req.paint) {
        const n = t2 ? t2.paint : 0;
        checks.push([
          n > 0,
          `[${flavorName}] ${req.layer}: paint rules MATCH features`,
          `${n} matches over ${feats} features (${t2 ? t2.paintRules : 0} rules)`,
        ]);
      }
      if (req.label) {
        const n = t2 ? t2.label : 0;
        checks.push([
          n > 0,
          `[${flavorName}] ${req.layer}: label rules MATCH features`,
          `${n} matches over ${feats} features (${t2 ? t2.labelRules : 0} rules)`,
        ]);
      }
    }
    checks.push([
      roadsNamed > 0 && roadsNamedMatched > 0,
      `[${flavorName}] named streets reach a label rule`,
      `${roadsNamedMatched} matches over ${roadsNamed} name-bearing road features`,
    ]);
  }

  const passed = checks.filter((c) => c[0]).length;
  const ok = passed === checks.length;
  report.checks = checks.map(([o, n, d]) => ({ ok: o, name: n, detail: d }));
  report.verdict = ok ? "PASS" : "FAIL";

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (!args.quiet) {
      console.log(`archive: ${label}`);
      console.log(`tile:    ${report.tile}  (display z${args.zoom} -> data z${dataZoom})`);
      console.log(
        "layers:  " +
          Object.entries(report.layersInTile)
            .map(([k, v]) => `${k}=${v}`)
            .join(" "),
      );
      for (const [o, n, d] of checks) console.log(`${o ? "PASS" : "FAIL"} ${n}  (${d})`);
    }
    console.log(`rule_canary ${report.verdict} - ${passed}/${checks.length} checks`);
  }
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`rule_canary FAIL - ${err.message}`);
    process.exit(1);
  },
);
