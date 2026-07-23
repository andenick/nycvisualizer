#!/usr/bin/env bash
###############################################################################
# make_overlays.sh - NYC Visualizer vector-tile overlay generator  (Q1.1)
#
# tippecanoe:  felt/tippecanoe  v2.79.0
#              commit 68ab8dcc229f95b8b25877697d5e8d66783af503
#              built 2026-07-23 on the box (Ubuntu 26.04) via Docker ubuntu:26.04
#              (host has no compiler/-dev libs and no passwordless sudo, so the
#               binary was compiled in a matching-glibc container and copied to
#               ~/sites/nycvisualizer/tools/bin/ ; runtime libs libsqlite3.so.0
#               + libz.so.1 are present on the host, so it runs natively.)
#
# Generates, into the web-served layers dir (served at /layers/):
#   coverage.pmtiles    - sidewalk coverage centerlines (HERO layer, Q1.2)
#   sai_stops.pmtiles   - SAI stop points (OPTIONAL; circleMarkers remain valid)
#   overlays_meta.json  - per-layer vintage sidecar for ARKMAP stamps
#
# Source property names (VERIFIED 2026-07-23 by inspecting the GeoJSONs):
#   coverage: 'c' (coverage class)  ->  b=both-sides  o=one-side  n=none
#             'w' (median sidewalk width, ft)  -- Q1.2 width-mode: joined from
#             02_width_segments.parquet by PHYSICALID in build_layers.py and
#             regenerated into the coverage_seg_*.geojson (93,800/96,567 segments
#             have a measured width; the rest omit 'w').
#   sai:      stop_name, borough, routes, sai, walkshed_population,
#             sidewalk_provision, ada_ramp_access, comfort, condition, safety,
#             service_intensity, pop_400m, stop_id
#             (plan said 'name' -> actual is 'stop_name')
#
# Usage:  ./make_overlays.sh [LAYERS_DIR]
#   LAYERS_DIR defaults to the first of: <script>/dist/layers,
#   <script>/../frontend/public/layers, <script>/frontend/public/layers.
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- locate tippecanoe: PATH first, then known install locations -------------
if command -v tippecanoe >/dev/null 2>&1; then
  TIPPE="$(command -v tippecanoe)"
elif [ -x "$SCRIPT_DIR/tools/bin/tippecanoe" ]; then
  TIPPE="$SCRIPT_DIR/tools/bin/tippecanoe"
elif [ -x "$HOME/sites/nycvisualizer/tools/bin/tippecanoe" ]; then
  TIPPE="$HOME/sites/nycvisualizer/tools/bin/tippecanoe"
else
  echo "ERROR: tippecanoe not found on PATH or in tools/bin" >&2
  exit 1
fi

# --- locate the web-served layers dir ----------------------------------------
LAYERS_DIR="${1:-}"
if [ -z "$LAYERS_DIR" ]; then
  for cand in "$SCRIPT_DIR/dist/layers" \
              "$SCRIPT_DIR/../frontend/public/layers" \
              "$SCRIPT_DIR/frontend/public/layers" \
              "$HOME/sites/nycvisualizer/dist/layers"; do
    [ -d "$cand" ] && { LAYERS_DIR="$cand"; break; }
  done
fi
[ -d "$LAYERS_DIR" ] || { echo "ERROR: layers dir not found: '$LAYERS_DIR'" >&2; exit 1; }
cd "$LAYERS_DIR"

echo "tippecanoe : $("$TIPPE" --version 2>&1 | head -1)  ($TIPPE)"
echo "layers dir : $LAYERS_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

###############################################################################
# 1) COVERAGE CENTERLINES  ->  coverage.pmtiles
###############################################################################
COV_SRCS=( coverage_seg_bronx.geojson coverage_seg_brooklyn.geojson \
           coverage_seg_manhattan.geojson coverage_seg_queens.geojson \
           coverage_seg_staten_island.geojson )
for f in "${COV_SRCS[@]}"; do
  [ -f "$f" ] || { echo "ERROR: missing coverage source: $f" >&2; exit 1; }
done

