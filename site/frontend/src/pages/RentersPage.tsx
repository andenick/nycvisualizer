// Renter's Map (S7) — "Where would you actually be living?"
// Address search (debounced) + click-anywhere-on-map → a plain-language, fully
// sourced place profile: transit, jobs reachable, quality-of-life percentiles,
// flood exposure, and the actual buildings on the block. Compare mode puts two
// locations side by side (the apartment-hunt use case). All state is in the URL
// (?address= / ?ll=lat,lon, plus b_ for the compare side) so any view is shareable.
//
// Fair-housing: this describes PLACES, not people. No demographic or protected-
// class variable feeds any score. The disclaimer is pinned to every scorecard.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import RentersMap from "../components/RentersMap";
import RenterScorecard from "../components/RenterScorecard";
import { ContextCallouts } from "../components/ContextCallout";
import KnowDontKnow from "../components/KnowDontKnow";
import { getRentersProfile, type RenterProfile } from "../lib/api";

const A_COLOR = "#2563eb";
const B_COLOR = "#9333ea";

interface SideState {
  profile: RenterProfile | null;
  loading: boolean;
  error: string | null;
}
const EMPTY: SideState = { profile: null, loading: false, error: null };

function parseLL(s: string | null): { lat: number; lon: number } | null {
  if (!s) return null;
  const [a, b] = s.split(",").map((x) => Number(x.trim()));
  if (Number.isFinite(a) && Number.isFinite(b)) return { lat: a, lon: b };
  return null;
}

