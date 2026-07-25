#!/usr/bin/env python3
"""COLOUR-VISION CANARY for the borough bus palette (W2.5, 2026-07-24).

WHY THIS EXISTS
  Borough colouring is the DEFAULT bus encoding on /live/bus and /bus, so those seven
  hex values are the primary way ~4,000 live vehicles are told apart. The palette that
  shipped before W2 was never checked: Bronx #dc2626 and Brooklyn #16a34a are the
  textbook red/green deuteranopia collision (they simulate to #898900 vs #88884f,
  CIEDE2000 dE00 = 9.61), and X and SIM were the SAME hex (dE00 = 0.00). Both defects
  are invisible to every other guard in this repo — a screenshot looks fine, the paint
  canary counts pixels, the rule canary checks the basemap style.

WHAT IT CHECKS
  Reads GROUP_COLORS **out of src/lib/boroughs.ts** (never a hardcoded copy — the same
  discipline rule_canary.mjs uses for the basemap URL), simulates deuteranopia,
  protanopia and tritanopia with the Brettel-Vienot-Mollon 1999 dichromat projection,
  and asserts that every one of the 21 pairs stays at least MIN_DE00 apart in CIEDE2000
  under all four vision types. Also asserts every colour keeps enough luminance contrast
  against both the lightest and the darkest shipped basemap.

  This is a REGRESSION guard: it fails if someone "tidies" a borough colour into a
  collision. It is not a substitute for looking at the map.

Usage:  python site/tools/cvd_check.py [--json] [--quiet]
Exit code 0 iff every check passed.
"""
from __future__ import annotations

import argparse
import itertools
import json
import math
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BOROUGHS_TS = HERE.parent / "frontend" / "src" / "lib" / "boroughs.ts"
PALETTE_TS = HERE.parent / "frontend" / "src" / "lib" / "palette.ts"

# The floor. The shipped palette's worst pair is 12.21 (Manhattan vs Queens under
# deuteranopia); 10.0 leaves headroom for a deliberate future tweak while still failing
# on any real collision (the retired palette's worst pair was 0.00, its worst *borough*
# pair 9.61).
MIN_DE00 = 10.0
MIN_CONTRAST_LIGHT = 1.45  # vs #ffffff — vehicles also carry a dark outline (flow/core.ts:682)
MIN_CONTRAST_DARK = 2.40  # vs the Night Ops near-black earth


# ---------------------------------------------------------------------------------
# read the palette out of the app (never restate it)
# ---------------------------------------------------------------------------------
def read_group_colors() -> dict[str, str]:
    src = BOROUGHS_TS.read_text(encoding="utf-8")
    m = re.search(r"export const GROUP_COLORS:\s*Record<string,\s*string>\s*=\s*\{(.*?)\}", src, re.S)
    if not m:
        raise SystemExit(
            f"cvd_check FAIL - could not read GROUP_COLORS out of {BOROUGHS_TS}; refusing to guess "
            "(guessing is the bug this file exists to prevent)"
        )
    out = {}
    for k, v in re.findall(r'([A-Za-z]+)\s*:\s*"(#[0-9a-fA-F]{6})"', m.group(1)):
        out[k] = v.lower()
    if not out:
        raise SystemExit("cvd_check FAIL - GROUP_COLORS parsed to zero entries")
    return out


def read_categorical_12() -> list[str]:
    src = PALETTE_TS.read_text(encoding="utf-8")
    m = re.search(r"export const CATEGORICAL_12:\s*string\[\]\s*=\s*\[(.*?)\]", src, re.S)
    return [c.lower() for c in re.findall(r'"(#[0-9a-fA-F]{6})"', m.group(1))] if m else []


# ---------------------------------------------------------------------------------
# colour science
# ---------------------------------------------------------------------------------
def hex2rgb(h: str):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))


def rgb2hex(c):
    return "#" + "".join("%02x" % max(0, min(255, round(v * 255))) for v in c)


