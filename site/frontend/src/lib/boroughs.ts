// Single source of truth for borough display ordering across every borough-grouped
// UI surface (the /bus route filter, the immersive route filter, the map legends'
// borough swatch rows, and the Observatory route picker). One list so the whole
// site reads identically: ALPHABETICAL by borough name, with the Bronx first —
// Bronx · Brooklyn · Manhattan · Queens · Staten Island — then the express /
// operator families last (they are not boroughs).

// Route-prefix group codes: Bx=Bronx, B=Brooklyn, M=Manhattan, Q=Queens,
// S=Staten Island, SIM=Staten-Island express, X=Manhattan express.
export const BOROUGH_GROUP_ORDER: string[] = ["Bx", "B", "M", "Q", "S", "SIM", "X"];

// Full borough names (Observatory `borough_group` values). Operators / unknowns
// (e.g. "MTA Bus Co.") sort after the five boroughs.
export const BOROUGH_NAME_ORDER: string[] = [
  "Bronx",
  "Brooklyn",
  "Manhattan",
  "Queens",
  "Staten Island",
  "MTA Bus Co.",
];
