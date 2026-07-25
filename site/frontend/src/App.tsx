import { Suspense, lazy, useEffect } from "react";
import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import ArcanumChrome from "./chrome/ReactChrome";
import ecosystem from "./chrome/ecosystem.json";
import Landing from "./pages/Landing";
import { trackPageview } from "./lib/beacon";

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
const WorkstationPage = lazy(() => import("./pages/WorkstationPage"));
const NotFound = lazy(() => import("./pages/NotFound"));

// W1/W5 IA flip (2026-07-24): SIX nav items → FOUR. The bar is now the four things a
// visitor comes here to open — `Maps · Observatory · Ops Wall · Data`.
//   * `Methodology` folds UNDER Data (reachable from /data and from the landing's
//     small-print line); /methodology and /code both light the "Data" item.
//   * `About` moves to the footer.
// Four items also fixes the ≤680px nav row, where `.ark-nav` wraps to a full-width
// `order: 3` band and six items formed a dense second row.
const NAV = [
  { label: "Maps", href: "/maps" },
  { label: "Observatory", href: "/observatory" },
  { label: "Ops Wall", href: "/ops" },
  { label: "Data", href: "/data" },
];

// Highlight the grouping parent in the chrome nav even on a sub-page: any /bus,
// /sidewalks, /renters, /maps path lights "Maps"; any /observatory* path lights
// "Observatory"; /methodology + /code light "Data" (they live under it now).
// Chrome compares the *returned* path to each nav href.
function navActivePath(pathname: string): string {
  if (/^\/(maps|bus|sidewalks|renters)(\/|$)/.test(pathname)) return "/maps";
  if (/^\/observatory(\/|$)/.test(pathname)) return "/observatory";
  if (/^\/(data|methodology|code)(\/|$)/.test(pathname)) return "/data";
  return pathname;
}

export default function App() {
  const location = useLocation();

  // W8 telemetry: ONE pageview beacon per path, into the /__track sink that already
  // exists, is already proxied, and is already excluded from the CF cache rule. The
  // sink was error-only, so `/api/kpis` reported nycvisualizer `present: False` and
  // "is anyone using this?" was structurally unanswerable. This is the whole change —
  // no new endpoint, no new transport, no third-party analytics, DNT/GPC still
  // respected by the shared beacon. Declared BEFORE the /live and /workstation early
  // returns so it fires on every family (hooks must be unconditional).
  useEffect(() => {
    trackPageview(location.pathname);
  }, [location.pathname]);

  // I1: the immersive ant-farm views (/live/*) are full-window — they render
  // OUTSIDE the standard chrome (no header/footer/max-width wrap). Their own
  // floating top strip + corner ⓘ overlay carry the nav + mandated dual anchors.
  if (/^\/live\//.test(location.pathname)) {
    return (
      <Suspense fallback={<div className="nyc-note" style={{ margin: "1.5rem" }}>Loading…</div>}>
        <Routes>
          <Route path="/live/bus" element={<ImmersiveMapPage mode="buses" />} />
          {/* legacy alias: keep shared /live/buses URLs working */}
          <Route path="/live/buses" element={<Navigate to={"/live/bus" + location.search} replace />} />
          <Route path="/live/subway" element={<ImmersiveMapPage mode="subway" />} />
          <Route path="*" element={<ImmersiveMapPage mode="buses" />} />
        </Routes>
      </Suspense>
    );
  }

  // C3: the UNIFIED Planner Workstation (/workstation) is a full-window family — same
  // immersive-chrome pattern, rendered OUTSIDE the standard chrome, with NO cross-family
  // SPA links (dossier hops are plain <a> full loads). It merges the two former single-mode
  // workstations: bus routes and subway lines are selectable together. The legacy paths
  // /workstation/bus?routes=… and /workstation/subway?lines=… redirect here (client-side
  // Navigate, query-preserving) so any shared workstation URL keeps its selection.
  if (/^\/workstation(\/|$)/.test(location.pathname)) {
    return (
      <Suspense fallback={<div className="nyc-note" style={{ margin: "1.5rem" }}>Loading…</div>}>
        <Routes>
          <Route path="/workstation" element={<WorkstationPage />} />
          <Route path="/workstation/bus" element={<Navigate to={"/workstation" + location.search} replace />} />
          <Route path="/workstation/subway" element={<Navigate to={"/workstation" + location.search} replace />} />
          <Route path="*" element={<Navigate to={"/workstation" + location.search} replace />} />
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
          {/* W1: the Research Triad's Outputs button pointed at /explore, which was
              NEVER a route — one of three above-the-fold buttons landed on NotFound.
              `ecosystem.json` now points Outputs at /maps; this redirect keeps any
              already-shared /explore link working instead of 404-ing it. */}
          <Route path="/explore" element={<Navigate to="/maps" replace />} />
          <Route path="/code" element={<CodePage />} />
          <Route path="/methodology" element={<MethodologyPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </ArcanumChrome>
  );
}
