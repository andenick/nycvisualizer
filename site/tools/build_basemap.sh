#!/usr/bin/env bash
###############################################################################
# build_basemap.sh - NYC Visualizer basemap generator (W0, 2026-07-24)
#
# Regenerates frontend/public/basemap/nyc-basemap-z15b.pmtiles: the self-hosted
# NYC-extent Protomaps vector basemap the whole site renders on.
#
# WHY THIS FILE EXISTS
#   Until 2026-07-24 there was NO basemap build script in the tree at all. site/README.md
#   documented a `pmtiles extract ... --maxzoom=14` recipe that had been superseded (the
#   shipped archive is maxzoom 15), and PERF_BASELINE.md / CHANGELOG.md said the file was
#   "built with Planetiler (official Protomaps basemap profile)". The basemap was therefore
#   effectively unreproducible, and — separately — nobody could check the schema version it
#   was built against, which is how the site came to ship a style that matched none of it.
#
# ----------------------------------------------------------------------------
# PROVENANCE — WHAT IS VERIFIED, AND WHAT IS INFERRED (be precise about this)
# ----------------------------------------------------------------------------
# ✅ THE RECIPE BELOW IS VERIFIED BY REPRODUCTION, NOT INFERRED. Re-running it on
#    2026-07-24 with go-pmtiles 1.31.2 produced a file that is BYTE-IDENTICAL to the
#    shipped archive: 99,248,382 bytes, sha256
#    6fee904a56b6f436e1284c14ea6133599c129577d8c752c8eb402d7cd5e72b79, and the extractor
#    reported "Region tiles 3923, result tile entries 3561" — matching the shipped header's
#    numAddressedTiles/numTileEntries exactly.
#
# Supporting evidence gathered 2026-07-24 from the shipped and upstream archives:
#   * The shipped nyc-basemap-z15b.pmtiles carries EXACTLY the metadata of the Protomaps
#     daily planet build https://build.protomaps.com/20260722.pmtiles — byte-identical
#     planetiler:version 0.10.2, planetiler:githash 0e5588c4a6e8c29a270a33afe8df62027d889604,
#     planetiler:buildtime 2026-03-28T14:41:39.524Z, osmosisreplicationseq 121461,
#     osmosisreplicationtime 2026-07-22T04:00:00Z, schema version 4.15.0.
#   * The shipped archive still contains WHOLE-PLANET low-zoom tiles: z0/0/0 has 41
#     boundary features and global earth/landcover/water; z4/4/6 contains Toronto, Miami,
#     Cuba, Haiti and the Bahamas. A local Planetiler run bounded to the NYC bbox could not
#     produce those, because Planetiler CLIPS tile CONTENT to --bounds. `pmtiles extract`
#     selects whole tiles by address and copies their bytes unchanged — which is exactly
#     what we observe.
#   * Header: minzoom 0, maxzoom 15, bounds -74.28,40.49,-73.69,40.92,
#     tileDataLength 99,238,131 B (94.64 MiB), 3,923 addressed tiles / 3,473 distinct.
#
#   => The shipped basemap is a `pmtiles extract` of the Protomaps 2026-07-22 planet build.
#      It was NOT built by running Planetiler here. PERF_BASELINE.md:150-151 and
#      CHANGELOG.md:237 overstate this: Planetiler built the PLANET (at Protomaps), we
#      extracted a bbox from it. Those two docs are corrected as part of W0.
#
# STILL INFERRED (no build log was ever written — but none of it changes the output):
#   * the go-pmtiles version the operator originally used (any version producing the same
#     bytes is equivalent; 1.31.2 does), and
#   * whether they passed `--maxzoom=15` explicitly or relied on the source's own maxzoom
#     of 15 — indistinguishable, since the planet IS maxzoom 15 (the Protomaps schema
#     ceiling, MAX_MAXZOOM = 15).
#   The operator's exact keystrokes are unrecoverable; the ARTIFACT is not. Byte-identical
#   output is the standard that matters.
#
# ----------------------------------------------------------------------------
# UPDATING THE BASEMAP (OSM vintage refresh)
# ----------------------------------------------------------------------------
#   ./build_basemap.sh --planet-date 20260901 --out nyc-basemap-z15c.pmtiles
#
#   ⚠️ ALWAYS SHIP UNDER A NEW FILENAME. `/basemap/*` is served with an immutable Caddy
#      cache rule and fronted by Cloudflare; overwriting the existing name serves stale
#      bytes for 24 h. That is why the current file is `-z15b` and not `-z15` (the `-z15`
#      URL was edge-poisoned by a pre-deploy 404 that CF cached as SPA HTML). After the
#      build, update BASEMAP_URL in frontend/src/lib/basemap.ts — paint_canary.py and
#      rule_canary.mjs both READ that constant, so they follow automatically.
#
#   ⚠️ THEN RUN THE RULE CANARY. A newer planet build can change the schema version, and a
#      schema the bundled protomaps-leaflet style does not match renders a roadless map that
#      looks fine to a pixel check. This script runs it for you at the end.
#
# Usage:
#   ./build_basemap.sh [--planet-date YYYYMMDD] [--bbox MINLON,MINLAT,MAXLON,MAXLAT]
#                      [--maxzoom N] [--out FILENAME] [--dest DIR] [--dry-run]
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- what actually shipped (read off the archive header, 2026-07-24) ---------
PLANET_DATE="20260722"                       # OSM vintage 2026-07-22T04:00:00Z, seq 121461
BBOX="-74.28,40.49,-73.69,40.92"             # all five boroughs
MAXZOOM="15"                                 # Protomaps schema ceiling (MAX_MAXZOOM = 15)
OUT="nyc-basemap-z15b.pmtiles"
DEST="$SITE_DIR/frontend/public/basemap"
DRY_RUN=0

