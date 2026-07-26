// W14 (2026-07-25) — the house-number legend toggle, shared by every map surface.
//
// W3 put OSM house numbers on buildings at display zoom >= 17. The user reported the
// next day that zooming in filled the screen with numbers and the map stopped being a
// map — which it does: about 45 % of NYC building features carry `addr_housenumber`, so
// a dense block draws hundreds of them. W3 was verified as "do the numbers render?" and
// they did, at every zoom tested. The check that was missing is **aggregate legibility**
// — not "does the label draw" but "is the map still readable once they all draw."
//
// So the numbers are now OFF by default and available on request, remembered across
// visits like the other map preferences. Raising the zoom gate instead was rejected: it
// buries the same wall one zoom deeper.
//
// One component, three surfaces (/bus, /live/*, /workstation) — they all share
// `lib/basemap.ts`, and the preference is global, so flipping it on one map flips it on
// every mounted map at once.

import { useState } from "react";
import { houseNumbersOn, setHouseNumbers, STREET_NUMBER_MIN_ZOOM } from "../lib/basemap";

export default function HouseNumberToggle({ id }: { id: string }) {
  const [on, setOn] = useState(houseNumbersOn);
  return (
    <label className="ws-legend-toggle" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked);
          setHouseNumbers(e.target.checked);
        }}
      />
      Show OSM <strong>house numbers</strong> on buildings
      <span className="ws-hint">
        {" "}
        — off by default, because at z{STREET_NUMBER_MIN_ZOOM} and closer a dense block
        draws hundreds of them and the map stops being readable. Coverage is volunteered
        and patchy (roughly 0.8&ndash;1.6 numbered points per mapped building, denser in
        Manhattan and Brooklyn than in Queens or Staten Island), and the tiles carry the
        number only, never the street name. Street <em>names</em> are a different layer
        and always render.
      </span>
    </label>
  );
}