export default function RentersPage() {
  const [params, setParams] = useSearchParams();
  const [a, setA] = useState<SideState>(EMPTY);
  const [b, setB] = useState<SideState>(EMPTY);
  const [inputA, setInputA] = useState("");
  const [inputB, setInputB] = useState("");
  const compare = params.get("compare") === "1" || params.has("b_address") || params.has("b_ll");

  // guard against refetching the same query
  const loadedRef = useRef<{ a: string; b: string }>({ a: "", b: "" });

  const loadSide = useCallback(
    async (side: "a" | "b", key: string, q: Parameters<typeof getRentersProfile>[0]) => {
      const set = side === "a" ? setA : setB;
      set({ profile: null, loading: true, error: null });
      try {
        const p = await getRentersProfile(q);
        // resolve only if this is still the intended query
        if (loadedRef.current[side] !== key) return;
        if (p.error) set({ profile: null, loading: false, error: p.error });
        else set({ profile: p, loading: false, error: null });
      } catch (e) {
        if (loadedRef.current[side] !== key) return;
        set({ profile: null, loading: false, error: e instanceof Error ? e.message : "request failed" });
      }
    },
    [],
  );

  // URL -> data. Single load path; keyed so we never refetch an unchanged side.
  // A and B loads are SERIALIZED (await A, then B): the backend opens a DuckDB
  // connection per request that ATTACHes the shared geo DB under a fixed alias,
  // and two builds running at the same instant collide ("Unique file handle
  // conflict"). Sequencing the two profile calls avoids that and also sidesteps
  // the /compare endpoint (which gathers both concurrently and hits the same bug).
  useEffect(() => {
    const addr = params.get("address");
    const ll = parseLL(params.get("ll"));
    const aKey = addr ? `addr:${addr}` : ll ? `ll:${ll.lat},${ll.lon}` : "";
    const bAddr = params.get("b_address");
    const bll = parseLL(params.get("b_ll"));
    const bKey = bAddr ? `addr:${bAddr}` : bll ? `ll:${bll.lat},${bll.lon}` : "";

    const tasks: (() => Promise<void>)[] = [];
    if (aKey && aKey !== loadedRef.current.a) {
      loadedRef.current.a = aKey;
      if (addr) setInputA(addr);
      tasks.push(() => loadSide("a", aKey, addr ? { address: addr } : { lat: ll!.lat, lon: ll!.lon }));
    } else if (!aKey) {
      loadedRef.current.a = "";
      setA(EMPTY);
    }
    if (bKey && bKey !== loadedRef.current.b) {
      loadedRef.current.b = bKey;
      if (bAddr) setInputB(bAddr);
      tasks.push(() => loadSide("b", bKey, bAddr ? { address: bAddr } : { lat: bll!.lat, lon: bll!.lon }));
    } else if (!bKey) {
      loadedRef.current.b = "";
      setB(EMPTY);
    }
    if (tasks.length) void (async () => { for (const t of tasks) await t(); })();
  }, [params, loadSide]);

  // debounced auto-search for side A
  const debTimer = useRef<number | null>(null);
  useEffect(() => {
    const v = inputA.trim();
    if (v.length < 4) return;
    if (params.get("address") === v) return;
    if (debTimer.current) window.clearTimeout(debTimer.current);
    debTimer.current = window.setTimeout(() => {
      setParams((prev) => {
        const n = new URLSearchParams(prev);
        n.set("address", v);
        n.delete("ll");
        return n;
      });
    }, 700);
    return () => {
      if (debTimer.current) window.clearTimeout(debTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputA]);

  const submitA = (e: React.FormEvent) => {
    e.preventDefault();
    const v = inputA.trim();
    if (!v) return;
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      n.set("address", v);
      n.delete("ll");
      return n;
    });
  };
  const submitB = (e: React.FormEvent) => {
    e.preventDefault();
    const v = inputB.trim();
    if (!v) return;
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      n.set("b_address", v);
      n.delete("b_ll");
      n.set("compare", "1");
      return n;
    });
  };
  const onPick = (lat: number, lon: number) => {
    setInputA("");
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      n.set("ll", `${lat},${lon}`);
      n.delete("address");
      return n;
    });
  };
  const enterCompare = () =>
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      n.set("compare", "1");
      return n;
    });
  const exitCompare = () => {
    setInputB("");
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      n.delete("compare");
      n.delete("b_address");
      n.delete("b_ll");
      return n;
    });
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
        <h1 style={{ margin: "0.6rem 0" }}>Renter&rsquo;s Map</h1>
        <span className="nyc-pill live" style={{ padding: "0.2rem 0.6rem" }}>Live</span>
      </div>
      <p className="nyc-note" style={{ marginTop: 0 }}>
        Search an address or click anywhere on the map to see what living there is actually like — how
        far transit gets you, how many jobs are reachable, how the block ranks citywide for noise,
        pedestrian safety, rodents, trees and sidewalks, its flood exposure, and the real buildings on
        it. Every number is from open NYC data and shown with citywide context. This describes places,
        not people.
      </p>

      {/* search row */}
      <div className="rent-search">
        <form onSubmit={submitA} className="rent-search-form">
          <input
            type="text"
            value={inputA}
            onChange={(e) => setInputA(e.target.value)}
            placeholder={compare ? "Address A (e.g. 120 Broadway)" : "Search an address (e.g. 120 Broadway)"}
            aria-label="Address A"
            autoComplete="off"
          />
          <button type="submit">Search</button>
        </form>
        {compare ? (
          <form onSubmit={submitB} className="rent-search-form">
            <input
              type="text"
              value={inputB}
              onChange={(e) => setInputB(e.target.value)}
              placeholder="Address B (e.g. 10 Richmond Terrace, Staten Island)"
              aria-label="Address B"
              autoComplete="off"
            />
            <button type="submit">Compare</button>
            <button type="button" className="rent-ghost" onClick={exitCompare}>
              Exit
            </button>
          </form>
        ) : (
          <button type="button" className="rent-ghost" onClick={enterCompare} disabled={!a.profile}>
            + Compare a second place
          </button>
        )}
      </div>

      <RentersMap
        primary={a.profile}
        secondary={b.profile}
        compare={compare}
        onPick={onPick}
      />

      {/* status */}
      {(a.loading || b.loading) && (
        <p className="nyc-note" style={{ marginTop: "0.8rem" }}>
          Loading profile{compare ? "s" : ""}… (the 45-minute isochrone is computed live and may take a
          few seconds the first time a place is queried; it is cached afterwards).
        </p>
      )}
      {a.error && <p className="rent-err">Address A: {a.error}</p>}
      {b.error && <p className="rent-err">Address B: {b.error}</p>}

      {/* scorecards */}
      {(a.profile || b.profile) && (
        <div className={compare ? "rent-compare" : "rent-single"}>
          {a.profile && (
            <RenterScorecard
              profile={a.profile}
              other={compare ? b.profile : null}
              label={compare ? "A" : undefined}
              accent={A_COLOR}
            />
          )}
          {compare && b.profile && (
            <RenterScorecard profile={b.profile} other={a.profile} label="B" accent={B_COLOR} />
          )}
        </div>
      )}

      {!a.profile && !a.loading && !a.error && (
        <div className="nyc-roadmap" style={{ marginTop: "1.2rem" }}>
          <h3>Try an address</h3>
          <p style={{ margin: "0.4rem 0 0.6rem" }}>
            Or click a spot on the map. A few to start:
          </p>
          <div className="rent-examples">
            {[
              "120 Broadway, Manhattan",
              "10 Richmond Terrace, Staten Island",
              "480 Van Brunt St, Brooklyn",
              "161 East 161 Street, Bronx",
              "40-24 74 Street, Queens",
            ].map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => {
                  setInputA(ex);
                  setParams((prev) => {
                    const n = new URLSearchParams(prev);
                    n.set("address", ex);
                    n.delete("ll");
                    return n;
                  });
                }}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      <section className="nyc-section" style={{ marginTop: "1.6rem" }}>
        <h2>How to read this</h2>
        <p className="nyc-note" style={{ marginTop: 0 }}>
          Each bar shows how this place ranks against every populated block in NYC, phrased so a longer
          bar is always the better outcome (we invert the direction for things where less is better, like
          noise or crashes, and say so). Scores use only place-and-infrastructure data — transit,
          311 complaint patterns, street conditions, flood maps, and public building records. No
          demographic or protected-class information is used anywhere. This is not a credit score or a
          tenant-screening report. Sources and methods are on the{" "}
          <a href="/methodology">Methodology</a> page.
        </p>
        {/* KB context: the city frames access as an equity question */}
        <ContextCallouts anchor="renters" />
      </section>

      <section className="nyc-section">
        <h2>What we can and can&rsquo;t say yet</h2>
        <KnowDontKnow
          scope="a place profile"
          dated="2026-07-23"
          can={[
            { text: "For any address: how far transit gets you, how many jobs are reachable in 45 minutes, and how the block ranks citywide on noise, pedestrian safety, rodents, trees, and sidewalks — all from open NYC data." },
            { text: "The real buildings on the block — units, age, owner portfolio, and open HPD/DOB records — joined by BBL." },
            { text: "Flood exposure (FEMA firm + stormwater) at the parcel." },
          ]}
          cannot={[
            { text: "Rent, availability, or listing prices.", closes: "→ no open, address-level rent feed exists; we describe the place, not the market." },
            { text: "Anything about the people who live there.", closes: "→ by design — no demographic or protected-class variable feeds any score (the fair-housing bright line)." },
            { text: "All-day or weekend transit access.", closes: "→ the isochrone is a weekday-8am snapshot; off-peak departure windows would round it out." },
          ]}
        />
      </section>
    </div>
  );
}
