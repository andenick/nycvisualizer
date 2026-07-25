// W5 (2026-07-24): this page carried a SECOND full Research Triad (the landing page had
// the first). Two hero triads on one small site is noise, and About is not where a
// visitor goes to fetch a bundle. Deleted here — the triad now lives once on /data, plus
// the compact one in the action footer that every page already carries.
import { ContextCallouts } from "../components/ContextCallout";

export default function AboutPage() {
  return (
    <div>
      <h1 style={{ margin: "0.6rem 0" }}>About</h1>
      <p className="lede" style={{ maxWidth: "64ch" }}>
        nycvisualizer is the home of all NYC visualization work &mdash; a hub built
        around one question at the finest measurable grain: <em>where can you go, and can you walk
        there?</em>
      </p>

      <section className="nyc-section">
        <h2>The hub and its spokes</h2>
        <p>
          The site is architected as a hub-with-spokes. The first two spokes are built: the{" "}
          <a href="/bus">Live Transit Map</a> (every MTA bus and subway train, ~30-second refresh,
          honest data-age stamps) and the <a href="/sidewalks">Sidewalk Explorer</a> (coverage,
          width, equity, condition, and ADA access for 96,553 street segments, plus the Stop
          Accessibility Index for all 13,621 bus stops &mdash; the cross-flagship join nobody else
          publishes). Future NYC visualizations mount as new sections or spoke subdomains, admitted
          only if they fit the thesis at fine spatial grain.
        </p>
      </section>

      <section className="nyc-section">
        <h2>Why the network looks like this</h2>
        <p style={{ maxWidth: "68ch" }}>
          The map we render live is the residue of a century of argument about who the city is for —
          Moses&rsquo;s highways and Jacobs&rsquo;s streets, and the subway that made a dense New York
          possible in the first place. A few voices from the historical record we keep beside the
          live data:
        </p>
        <ContextCallouts anchor="about" />
      </section>

      <section className="nyc-section">
        <h2>Data sources &amp; credit</h2>
        <p>
          Built entirely on authentic public data: <strong>NYC Open Data</strong> (DCP planimetrics,
          CSCL, pedestrian ramps, 311, street trees, census geographies),{" "}
          <strong>the MTA</strong> (GTFS static + realtime, BusTime, hourly ridership, segment
          speeds), <strong>NYC City Planning BYTES</strong> (PLUTO, NTA), and the{" "}
          <strong>U.S. Census Bureau</strong> (PL 94-171, ACS, LODES, TIGER). Basemap &copy;{" "}
          OpenStreetMap contributors via Protomaps, self-hosted. Sidewalk width method after Meli
          Harvey's sidewalkwidths.nyc (2020). Long-run cordon history from the{" "}
          <strong>NYMTC Hub Bound Travel Report</strong>.
        </p>
        <p>
          Congestion-pricing context on the speed pages draws on two peer studies: Cook, Kreidieh,
          Vasserman, Allcott et al., <em>The Short-Run Effects of Congestion Pricing in New York
          City</em> (NBER Working Paper 33584, 2025), and Li, Zhuang et al. (MIT), <em>Public transit
          gains and spatially uneven travel demand changes after NYC congestion pricing</em>{" "}
          (arXiv:2606.17530, 2026).
        </p>
        <p className="nyc-note">
          Real data only: unbuilt views show an honestly-labeled roadmap; estimated positions and
          proxy measures are labeled as such, with caveats on the{" "}
          <a href="/methodology">Methodology</a> page.
        </p>
      </section>

      <section className="nyc-section">
        <h2>About this project</h2>
        <p>
          NYC Visualizer is a standalone product built and maintained by Nick Anderson, and listed on
          his personal site <a href="https://nickanderson.us">nickanderson.us</a>. Code:{" "}
          <a href="https://github.com/andenick/nycvisualizer">github.com/andenick/nycvisualizer</a>.
        </p>
        <p className="nyc-note">
          Not affiliated with the MTA or the City of New York. Data presented as-is from public
          sources.
        </p>
      </section>
    </div>
  );
}