# Known-good fingerprint of the CURRENTLY SHIPPED artifact, for verification.
EXPECT_SCHEMA="4.15.0"
EXPECT_BYTES="99248382"
EXPECT_SHA256="6fee904a56b6f436e1284c14ea6133599c129577d8c752c8eb402d7cd5e72b79"

while [ $# -gt 0 ]; do
  case "$1" in
    --planet-date) PLANET_DATE="$2"; shift 2 ;;
    --bbox)        BBOX="$2";        shift 2 ;;
    --maxzoom)     MAXZOOM="$2";     shift 2 ;;
    --out)         OUT="$2";         shift 2 ;;
    --dest)        DEST="$2";        shift 2 ;;
    --dry-run)     DRY_RUN=1;        shift ;;
    -h|--help)     sed -n '2,70p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

SRC="https://build.protomaps.com/${PLANET_DATE}.pmtiles"

# --- locate go-pmtiles: PATH first, then a local bootstrap -------------------
# https://github.com/protomaps/go-pmtiles — `pmtiles extract` range-reads only the tiles
# inside the bbox out of the remote planet archive, so this downloads ~95 MiB, not 100 GB.
PMTILES_BIN=""
if command -v pmtiles >/dev/null 2>&1; then
  PMTILES_BIN="$(command -v pmtiles)"
elif [ -x "$SCRIPT_DIR/bin/pmtiles" ]; then
  PMTILES_BIN="$SCRIPT_DIR/bin/pmtiles"
elif [ -x "$SCRIPT_DIR/bin/pmtiles.exe" ]; then
  PMTILES_BIN="$SCRIPT_DIR/bin/pmtiles.exe"
else
  cat >&2 <<'EOF'
ERROR: go-pmtiles is not installed.

It is NOT present on the dev machine and NOT on the box (verified 2026-07-24) — the
original basemap was made with a one-off download that was never committed. Install it:

  # Linux/macOS/WSL
  V=1.28.0; OS=$(uname -s | tr 'A-Z' 'a-z'); ARCH=x86_64
  curl -L -o /tmp/pmtiles.tgz \
    "https://github.com/protomaps/go-pmtiles/releases/download/v${V}/go-pmtiles_${V}_${OS^}_${ARCH}.tar.gz"
  mkdir -p "$(dirname "$0")/bin" && tar -xzf /tmp/pmtiles.tgz -C "$(dirname "$0")/bin" pmtiles

  # Windows: download go-pmtiles_<V>_Windows_x86_64.zip from the same releases page and
  # unzip pmtiles.exe into site/tools/bin/.

