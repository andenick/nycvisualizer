import { Routes, Route, useLocation } from "react-router-dom";
import ArcanumChrome from "./chrome/ReactChrome";
import ecosystem from "./chrome/ecosystem.json";
import Landing from "./pages/Landing";
import BusPage from "./pages/BusPage";
import SidewalksPage from "./pages/SidewalksPage";
import DataPage from "./pages/DataPage";
import CodePage from "./pages/CodePage";
import MethodologyPage from "./pages/MethodologyPage";
import AboutPage from "./pages/AboutPage";
import ChangesPage from "./pages/ChangesPage";
import ObservatoryPage from "./pages/ObservatoryPage";
import RouteDossierPage from "./pages/RouteDossierPage";
import LeaguesPage from "./pages/LeaguesPage";
import OpsWallPage from "./pages/OpsWallPage";
import RentersPage from "./pages/RentersPage";
import NotFound from "./pages/NotFound";

// The Observatory (S5) is the Bus Observatory: a route picker, per-route dossiers
// with the signature Marey view, reliability leagues, and the S8 service-change
// monitor. Its landing (/observatory) is the route picker; the chrome nav is flat,
// so Routes / Leagues / Service Changes live in an in-page sub-nav (ObsSubnav).
const NAV = [
  { label: "Live Transit Map", href: "/bus" },
  { label: "Ops Wall", href: "/ops" },
  { label: "Sidewalks", href: "/sidewalks" },
  { label: "Renter's Map", href: "/renters" },
  { label: "Observatory", href: "/observatory" },
  { label: "Data", href: "/data" },
  { label: "Code", href: "/code" },
  { label: "Methodology", href: "/methodology" },
  { label: "About", href: "/about" },
];

export default function App() {
  const location = useLocation();
  return (
    <ArcanumChrome
      siteKey="nycvisualizer"
      accent="#2563eb"
      accentSoft="#dbeafe"
      nav={NAV}
      dprUrl="/methodology"
      dprLabel="Methodology & sources"
      ecosystem={ecosystem as unknown as Parameters<typeof ArcanumChrome>[0]["ecosystem"]}
      activePath={location.pathname}
    >
      <Routes>
        <Route path="/" element={<Landing />} />
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
    </ArcanumChrome>
  );
}
