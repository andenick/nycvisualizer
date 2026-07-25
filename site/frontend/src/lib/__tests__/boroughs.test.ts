// W2 (2026-07-24) — guards on the borough grouping that is now the DEFAULT bus encoding
// on /live/bus and /bus.
//
// Scope, stated honestly: these are structural invariants (the prefix parser's ordering
// traps, palette completeness, no duplicate hex). The perceptual question — "are these
// seven colours actually distinguishable, including under colour-vision deficiency?" —
// is not answerable in a unit test and is checked by `site/tools/cvd_check.py`, which
// runs a Brettel-Viénot-Mollon dichromat simulation + CIEDE2000 and is wired into
// paint_canary.py. Neither replaces the other.

import { describe, it, expect } from "vitest";
import {
  BOROUGH_GROUP_ORDER,
  BOROUGH_LEGEND,
  GROUP_COLORS,
  boroughColor,
  boroughLabel,
  routeGroup,
} from "../boroughs";

describe("routeGroup — prefix parser", () => {
  it("puts the Bx check before the bare-B check", () => {
    // BX12 starts with "B"; if the checks were ordered the other way it would be
    // classed Brooklyn. 57 Bronx routes depend on this.
    expect(routeGroup("BX12")).toBe("Bx");
    expect(routeGroup("Bx41")).toBe("Bx");
    expect(routeGroup("B44")).toBe("B");
  });

  it("puts the SIM check before both the S and X checks", () => {
    expect(routeGroup("SIM4")).toBe("SIM");
    expect(routeGroup("SIM33C")).toBe("SIM");
    expect(routeGroup("S53")).toBe("S");
    expect(routeGroup("X27")).toBe("X");
  });

  it("classifies the five borough prefixes", () => {
    expect(routeGroup("M15")).toBe("M");
    expect(routeGroup("Q58")).toBe("Q");
    expect(routeGroup("B41")).toBe("B");
    expect(routeGroup("S79")).toBe("S");
    expect(routeGroup("BX1")).toBe("Bx");
  });

  it("is case-insensitive (the feed is not consistent about case)", () => {
    expect(routeGroup("bx12")).toBe(routeGroup("BX12"));
    expect(routeGroup("sim4")).toBe(routeGroup("SIM4"));
    expect(routeGroup("q58")).toBe(routeGroup("Q58"));
  });

  it("emits only known group codes for a representative spread of real route ids", () => {
    const sample = [
      "M15", "M101", "M116", "B44", "B46", "B62", "BX1", "BX12", "BX41", "Q10", "Q58",
      "Q100", "S40", "S53", "S79", "SIM1", "SIM4", "SIM33C", "X27", "X28",
      "M15+", "B44+", "Q44+", "BX12+", "S79+",
    ];
    for (const id of sample) {
      expect(BOROUGH_GROUP_ORDER, `unknown group for ${id}`).toContain(routeGroup(id));
    }
  });
});

describe("GROUP_COLORS — the default bus palette", () => {
  it("covers every group the parser can emit (no silent fallback colour in normal use)", () => {
    for (const g of BOROUGH_GROUP_ORDER) {
      expect(GROUP_COLORS[g], `missing colour for ${g}`).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(Object.keys(GROUP_COLORS).sort()).toEqual([...BOROUGH_GROUP_ORDER].sort());
  });

  it("gives every group a DISTINCT value — X and SIM shipped identical until W2", () => {
    const values = Object.values(GROUP_COLORS);
    expect(new Set(values).size).toBe(values.length);
    expect(GROUP_COLORS.X).not.toBe(GROUP_COLORS.SIM);
  });

  it("no longer contains the red/green pair that collided under deuteranopia", () => {
    const values = new Set(Object.values(GROUP_COLORS));
    expect(values.has("#dc2626")).toBe(false); // old Bronx red
    expect(values.has("#16a34a")).toBe(false); // old Brooklyn green
  });

  it("boroughColor routes a real id through the parser", () => {
    expect(boroughColor("BX12")).toBe(GROUP_COLORS.Bx);
    expect(boroughColor("SIM4")).toBe(GROUP_COLORS.SIM);
  });
});

describe("legend", () => {
  it("BOROUGH_LEGEND is in the canonical order and fully labelled", () => {
    expect(BOROUGH_LEGEND.map((b) => b.g)).toEqual(BOROUGH_GROUP_ORDER);
    for (const b of BOROUGH_LEGEND) {
      expect(b.label).toBe(boroughLabel(b.g));
      expect(b.short.length).toBeGreaterThan(0);
      expect(b.color).toBe(GROUP_COLORS[b.g]);
    }
  });
});
