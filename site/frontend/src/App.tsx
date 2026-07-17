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
import NotFound from "./pages/NotFound";

const NAV = [
  { label: "Live Transit Map", href: "/bus" },
  { label: "Sidewalks", href: "/sidewalks" },
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
        <Route path="/sidewalks" element={<SidewalksPage />} />
        <Route path="/data" element={<DataPage />} />
        <Route path="/code" element={<CodePage />} />
        <Route path="/methodology" element={<MethodologyPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </ArcanumChrome>
  );
}
