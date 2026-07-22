"""Official MTA subway line colors (server-side mirror of frontend/src/lib/subwayColors.ts).
Kept here so opswall.py can color the line-status strip without importing frontend code."""
from __future__ import annotations

LINE_COLORS: dict[str, str] = {
    "1": "#EE352E", "2": "#EE352E", "3": "#EE352E",
    "4": "#00933C", "5": "#00933C", "6": "#00933C", "6X": "#00933C",
    "7": "#B933AD", "7X": "#B933AD",
    "A": "#0039A6", "C": "#0039A6", "E": "#0039A6", "H": "#0039A6",
    "B": "#FF6319", "D": "#FF6319", "F": "#FF6319", "FX": "#FF6319", "M": "#FF6319",
    "G": "#6CBE45",
    "J": "#996633", "Z": "#996633",
    "L": "#A7A9AC",
    "N": "#FCCC0A", "Q": "#FCCC0A", "R": "#FCCC0A", "W": "#FCCC0A",
    "S": "#808183", "GS": "#808183", "FS": "#808183",
    "SI": "#0039A6", "SIR": "#0039A6",
}

# Text color is black only on the yellow N/Q/R/W bullet.
TEXT_ON: dict[str, str] = {k: ("#111111" if v == "#FCCC0A" else "#ffffff")
                           for k, v in LINE_COLORS.items()}


def line_label(route: str | None) -> str:
    if not route:
        return "?"
    up = route.upper()
    if up in ("GS", "FS"):
        return "S"
    if up == "SI":
        return "SIR"
    return up
