// Official MTA subway line colors (per MTA branding guidance).
// Text color is black only on the yellow N/Q/R/W bullet.

const LINE_COLORS: Record<string, string> = {
  "1": "#EE352E", "2": "#EE352E", "3": "#EE352E",
  "4": "#00933C", "5": "#00933C", "6": "#00933C", "6X": "#00933C",
  "7": "#B933AD", "7X": "#B933AD",
  A: "#0039A6", C: "#0039A6", E: "#0039A6", H: "#0039A6",
  B: "#FF6319", D: "#FF6319", F: "#FF6319", FX: "#FF6319", M: "#FF6319",
  G: "#6CBE45",
  J: "#996633", Z: "#996633",
  L: "#A7A9AC",
  N: "#FCCC0A", Q: "#FCCC0A", R: "#FCCC0A", W: "#FCCC0A",
  S: "#808183", GS: "#808183", FS: "#808183",
  SI: "#0039A6", SIR: "#0039A6",
};

export function subwayColor(route: string | null): string {
  if (!route) return "#808183";
  return LINE_COLORS[route.toUpperCase()] ?? "#808183";
}

export function subwayTextColor(route: string | null): string {
  const c = subwayColor(route);
  return c === "#FCCC0A" ? "#111111" : "#ffffff";
}

/** Short label for the bullet (SIR shown as "SIR", GS/FS as "S"). */
export function subwayLabel(route: string | null): string {
  if (!route) return "?";
  const up = route.toUpperCase();
  if (up === "GS" || up === "FS") return "S";
  if (up === "SI") return "SIR";
  return up;
}
