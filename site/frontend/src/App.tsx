import { Suspense, lazy } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import ArcanumChrome from "./chrome/ReactChrome";
import ecosystem from "./chrome/ecosystem.json";
import Landing from "./pages/Landing";

// Q4.2: per-spoke code-splitting. The heavy map/chart pages (Leaflet + protomaps +
// the dossier stack) are each their own lazy chunk so the landing first paint no
// longer ships them. Leaflet/protomaps are imported by several lazy pages, so
// Rollup hoists them into ONE shared vendor chunk — no double-include. Plotly stays
// a separate deferred chunk (ArkPlotly dynamic-imports it behind IntersectionObserver).
// Landing stays eager: it is the entry page, so a Suspense flash there would be a
// regression, and its own weight is light (no Leaflet).
const BusPage = lazy(() => import("./pages/BusPage"));
const SidewalksPage = lazy(() => import("./pages/SidewalksPage"));
const DataPage = lazy(() => import("./pages/DataPage"));
const CodePage = lazy(() => import("./pages/CodePage"));
const MethodologyPage = lazy(() => import("./pages/MethodologyPage"));
const AboutPage = lazy(() => import("./pages/AboutPage"));
const ChangesPage = lazy(() => import("./pages/ChangesPage"));
const ObservatoryPage = lazy(() => import("./pages/ObservatoryPage"));
const RouteDossierPage = lazy(() => import("./pages/RouteDossierPage"));
const LeaguesPage = lazy(() => import("./pages/LeaguesPage"));
const OpsWallPage = lazy(() => import("./pages/OpsWallPage"));
const RentersPage = lazy(() => import("./pages/RentersPage"));
const MapsPage = lazy(() => import("./pages/MapsPage"));
const ImmersiveMapPage = lazy(() => import("./pages/ImmersiveMapPage"));
const NotFound = lazy(() => import("./pages/NotFound"));

// Q4.1 IA rework: the flat 9-item bar becomes a spoke-first grouped nav. The shared
// chrome NavItem is flat (no dropdowns), so grouping is expressed with two SECTION
// LANDINGS — "Maps" (→ /maps, the three interactive maps) and "Observatory"
// (→ /observatory, the route picker) — each of which carries an in-page sub-nav
// strip (MapsSubnav / ObsSubnav). Ops Wall, Data, Methodology, and About stay
// top-level. Code drops off the bar (reachable from the Data page) to keep the bar
// to six items that wrap cleanly on mobile.
const NAV = [
  { label: "Maps", href: "/maps" },
  { label: "Observatory", href: "/observatory" },
  { label: "Ops Wall", href: "/ops" },
  { label: "Data", href: "/data" },
  { label: "Methodology", href: "/methodology" },
  { label: "About", href: "/about" },
];

// Highlight the grouping parent in the chrome nav even on a sub-page: any /bus,
// /sidewalks, /renters, /maps path lights "Maps"; any /observatory* path lights
// "Observatory". Chrome compares the *returned* path to each nav href.
function navActivePath(pathname: string): string {
  if (/^\/(maps|bus|sidewalks|renters)(\/|$)/.test(pathname)) return "/maps";
  if (/^\/observatory(\/|$)/.test(pathname)) return "/observatory";
  return pathname;
}

export default function App() {
  const location = useLocation();

  // I1: the immersive ant-farm views (/live/*) are full-window — they render
  // OUTSIDE the standard chrome (no header/footer/max-width wrap). Their own
  // floating top strip + corner ⓘ overlay carry the nav + mandated dual anchors.
  if (/^\/live\//.test(location.pathname)) {
    return (
      <Suspense fallback={<div className="nyc-note" style={{ margin: "1.5rem" }}>Loading…</div>}>
        <Routes>
          <Route path="/live/buses" element={<ImmersiveMapPage mode="buses" />} />
          <Route path="/live/subway" element={<ImmersiveMapPage mode="subway" />} />
          <Route path="*" element={<ImmersiveMapPage mode="buses" />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <ArcanumChrome
      siteKey="nycvisualizer"
      accent="#2563eb"
      accentSoft="#dbeafe"
      nav={NAV}
      dprUrl="/methodology"
      dprLabel="Methodology & sources"
      ecosystem={ecosystem as unknown as Parameters<typeof ArcanumChrome>[0]["ecosystem"]}
      activePath={navActivePath(location.pathname)}
    >
      <Suspense fallback={<div className="nyc-note" style={{ margin: "1.5rem 0" }}>Loading…</div>}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/maps" element={<MapsPage />} />
          <Route path="/bus" element={<BusPage />} />
          <Route path="/ops" element={<OpsWallPage />} />
          <Route path="/sidewalks" element={<SidewalksPage />} />
          <Route path="/renters" element={<RentersPage />} />
          <Route path="/observatory" element={<ObservatoryPage />} />
          <Route path="/observatory/leagues" element={<LeaguesPage />} />
          <Route path="/observatory/changes" element={<ChangesPage />} />
          <Route path="/observatory/:route" element={<RouteDossierPage />} />
          <Route path="/data" element={<DataPage />} />
          <Route path="/code" element={<CodePage />} />
          <Route path="/methodology" element={<MethodologyPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </ArcanumChrome>
  );
}
