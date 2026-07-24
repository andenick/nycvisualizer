import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

// Q0.4: subdomain spoke landing. A visitor arriving at a spoke subdomain root
// (e.g. observatory.nycvisualizer.com/) should land on that spoke, not the hub.
// We rewrite the path BEFORE BrowserRouter reads window.location, so there is no
// hub flash. Deep paths are left untouched — shared/bookmarked URLs stay valid.
(function routeSpokeSubdomain() {
  try {
    if (window.location.pathname !== "/") return; // deep paths untouched
    const host = window.location.hostname.toLowerCase();
    const SPOKES: Record<string, string> = {
      "observatory.": "/observatory",
      "ops.": "/ops",
      "renters.": "/renters",
      "changes.": "/observatory/changes",
      // I2.1: immersive full-window ant-farm subdomains
      "bus.": "/live/bus",
      "subway.": "/live/subway",
      // W3/W4: planner-workstation subdomains (PLURAL). NOTE: buses. was previously a
      // silent alias for the /live/bus ant farm; ANTFARM_V3 repurposes the plural hosts
      // for the multi-select planner workstations (the singular bus./subway. keep the
      // immersive ant farms). The trailing dot in each prefix keeps "bus." from matching
      // "buses." (host char 4 is "e", prefix char 4 is "."), so no ordering hazard.
      "buses.": "/workstation/bus",
      "subways.": "/workstation/subway",
    };
    for (const prefix in SPOKES) {
      if (host.startsWith(prefix)) {
        window.history.replaceState(null, "", SPOKES[prefix] + window.location.search);
        break;
      }
    }
  } catch {
    /* non-browser / restricted env — no-op */
  }
})();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