# Concatenate the 5 boroughs into ONE FeatureCollection, keeping 'c' + 'w'.
MERGED="$TMP/coverage_all.geojson"
COV_N="$(python3 - "$MERGED" "${COV_SRCS[@]}" <<'PY'
import json, sys
out, srcs = sys.argv[1], sys.argv[2:]
feats = []
for fn in srcs:
    d = json.load(open(fn, encoding="utf-8"))
    for ft in d["features"]:
        p = ft.get("properties") or {}
        np = {}
        if "c" in p: np["c"] = p["c"]
        if p.get("w") is not None: np["w"] = p["w"]  # median sidewalk width (ft)
        ft["properties"] = np
        feats.append(ft)
json.dump({"type": "FeatureCollection", "features": feats}, open(out, "w"))
print(len(feats))
PY
)"
echo "coverage   : merged ${COV_N} features from ${#COV_SRCS[@]} boroughs"

"$TIPPE" -o coverage.pmtiles -l coverage -Z10 -z16 \
  --simplification=4 --no-tiny-polygon-reduction --include=c --include=w \
  --force "$MERGED"

###############################################################################
# 2) SAI STOP POINTS  ->  sai_stops.pmtiles   (OPTIONAL)
###############################################################################
SAI_SRC="sai_stops.min.geojson"
SAI_N=0
if [ -f "$SAI_SRC" ]; then
  SAI_N="$(python3 -c "import json;print(len(json.load(open('$SAI_SRC'))['features']))")"
  echo "sai        : ${SAI_N} stop points"
  # -r1 = no point dropping at low zoom. Carry sai, stop_name, routes, stop_id.
  "$TIPPE" -o sai_stops.pmtiles -l sai -Z11 -z16 -r1 \
    --include=sai --include=stop_name --include=routes --include=stop_id \
    --force "$SAI_SRC"
else
  echo "sai        : $SAI_SRC absent - skipping point tileset (circleMarkers OK)"
fi

###############################################################################
# 3) PER-LAYER VINTAGE SIDECAR  ->  overlays_meta.json
###############################################################################
TIPPE_VER="$("$TIPPE" --version 2>&1 | head -1)"
python3 - overlays_meta.json "$COV_N" "$SAI_N" "$TIPPE_VER" "${COV_SRCS[@]}" <<'PY'
import json, os, sys, datetime
out, cov_n, sai_n, tippe_ver = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
cov_srcs = sys.argv[5:]
def vintage(path):
    return datetime.date.fromtimestamp(os.path.getmtime(path)).isoformat() if os.path.exists(path) else None
def size(path):
    return os.path.getsize(path) if os.path.exists(path) else None
now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
meta = {
  "_note": "Per-layer vintage sidecar for ARKMAP stamps (Q1.1). generated=tile build time; source_vintage=source GeoJSON date.",
  "tippecanoe": tippe_ver,
  "tippecanoe_commit": "68ab8dcc229f95b8b25877697d5e8d66783af503",
  "coverage": {
    "generated": now,
    "source_vintage": vintage(cov_srcs[0]) if cov_srcs else None,
    "source_files": cov_srcs,
    "features": cov_n,
    "minzoom": 10, "maxzoom": 16,
    "size_bytes": size("coverage.pmtiles"),
    "attrs": {"c": "coverage class: b=both-sides, o=one-side, n=none",
              "w": "median sidewalk width (ft), from 02_width_segments; absent where unmeasured"},
    "notes": "Q1.2 width-mode data present: 'w' = median sidewalk width (ft) on ~97% of segments."
  }
}
if os.path.exists("sai_stops.pmtiles"):
  meta["sai"] = {
    "generated": now,
    "source_vintage": vintage("sai_stops.min.geojson"),
    "source_files": ["sai_stops.min.geojson"],
    "features": sai_n,
    "minzoom": 11, "maxzoom": 16,
    "size_bytes": size("sai_stops.pmtiles"),
    "attrs": {
      "sai": "Stop Access Index composite score (0-100)",
      "stop_name": "stop name string",
      "routes": "comma-separated route list",
      "stop_id": "GTFS stop id (join key)"
    },
    "notes": "Optional tileset. Full min.geojson also has borough + 8 sub-scores + pop_400m if a richer tileset is wanted; circleMarkers reading the min.geojson remain valid."
  }
json.dump(meta, open(out, "w"), indent=2)
print("wrote", out)
PY

echo "--- outputs ---"
ls -la coverage.pmtiles sai_stops.pmtiles overlays_meta.json 2>/dev/null || true
echo "done."