site/tools/bin/ is gitignored — the binary is a build tool, not a source artifact.
EOF
  exit 1
fi

echo "== nycvisualizer basemap build =="
echo "  pmtiles : $PMTILES_BIN ($("$PMTILES_BIN" version 2>/dev/null | head -1 || echo 'version unknown'))"
echo "  source  : $SRC"
echo "  bbox    : $BBOX"
echo "  maxzoom : $MAXZOOM"
echo "  output  : $DEST/$OUT"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "(dry run — not building)"
  echo "$PMTILES_BIN extract $SRC $OUT --bbox=$BBOX --maxzoom=$MAXZOOM"
  exit 0
fi

if [ -e "$DEST/$OUT" ]; then
  echo "ERROR: $DEST/$OUT already exists." >&2
  echo "       Refusing to overwrite — /basemap/* is immutably cached, so a rebuild MUST" >&2
  echo "       ship under a new filename. Pass --out nyc-basemap-z15<next>.pmtiles." >&2
  exit 1
fi

mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# THE COMMAND THAT REPRODUCES THE SHIPPED ARTIFACT:
"$PMTILES_BIN" extract "$SRC" "$TMP/$OUT" --bbox="$BBOX" --maxzoom="$MAXZOOM"

echo "-- verifying the result --"
"$PMTILES_BIN" show "$TMP/$OUT" | head -25 || true

mv "$TMP/$OUT" "$DEST/$OUT"
ls -l "$DEST/$OUT"

# Rebuilding the CURRENT config must reproduce the current artifact exactly. If you changed
# --planet-date/--bbox/--maxzoom this will differ, and that is expected.
if command -v sha256sum >/dev/null 2>&1; then
  GOT="$(sha256sum "$DEST/$OUT" | cut -d' ' -f1)"
  if [ "$PLANET_DATE" = "20260722" ] && [ "$BBOX" = "-74.28,40.49,-73.69,40.92" ] && [ "$MAXZOOM" = "15" ]; then
    if [ "$GOT" = "$EXPECT_SHA256" ]; then
      echo "  sha256 MATCHES the reference artifact ($EXPECT_BYTES B) — exact reproduction."
    else
      echo "  WARNING: sha256 $GOT != reference $EXPECT_SHA256" >&2
      echo "           Same inputs, different bytes — investigate before shipping." >&2
    fi
  else
    echo "  sha256 $GOT (new inputs — no reference to compare against; record it here)"
  fi
fi

echo
echo "-- rule-match canary against the NEW archive (schema vs. style) --"
echo "   expected schema version: $EXPECT_SCHEMA"
if command -v node >/dev/null 2>&1; then
  # NOTE: this checks the new file against whatever BASEMAP_URL currently says the app
  # loads. If you changed the filename, update lib/basemap.ts FIRST, then re-run:
  #   node site/tools/rule_canary.mjs "$DEST/$OUT"
  node "$SCRIPT_DIR/rule_canary.mjs" "$DEST/$OUT" || {
    echo "" >&2
    echo "RULE CANARY FAILED. Do NOT ship this archive." >&2
    echo "The new tileset's schema does not match the protomaps-leaflet style we bundle." >&2
    echo "This is the exact defect that shipped a roadless basemap for weeks in 2026-07." >&2
    exit 1
  }
else
  echo "WARNING: node not found — rule canary NOT run. Run it before shipping:" >&2
  echo "  node site/tools/rule_canary.mjs \"$DEST/$OUT\"" >&2
fi

cat <<EOF

Next steps:
  1. Point the app at it:  frontend/src/lib/basemap.ts -> BASEMAP_URL = "/basemap/$OUT"
     (paint_canary.py and rule_canary.mjs read that constant; do not restate the path.)
  2. Rebuild + deploy the frontend, then:  python site/tools/paint_canary.py
EOF
