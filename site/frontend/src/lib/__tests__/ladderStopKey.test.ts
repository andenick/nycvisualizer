// The one claim the Route Ladder makes that is a claim about DATA rather than about
// pixels: **a ladder click and a map click are the same act**. That only holds if the
// ladder mints byte-identical selection keys to the ones the workstation's snap index
// mints, and folds them in with the same capped/oldest-evicted primitive. If those two
// ever drift, a ladder selection and a map selection would produce different shareable
// links for the same stop — silently, and only on the link.
//
// Lives in lib/__tests__ (not beside the component) because vitest.config.ts scopes the
// node-environment suite to the pure modules under src/flow and src/lib. Nothing here
// renders: it imports one pure key-minting function and the selection primitive.

import { describe, expect, it } from "vitest";
import { ladderStopKey } from "../../components/RouteLadder";
import { buildSnapIndex, toggleCapped, type SnapStop } from "../stopGeo";

describe("ladder <-> map selection parity", () => {
  it("mints the same namespaced key the snap index mints for a bus stop", () => {
    const shapes = new Map([
      [
        "M15",
        {
          stops: [
            {
              stop_id: "405083",
              stop_name: "SOUTH ST/WHITEHALL ST",
              lat: 40.7018,
              lon: -74.0113,
            },
          ],
        },
      ],
    ]);
    const idx = buildSnapIndex(["M15"], shapes, [], null, () => "");
    const fromMap = idx.nearest(40.7018, -74.0113, 100);
    expect(fromMap).not.toBeNull();
    expect(ladderStopKey({ stop_id: "405083" })).toBe(fromMap?.key);
    expect(ladderStopKey({ stop_id: "405083" })).toBe("b:405083");
  });

  it("never collides with a subway station key", () => {
    expect(ladderStopKey({ stop_id: "101" })).not.toBe("s:101");
  });

  it("toggles and caps exactly as the map's selection does", () => {
    const mk = (id: string): SnapStop => ({
      key: ladderStopKey({ stop_id: id }),
      stopId: id,
      name: "stop " + id,
      lat: 40.75,
      lon: -73.97,
      kind: "bus",
      routes: ["M15"],
    });
    // click-a-stop-again-to-remove
    const one = toggleCapped([], mk("1"), 3);
    expect(one.map((s) => s.key)).toEqual(["b:1"]);
    expect(toggleCapped(one, mk("1"), 3)).toEqual([]);
    // hard cap, OLDEST evicted — the unbounded-DOM failure mode does not return
    let sel: SnapStop[] = [];
    for (const id of ["1", "2", "3", "4"]) sel = toggleCapped(sel, mk(id), 3);
    expect(sel.map((s) => s.key)).toEqual(["b:2", "b:3", "b:4"]);
  });
});
