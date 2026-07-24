#!/usr/bin/env python3
"""Post-deploy paint canary for nycvisualizer (F5 reliability).

Productized from the ad-hoc CDP paint-check harness. Proves a deploy actually renders:
for the three live map surfaces (/bus, /live/subway, /sidewalks) it checks

  * basemap painted   — real basemap PIXELS drew (nonAlpha > 0), via a headless browser
                        sampling the Leaflet canvas tiles (catches the blank-basemap
                        class of bug the F0 regression was);
  * data present      — vehicles > 0 (/api/rt/vehicles) and trains > 0 (/api/rt/subway),
                        plus the sidewalk coverage vector-tile asset is servable;
  * API 200s          — /api/healthz, /api/rt/vehicles, /api/rt/subway.

Prints one `PASS`/`FAIL` line per check and exits 0 iff every check passed. Wire it into
the deploy flow: **a deploy is not done until paint_canary PASSES against the live edge.**

Usage:
    python site/tools/paint_canary.py [BASE_URL] [--timeout SECONDS] [--quiet]

    BASE_URL   default https://nycvisualizer.com
    --timeout  per-page browser budget to wait for tiles to paint (default 25s)

Requires: requests, playwright (chromium). If the browser can't launch, the pixel
checks FAIL loudly (an un-provable deploy is not a passed deploy).
"""
from __future__ import annotations

import argparse
import sys
import time
import urllib.request
import urllib.error
import json

DEFAULT_BASE = "https://nycvisualizer.com"

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
    for path, name in (
        ("/basemap/nyc-basemap.pmtiles", "basemap pmtiles asset"),
        ("/layers/coverage.pmtiles", "/sidewalks coverage pmtiles asset"),
    ):
        st, ct, body = _get(base + path, headers={"Range": "bytes=0-6"})
        magic_ok = body[:7] == b"PMTiles"
        res.add(
            st in (200, 206) and magic_ok,
            name,
            f"status={st} magic={'ok' if magic_ok else body[:7]!r} ct={ct}",
        )


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
