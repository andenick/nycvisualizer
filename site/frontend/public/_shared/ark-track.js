/* =============================================================================
   Arcanum Site Kit — ark-track.js — v1.1
   Tiny FIRST-PARTY usage beacon for stacks that don't emit a pageview event
   server-side (Streamlit, React/SPA, static sites).
   Sends ONE pageview event {site, path, ref, ts} to a same-origin (or
   configured) endpoint. No cookies, no PII, no third party. Respects DNT.

   Usage:
     <script>window.ARK_TRACK = { site:"heterodata", endpoint:"/__track" };</script>
     <script src="/_shared/ark-track.js" defer></script>
   The endpoint is a first-party telemetry endpoint fronted by the site. If the
   site has no backend (pure static), point `endpoint` at your own collector
   hostname.
   ============================================================================= */
(function () {
  "use strict";
  try {
    var C = window.ARK_TRACK || {};
    // Honor Do-Not-Track / Global Privacy Control.
    var dnt = navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.globalPrivacyControl === true;
    if (dnt) return;
    var site = C.site || (window.ARK_CONFIG && window.ARK_CONFIG.site_key) || location.hostname;
    var endpoint = C.endpoint || "/__track";
    var payload = JSON.stringify({
      site: site,
      path: location.pathname,
      ref: document.referrer ? new URL(document.referrer, location.href).hostname : "",
      ts: Math.floor(Date.now() / 1000) // server re-stamps; client ts is advisory
    });
    // CORS (v1.2 fix): the shared collector answers with
    // `Access-Control-Allow-Origin: *`, which browsers REJECT for any
    // credentialed request. navigator.sendBeacon ALWAYS sends credentials
    // (cookies) and offers no way to omit them, so a cross-origin beacon from a
    // static site (nickanderson, hmda) is silently blocked — zero telemetry.
    // Prefer a keepalive fetch with credentials:"omit" + mode:"cors" (same
    // fire-and-forget survival as sendBeacon, but wildcard-CORS compatible); the
    // collector handles the application/json preflight (do_OPTIONS). Only fall
    // back to sendBeacon where fetch is unavailable (same-origin still delivers).
    if (window.fetch) {
      fetch(endpoint, { method: "POST", body: payload, headers: { "Content-Type": "application/json" }, keepalive: true, mode: "cors", credentials: "omit" }).catch(function () {});
    } else if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([payload], { type: "application/json" }));
    }
  } catch (e) { /* tracking must never break a page */ }
})();
