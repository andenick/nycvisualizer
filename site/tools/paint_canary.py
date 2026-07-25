#!/usr/bin/env python3
"""Post-deploy paint canary for nycvisualizer (F5 reliability).

Productized from the ad-hoc CDP paint-check harness. Proves a deploy actually renders:
for the three live map surfaces (/bus, /live/subway, /sidewalks) it checks

  * basemap painted   — real basemap PIXELS drew (nonAlpha > 0), via a headless browser
                        sampling the Leaflet canvas tiles (catches the blank-basemap
                        class of bug the F0 regression was);
  * rules MATCH       — the shipped protomaps style actually matches features in the
                        shipped tileset, INCLUDING the z15 address points the street-number
                        labels ride on (delegated to `rule_canary.mjs`, see below);
  * palette safe      — the borough bus palette (now the DEFAULT bus encoding) stays
                        distinguishable under deuteranopia / protanopia / tritanopia
                        (delegated to `cvd_check.py`);
  * data present      — vehicles > 0 (/api/rt/vehicles) and trains > 0 (/api/rt/subway),
                        plus the sidewalk coverage vector-tile asset is servable;
  * API 200s          — /api/healthz, /api/rt/vehicles, /api/rt/subway.

⚠️ WHY THE PIXEL CHECK IS NOT ENOUGH (2026-07-24). This canary passed 10/10 for weeks while
the basemap rendered NO ROADS AND NO STREET LABELS at all. The bundled protomaps-leaflet
4.1.1 style filtered on the Protomaps v2 property `pmap:kind` while the shipped tileset is
v4.15.0 (bare `kind`), so every road/landuse/place rule matched zero features — but
buildings, landuse polygons and water still painted, so the pixel count stayed healthy.
Pixel counting provably CANNOT detect a schema mismatch. Rule-match counting can, so
`check_rules()` below runs `rule_canary.mjs` and is a first-class check. Do not "simplify"
it away, and do not accept a green pixel check as evidence that the map is correct.

Second 2026-07-24 fix: the basemap asset check used to hardcode the RETIRED
`/basemap/nyc-basemap.pmtiles` — a file the app had not loaded since the z15b cache-bust —
so it asserted a stale artifact was servable and never touched the real one. The path is now
READ OUT OF `frontend/src/lib/basemap.ts`, the app's own source of truth. Never restate it.

Prints one `PASS`/`FAIL` line per check and exits 0 iff every check passed. Wire it into
the deploy flow: **a deploy is not done until paint_canary PASSES against the live edge.**

Usage:
    python site/tools/paint_canary.py [BASE_URL] [--timeout SECONDS] [--quiet]

    BASE_URL   default https://nycvisualizer.com
    --timeout  per-page browser budget to wait for tiles to paint (default 25s)

Requires: playwright (chromium) and node (for the rule canary). If either is unavailable
the corresponding checks FAIL loudly (an un-provable deploy is not a passed deploy).
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error
import json
from pathlib import Path

DEFAULT_BASE = "https://nycvisualizer.com"

SITE_DIR = Path(__file__).resolve().parents[1]
BASEMAP_TS = SITE_DIR / "frontend" / "src" / "lib" / "basemap.ts"
RULE_CANARY = Path(__file__).resolve().parent / "rule_canary.mjs"
CVD_CHECK = Path(__file__).resolve().parent / "cvd_check.py"


def loaded_basemap_path() -> str:
    """The basemap URL the app ACTUALLY loads, read from lib/basemap.ts.

    Raises rather than guessing: a wrong-but-plausible default is exactly the bug that let
    this canary assert against the retired `nyc-basemap.pmtiles` for weeks.
    """
    src = BASEMAP_TS.read_text(encoding="utf-8")
    m = re.search(r'VITE_BASEMAP_URL\s*\?\?\s*"([^"]+)"', src)
    if not m:
        raise RuntimeError(
            f"could not read the basemap URL out of {BASEMAP_TS} — refusing to guess"
        )
    return m.group(1)

# The JS that counts painted (non-transparent) basemap pixels — identical logic to the
# frontend guard's countPaintedPixels(): sparse-sample every Leaflet canvas tile.
COUNT_PAINTED_JS = r"""
() => {
  const cvs = document.querySelectorAll('canvas.leaflet-tile');
  let painted = 0, canvases = 0;
  cvs.forEach(cv => {
    const w = cv.width, h = cv.height;
    if (!w || !h) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let img;
    try { img = ctx.getImageData(0, 0, w, h); } catch (e) { return; }
    canvases++;
    const d = img.data, stride = 32 * 4;
    for (let i = 3; i < d.length; i += stride) if (d[i] !== 0) painted++;
  });
  return { painted, canvases };
}
"""


class Result:
    def __init__(self) -> None:
        self.checks: list[tuple[bool, str, str]] = []  # (ok, name, detail)

    def add(self, ok: bool, name: str, detail: str = "") -> None:
        self.checks.append((bool(ok), name, detail))

    def ok(self) -> bool:
        return all(c[0] for c in self.checks)


# Cloudflare 403s the default `Python-urllib/*` UA, so present a normal browser UA
# (the same class of client the browser paint-checks use). Not evasion — this is our
# own edge; it just avoids the bot-block on programmatic health checks.
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36 nycvisualizer-paint-canary"
)


def _get(url: str, timeout: float = 20.0, headers: dict | None = None) -> tuple[int, str, bytes]:
    h = {"Accept": "*/*", "User-Agent": _UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            # Read the full body (rt JSON payloads are ~250KB; cap generously). A short
            # read would truncate the JSON and break the count parse.
            body = r.read(8_000_000)
            return r.status, r.headers.get("Content-Type", ""), body
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", "") if e.headers else "", b""
    except Exception as e:  # noqa: BLE001
        return 0, f"ERR:{e}", b""


def check_api(base: str, res: Result) -> None:
    # /api/healthz 200
    st, _ct, _b = _get(base + "/api/healthz")
    res.add(st == 200, "api /api/healthz 200", f"status={st}")

    # /api/rt/vehicles 200 + count>0
    st, _ct, body = _get(base + "/api/rt/vehicles")
    cnt = None
    if st == 200 and body:
        try:
            cnt = int(json.loads(body).get("count", 0))
        except Exception:  # noqa: BLE001
            cnt = None
    res.add(st == 200, "api /api/rt/vehicles 200", f"status={st}")
    res.add(cnt is not None and cnt > 0, "/bus vehicles>0", f"count={cnt}")

    # /api/rt/subway 200 + count>0
    st, _ct, body = _get(base + "/api/rt/subway")
    scnt = None
    if st == 200 and body:
        try:
            scnt = int(json.loads(body).get("count", 0))
        except Exception:  # noqa: BLE001
            scnt = None
    res.add(st == 200, "api /api/rt/subway 200", f"status={st}")
    res.add(scnt is not None and scnt > 0, "/live/subway trains>0", f"count={scnt}")

    # Basemap + sidewalk overlay pmtiles are servable (NOT the SPA HTML fallback): check
    # the PMTiles v3 magic ("PMTiles") in the first bytes via a Range request.
    # The basemap path comes from lib/basemap.ts — see loaded_basemap_path().
    try:
        basemap_path = loaded_basemap_path()
    except Exception as e:  # noqa: BLE001
        res.add(False, "basemap path resolvable from lib/basemap.ts", str(e))
        basemap_path = None
    assets = [("/layers/coverage.pmtiles", "/sidewalks coverage pmtiles asset")]
    if basemap_path:
        assets.insert(0, (basemap_path, f"basemap pmtiles asset ({basemap_path})"))
    for path, name in assets:
        st, ct, body = _get(base + path, headers={"Range": "bytes=0-6"})
        magic_ok = body[:7] == b"PMTiles"
        res.add(
            st in (200, 206) and magic_ok,
            name,
            f"status={st} magic={'ok' if magic_ok else body[:7]!r} ct={ct}",
        )


def check_rules(base: str, res: Result) -> None:
    """Rule-match canary — the check the pixel counter structurally cannot do.

    Decodes a real Midtown tile out of the LIVE archive and evaluates the shipped
    protomaps paint/label rules against the real features, asserting roads (and named
    streets) actually match. See rule_canary.mjs for the full rationale.
    """
    if not RULE_CANARY.exists():
        res.add(False, "basemap rule-match canary", f"missing: {RULE_CANARY}")
        return
    try:
        p = subprocess.run(
            ["node", str(RULE_CANARY), base, "--quiet"],
            capture_output=True,
            text=True,
            timeout=180,
        )
    except FileNotFoundError:
        res.add(False, "basemap rule-match canary", "node not found on PATH")
        return
    except Exception as e:  # noqa: BLE001
        res.add(False, "basemap rule-match canary", f"{type(e).__name__}: {e}")
        return
    tail = (p.stdout or "").strip().splitlines()
    detail = tail[-1] if tail else (p.stderr or "").strip()[:200]
    res.add(p.returncode == 0, "basemap rule-match canary (roads/labels match features)", detail)


def check_cvd(res: Result) -> None:
    """Colour-vision canary for the borough bus palette (W2, 2026-07-24).

    Borough colouring is the DEFAULT bus encoding on /live/bus and /bus, so those seven
    hex values ARE the primary way live vehicles are told apart. The palette that shipped
    before W2 had Bronx and Brooklyn colliding under deuteranopia (dE00 9.61) and X/SIM
    identical (dE00 0.00). No pixel or rule check can see that; this one can.

    Source-only (it reads src/lib/boroughs.ts), so it does not need the live edge.
    """
    if not CVD_CHECK.exists():
        res.add(False, "borough palette CVD canary", f"missing: {CVD_CHECK}")
        return
    try:
        p = subprocess.run(
            [sys.executable, str(CVD_CHECK), "--quiet"], capture_output=True, text=True, timeout=60
        )
    except Exception as e:  # noqa: BLE001
        res.add(False, "borough palette CVD canary", f"{type(e).__name__}: {e}")
        return
    tail = (p.stdout or "").strip().splitlines()
    detail = tail[-1] if tail else (p.stderr or "").strip()[:200]
    res.add(p.returncode == 0, "borough palette distinguishable under CVD", detail)


def check_paint(base: str, timeout: float, res: Result) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:  # noqa: BLE001
        for page in ("/bus", "/live/subway", "/sidewalks"):
            res.add(False, f"{page} basemap painted", f"playwright unavailable: {e}")
        return

    pages = ["/bus", "/live/subway", "/sidewalks"]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--disable-gpu"])
        try:
            ctx = browser.new_context(viewport={"width": 1280, "height": 900})
            for path in pages:
                pg = ctx.new_page()
                painted = 0
                canvases = 0
                try:
                    # NOT networkidle: the immersive pages hold an SSE connection open,
                    # so networkidle never fires. Load DOM, then poll for painted pixels.
                    pg.goto(base + path, wait_until="domcontentloaded", timeout=int(timeout * 1000))
                    deadline = time.time() + timeout
                    while time.time() < deadline:
                        r = pg.evaluate(COUNT_PAINTED_JS)
                        painted, canvases = int(r["painted"]), int(r["canvases"])
                        if painted > 0:
                            break
                        pg.wait_for_timeout(600)
                except Exception as e:  # noqa: BLE001
                    res.add(False, f"{path} basemap painted", f"nav/eval error: {e}")
                    pg.close()
                    continue
                res.add(
                    painted > 0,
                    f"{path} basemap painted",
                    f"nonAlpha={painted} canvases={canvases}",
                )
                pg.close()
        finally:
            browser.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="nycvisualizer post-deploy paint canary")
    ap.add_argument("base", nargs="?", default=DEFAULT_BASE, help="base URL (default live edge)")
    ap.add_argument("--timeout", type=float, default=25.0, help="per-page paint budget (s)")
    ap.add_argument("--quiet", action="store_true", help="only print the final verdict line")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    res = Result()
    t0 = time.time()
    check_api(base, res)
    check_rules(base, res)
    check_cvd(res)
    check_paint(base, args.timeout, res)
    elapsed = time.time() - t0

    if not args.quiet:
        for ok, name, detail in res.checks:
            tag = "PASS" if ok else "FAIL"
            print(f"{tag} {name}" + (f"  ({detail})" if detail else ""))

    passed = sum(1 for c in res.checks if c[0])
    total = len(res.checks)
    verdict = "PASS" if res.ok() else "FAIL"
    print(f"paint_canary {verdict} - {passed}/{total} checks against {base} ({elapsed:.1f}s)")
    return 0 if res.ok() else 1


if __name__ == "__main__":
    sys.exit(main())