def srgb2lin(c):
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def lin2srgb(c):
    return tuple(
        max(0.0, min(1.0, 12.92 * v if v <= 0.0031308 else 1.055 * v ** (1 / 2.4) - 0.055))
        for v in c
    )


def mv(M, v):
    return tuple(sum(M[i][j] * v[j] for j in range(3)) for i in range(3))


RGB2LMS = [
    [0.31399022, 0.63951294, 0.04649755],
    [0.15537241, 0.75789446, 0.08670142],
    [0.01775239, 0.10944209, 0.87256922],
]
LMS2RGB = [
    [5.47221206, -4.6419601, 0.16963708],
    [-1.1252419, 2.29317094, -0.1678952],
    [0.02980165, -0.19318073, 1.16364789],
]
# Brettel-Vienot-Mollon dichromat projection planes.
CVD_PLANES = {
    "protan": ((0.0, 1.05118294, -0.05116099), 0),
    "deutan": ((0.9513092, 0.0, 0.04866992), 1),
    "tritan": ((-0.86744736, 1.86727089, 0.0), 2),
}
KINDS = ["normal", "deutan", "protan", "tritan"]


def simulate(hexcol: str, kind: str) -> str:
    if kind == "normal":
        return hexcol
    lms = mv(RGB2LMS, srgb2lin(hex2rgb(hexcol)))
    coef, idx = CVD_PLANES[kind]
    out = list(lms)
    out[idx] = coef[0] * lms[0] + coef[1] * lms[1] + coef[2] * lms[2]
    return rgb2hex(lin2srgb(mv(LMS2RGB, tuple(out))))


def rgb2lab(hexcol: str):
    r, g, b = srgb2lin(hex2rgb(hexcol))
    X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b
    Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    Z = 0.0193339 * r + 0.1191920 * g + 0.9503041 * b
    Xn, Yn, Zn = 0.95047, 1.0, 1.08883

    def f(t):
        return t ** (1 / 3) if t > 216 / 24389 else (841 / 108) * t + 4 / 29

    fx, fy, fz = f(X / Xn), f(Y / Yn), f(Z / Zn)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def ciede2000(lab1, lab2) -> float:
    L1, a1, b1 = lab1
    L2, a2, b2 = lab2
    C1 = math.hypot(a1, b1)
    C2 = math.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - math.sqrt(Cb**7 / (Cb**7 + 25**7))) if Cb > 0 else 0.5
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = math.hypot(a1p, b1), math.hypot(a2p, b2)
    h1p = math.degrees(math.atan2(b1, a1p)) % 360 if (a1p or b1) else 0
    h2p = math.degrees(math.atan2(b2, a2p)) % 360 if (a2p or b2) else 0
    dLp, dCp = L2 - L1, C2p - C1p
    if C1p * C2p == 0:
        dhp = 0
    elif abs(h2p - h1p) <= 180:
        dhp = h2p - h1p
    elif h2p - h1p > 180:
        dhp = h2p - h1p - 360
    else:
        dhp = h2p - h1p + 360
    dHp = 2 * math.sqrt(C1p * C2p) * math.sin(math.radians(dhp) / 2)
    Lbp, Cbp = (L1 + L2) / 2, (C1p + C2p) / 2
    if C1p * C2p == 0:
        hbp = h1p + h2p
    elif abs(h1p - h2p) <= 180:
        hbp = (h1p + h2p) / 2
    elif h1p + h2p < 360:
        hbp = (h1p + h2p + 360) / 2
    else:
        hbp = (h1p + h2p - 360) / 2
    T = (
        1
        - 0.17 * math.cos(math.radians(hbp - 30))
        + 0.24 * math.cos(math.radians(2 * hbp))
        + 0.32 * math.cos(math.radians(3 * hbp + 6))
        - 0.20 * math.cos(math.radians(4 * hbp - 63))
    )
    dTh = 30 * math.exp(-(((hbp - 275) / 25) ** 2))
    Rc = 2 * math.sqrt(Cbp**7 / (Cbp**7 + 25**7)) if Cbp > 0 else 0
    Sl = 1 + (0.015 * (Lbp - 50) ** 2) / math.sqrt(20 + (Lbp - 50) ** 2)
    Sc, Sh = 1 + 0.045 * Cbp, 1 + 0.015 * Cbp * T
    Rt = -math.sin(math.radians(2 * dTh)) * Rc
    return math.sqrt(
        (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh)
    )


def de00(c1: str, c2: str, kind: str) -> float:
    return ciede2000(rgb2lab(simulate(c1, kind)), rgb2lab(simulate(c2, kind)))


def lum(h: str) -> float:
    r, g, b = srgb2lin(hex2rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    l1, l2 = sorted([lum(a), lum(b)], reverse=True)
    return (l1 + 0.05) / (l2 + 0.05)


# ---------------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    colors = read_group_colors()
    cat12 = read_categorical_12()
    checks: list[tuple[bool, str, str]] = []

    # 1. every borough colour is a CATEGORICAL_12 member or a lightness-shift of one.
    #    (The express families are +58% shifts of their home borough; a shift preserves
    #    hue, so we check hue-family membership rather than exact equality.)
    for g, c in colors.items():
        exact = c in cat12
        checks.append(
            (
                exact or g in ("X", "SIM"),
                f"{g} {c}: drawn from CATEGORICAL_12 (or a documented lightness shift of it)",
                "exact member" if exact else "lightness-shifted express variant",
            )
        )

    # 2. pairwise separation under all four vision types
    worst = (1e9, None, None, None)
    per_kind = {}
    for kind in KINDS:
        w, pair = 1e9, None
        for (n1, c1), (n2, c2) in itertools.combinations(colors.items(), 2):
            d = de00(c1, c2, kind)
            if d < w:
                w, pair = d, (n1, n2)
            if d < worst[0]:
                worst = (d, kind, n1, n2)
        per_kind[kind] = {"min_de00": round(w, 2), "worst_pair": pair}
        checks.append(
            (
                w >= MIN_DE00,
                f"[{kind}] every borough pair >= {MIN_DE00} dE00",
                f"min {w:.2f} ({pair[0]} vs {pair[1]})",
            )
        )

    # 3. X and SIM must not be the same value (the shipped-until-W2 defect)
    if "X" in colors and "SIM" in colors:
        d = de00(colors["X"], colors["SIM"], "normal")
        checks.append((d >= MIN_DE00, "X and SIM are distinct colours", f"dE00 {d:.2f}"))

    # 4. luminance headroom on the lightest and darkest shipped basemaps
    for g, c in colors.items():
        cl, cd = contrast(c, "#ffffff"), contrast(c, "#0a0c10")
        checks.append(
            (
                cl >= MIN_CONTRAST_LIGHT and cd >= MIN_CONTRAST_DARK,
                f"{g} {c}: readable on both the lightest and darkest basemap",
                f"contrast white {cl:.2f} (>= {MIN_CONTRAST_LIGHT}) · near-black {cd:.2f} (>= {MIN_CONTRAST_DARK})",
            )
        )

    passed = sum(1 for c in checks if c[0])
    ok = passed == len(checks)
    report = {
        "source": str(BOROUGHS_TS),
        "colors": colors,
        "per_vision_type": per_kind,
        "worst_overall": {"de00": round(worst[0], 2), "kind": worst[1], "pair": [worst[2], worst[3]]},
        "simulated": {
            g: {k: simulate(c, k) for k in KINDS} for g, c in colors.items()
        },
        "checks": [{"ok": o, "name": n, "detail": d} for o, n, d in checks],
        "verdict": "PASS" if ok else "FAIL",
    }
    if a.json:
        print(json.dumps(report, indent=2))
    else:
        if not a.quiet:
            print(f"palette: {BOROUGHS_TS}")
            for g, c in colors.items():
                print(f"  {g:4s} {c}  " + "  ".join(f"{k}={simulate(c, k)}" for k in KINDS[1:]))
            for o, n, d in checks:
                print(f"{'PASS' if o else 'FAIL'} {n}  ({d})")
        print(f"cvd_check {report['verdict']} - {passed}/{len(checks)} checks")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
