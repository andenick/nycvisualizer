/* =============================================================================
   Arcanum Site Kit (ASK) — arcanum-chrome.js — v1.3 (Heterodata rebrand)
   Dependency-free, no external calls (offline rule). Progressive enhancement:
   the server-side partials already render static header+footer chrome; this
   script ENHANCES the ecosystem switcher and can BUILD the chrome DOM for
   stacks that can't use server-side includes (e.g. injected/SPA contexts).

   Usage (any stack):
     <script>
       window.ARK_CONFIG = {
         site_key: "volcker",                  // must match an ecosystem.json site.key
         accent:   "#b8860b",                  // optional; theme CSS usually sets this
         accent_soft: "#3a2e10",               // optional
         nav: [                                 // per-site nav (blueprint vocabulary)
           { label: "Explore", href: "/explore" },
           { label: "Data",    href: "/data" },
           { label: "Code",    href: "/code" },
           { label: "Methodology", href: "/methodology" },
           { label: "About",   href: "/about" }
         ],
         dpr_url: "/methodology",              // this site's provenance/DPR link
         ecosystem_url: "/static/_shared/ecosystem.json", // where to fetch the manifest
         ecosystem: {...}                       // OR embed the manifest object directly (offline-safe)
       };
     </script>
     <script src="/static/_shared/arcanum-chrome.js" defer></script>

   If JS is off, nothing breaks: the static partials remain. If a <details
   class="ark-switcher"> already exists (server-rendered), this only populates
   its menu; otherwise (mount mode) it builds header + footer.
   ============================================================================= */
(function () {
  "use strict";

  var DOC = document;
  var CFG = (window.ARK_CONFIG = window.ARK_CONFIG || {});

  /* ---- tiny DOM helpers -------------------------------------------------- */
  function el(tag, attrs, kids) {
    var n = DOC.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") n.className = attrs[k];
        else if (k === "text") n.textContent = attrs[k];
        else if (k === "html") n.innerHTML = attrs[k];
        else if (k.slice(0, 2) === "on" && typeof attrs[k] === "function") n.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
      });
    }
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === "string" ? DOC.createTextNode(c) : c); });
    return n;
  }

  /* ---- ecosystem manifest acquisition (no external calls) ---------------- */
  // Preference order: embedded object > <script type=application/json id=ark-ecosystem>
  // > same-origin fetch of ecosystem_url. All same-origin / inline → offline-safe.
  function getEcosystem(cb) {
    if (CFG.ecosystem && CFG.ecosystem.sites) return cb(CFG.ecosystem);

    var inline = DOC.getElementById("ark-ecosystem");
    if (inline && inline.textContent.trim()) {
      try { return cb(JSON.parse(inline.textContent)); } catch (e) { /* fall through */ }
    }

    var url = CFG.ecosystem_url || "/static/_shared/ecosystem.json";
    if (!window.fetch) return cb(null);
    fetch(url, { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { cb(j); })
      .catch(function () { cb(null); });
  }

  /* ---- ecosystem switcher menu (v1.5: Hub first, then live sites A-Z, then
         an "In progress" group (draft/roadmap), then "Affiliated", then the
         Architect anchor. ONE row per site. `hub_only` sites (e.g. Files) are
         skipped — they appear only in the hub's own baked menu. ---------------- */
  function buildSwitcherMenu(eco) {
    if (!eco || !eco.sites) return null;
    var menu = el("div", { class: "ark-switcher-menu", role: "menu" });

    // Hub anchor first.
    if (eco.anchors && eco.anchors.hub) {
      var hub = eco.anchors.hub;
      menu.appendChild(el("a", { class: "ark-switcher-item", href: hub.url, role: "menuitem" }, [
        el("span", { class: "ark-dot", "aria-hidden": "true" }),
        el("span", { class: "ark-si-name", text: "Hub" }),
        el("span", { class: "ark-si-host", text: hub.name })
      ]));
    }

    function siteRow(s) {
      var isCurrent = s.key === CFG.site_key;
      var planned = s.status === "planned";
      var pill = null;
      if (s.draft) pill = el("span", { class: "ark-si-pill", text: "Draft" });
      else if (s.roadmap) pill = el("span", { class: "ark-si-pill", text: "Roadmap" });
      var affiliated = s.affiliated ? el("span", { class: "ark-affiliated", text: "affiliated" }) : null;
      return el("a", {
        class: "ark-switcher-item" + (isCurrent ? " current" : "") + (planned ? " ark-planned" : ""),
        href: s.url,
        role: "menuitem",
        "aria-current": isCurrent ? "page" : null,
        "aria-disabled": planned ? "true" : null,
        style: s.accent ? ("--ark-si-accent:" + s.accent) : null
      }, [
        el("span", { class: "ark-dot", "aria-hidden": "true" }),
        el("span", { class: "ark-si-name", text: s.title || s.display || s.key }),
        pill,
        affiliated,
        el("span", { class: "ark-si-host", text: s.display || s.url })
      ]);
    }

    var visible = eco.sites.filter(function (s) { return !s.hub_only; });
    var live = visible.filter(function (s) { return !s.draft && !s.roadmap && !s.affiliated; });
    var wip = visible.filter(function (s) { return (s.draft || s.roadmap) && !s.affiliated; });
    var aff = visible.filter(function (s) { return s.affiliated; });

    live.forEach(function (s) { menu.appendChild(siteRow(s)); });
    if (wip.length) {
      menu.appendChild(el("div", { class: "ark-switcher-group", text: "In progress" }));
      wip.forEach(function (s) { menu.appendChild(siteRow(s)); });
    }
    if (aff.length) {
      menu.appendChild(el("div", { class: "ark-switcher-group", text: "Affiliated" }));
      aff.forEach(function (s) { menu.appendChild(siteRow(s)); });
    }

    // Author anchor (dual-anchor rule).
    if (eco.anchors && eco.anchors.author) {
      var author = eco.anchors.author;
      menu.appendChild(el("a", { class: "ark-switcher-item", href: author.url, role: "menuitem" }, [
        el("span", { class: "ark-dot", "aria-hidden": "true" }),
        el("span", { class: "ark-si-name", text: "Architect" }),
        el("span", { class: "ark-si-host", text: author.name })
      ]));
    }
    return menu;
  }

  function makeSwitcher(eco) {
    var menu = buildSwitcherMenu(eco);
    if (!menu) return null;
    var current = (eco.sites || []).filter(function (s) { return s.key === CFG.site_key; })[0];
    var label = current ? (current.title || current.display) : "Ecosystem";
    return el("details", { class: "ark-switcher" }, [
      el("summary", { "aria-label": "Switch site within the Arcanum Research ecosystem" }, [
        el("span", { text: label }),
        el("span", { class: "ark-caret", "aria-hidden": "true", text: "▾" })
      ]),
      menu
    ]);
  }

  /* ---- full header (mount mode only) ------------------------------------- */
  function buildHeader(eco) {
    var hubUrl = (eco && eco.anchors && eco.anchors.hub && eco.anchors.hub.url) || "https://heterodata.org";
    var current = (eco && eco.sites || []).filter(function (s) { return s.key === CFG.site_key; })[0] || {};
    var siteTitle = CFG.site_title || current.title || current.display || "";

    var nav = el("nav", { class: "ark-nav", "aria-label": "Site sections" },
      (CFG.nav || []).map(function (n) {
        var here = location.pathname.replace(/\/$/, "") === String(n.href).replace(/\/$/, "");
        return el("a", { class: "ark-nav-a" + (here ? " active" : ""), href: n.href, "aria-current": here ? "page" : null, text: n.label });
      })
    );

    var brand = el("a", { class: "ark-brand", href: hubUrl, "aria-label": "Heterodata — hub (heterodata.org)" }, [
      el("span", { class: "ark-mark", "aria-hidden": "true", html: ARK_MARK_SVG }),
      el("span", { class: "ark-brand-text" }, [
        el("span", { class: "ark-brand-name", text: "Heterodata" }),
        el("span", { class: "ark-brand-sub", text: "An Arcanum Research project" })
      ])
    ]);

    var inner = el("div", { class: "ark-header-inner" }, [
      brand,
      siteTitle ? el("a", { class: "ark-site-title", href: current.url || "/", text: siteTitle }) : null,
      makeSwitcher(eco),
      nav
    ]);
    return el("header", { class: "ark-header" }, [inner]);
  }

  /* ---- full footer (mount mode only) — DUAL ANCHORS ---------------------- */
  function buildFooter(eco) {
    var hub = (eco && eco.anchors && eco.anchors.hub) || { name: "heterodata.org", url: "https://heterodata.org" };
    var author = (eco && eco.anchors && eco.anchors.author) || { name: "nickanderson.us", url: "https://nickanderson.us" };

    function sep() { return el("span", { class: "ark-sep", "aria-hidden": "true", text: "·" }); }

    var kids = [
      el("span", {}, [el("strong", { text: "Heterodata" }), " — an Arcanum Research project"]), sep(),
      el("span", {}, ["Hub: ", el("a", { href: hub.url, text: "heterodata.org" })]), sep(),
      el("span", {}, ["Architect: ", el("a", { href: author.url, text: author.name })]), sep(),
      el("span", { class: "ark-foot-badges" }, [
        el("span", { class: "ark-badge reproducible", text: "Reproducible" }),
        el("span", { class: "ark-badge offline", text: "Offline" }),
        el("span", { class: "ark-badge real-data", text: "Real data" })
      ])
    ];
    if (CFG.dpr_url) {
      kids.push(sep(), el("a", { href: CFG.dpr_url, text: "Provenance" }));
    }
    // EDUCATIONAL_DISCLAIMER_STANDARD.md placement #1 (site-wide footer). Default-on;
    // per-site opt-out via CFG.disclaimer === false. Single-source with the Jinja partial.
    var footKids = [];
    if (CFG.disclaimer !== false) {
      var dtext = CFG.disclaimer_text || DISCLAIMER_TEXT;
      var dnode = el("p", { class: "ark-footer-disclaimer", role: "note", text: dtext });
      if (CFG.disclaimer_source) {
        dnode.appendChild(DOC.createTextNode(" "));
        dnode.appendChild(el("span", { class: "ark-disclaimer-source", text: "Original source: " + CFG.disclaimer_source + "." }));
      }
      footKids.push(dnode);
    }
    footKids.push(el("div", { class: "ark-footer-inner" }, kids));
    return el("footer", { class: "ark-footer" }, footKids);
  }

  // Canonical educational-disclaimer text (EDUCATIONAL_DISCLAIMER_STANDARD.md).
  var DISCLAIMER_TEXT =
    "The data on this site is reconstructed for research transparency and education. " +
    "It may lag official revisions or contain reconstruction error, and it is not a " +
    "substitute for the original source. For authoritative figures, defer to the named " +
    "original source for each dataset.";

  /* ---- leaked-comment scrub (defense in depth, F-9B-02 / FD-21) ----------
     An internal KB source marker (`<!-- kb: chNN, <section> -->`) can leak into
     rendered prose as VISIBLE text when a markdown/explainer renderer emits it
     escaped instead of stripping it. The export-side scrubber is the primary
     fix; this is the kit-layer backstop: on every page, strip any literal
     `<!-- ... -->` substring from text nodes inside prose / explainer / quote
     containers so an internal marker never reaches the reader. Operates only on
     text-node content (never removes real DOM), so it cannot damage layout. */
  var LEAKED_COMMENT_RE = /<!--[\s\S]*?-->/g;
  function stripLeakedComments(root) {
    var scopes = (root || DOC).querySelectorAll(
      ".ark-prose, .ark-explainer, .ark-from-book, blockquote, .explainer, figcaption, .ark-card");
    scopes.forEach(function (scope) {
      var walker = DOC.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
      var n, hits = [];
      while ((n = walker.nextNode())) { if (n.nodeValue && n.nodeValue.indexOf("<!--") !== -1) hits.push(n); }
      hits.forEach(function (t) {
        t.nodeValue = t.nodeValue.replace(LEAKED_COMMENT_RE, "").replace(/[ \t]{2,}/g, " ");
      });
    });
  }

  /* ---- copy-button wiring (for .ark-code .ark-copy) ---------------------- */
  function wireCopyButtons(root) {
    (root || DOC).querySelectorAll(".ark-copy").forEach(function (btn) {
      if (btn.__arkWired) return;
      btn.__arkWired = true;
      btn.addEventListener("click", function () {
        var fig = btn.closest(".ark-code");
        var src = fig && (fig.querySelector("pre code") || fig.querySelector("pre"));
        var text = src ? src.textContent : "";
        var done = function () {
          var o = btn.textContent; btn.textContent = "Copied"; btn.disabled = true;
          setTimeout(function () { btn.textContent = o || "Copy"; btn.disabled = false; }, 1400);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); });
        } else { fallback(text); done(); }
      });
    });
    function fallback(t) {
      var ta = el("textarea", { style: "position:fixed;opacity:0" }); ta.value = t;
      DOC.body.appendChild(ta); ta.select();
      try { DOC.execCommand("copy"); } catch (e) { }
      DOC.body.removeChild(ta);
    }
  }

  /* ---- light/dark theme toggle (follow system, then remember) ------------ */
  function effectiveDark() {
    var t = DOC.documentElement.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function savedTheme() { try { return localStorage.getItem("ark-theme"); } catch (e) { return null; } }
  function applySavedTheme() { var s = savedTheme(); if (s === "dark" || s === "light") DOC.documentElement.dataset.theme = s; }
  function updateThemeToggleUI() {
    DOC.querySelectorAll(".ark-theme-toggle").forEach(function (b) {
      var dark = effectiveDark();
      b.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
      b.setAttribute("aria-pressed", dark ? "true" : "false");
      b.title = dark ? "Light mode" : "Dark mode";
    });
  }
  function setTheme(mode) {
    DOC.documentElement.dataset.theme = mode;
    try { localStorage.setItem("ark-theme", mode); } catch (e) { }
    updateThemeToggleUI();
    DOC.dispatchEvent(new CustomEvent("ark:themechange", { detail: { theme: mode } }));
  }
  function wireTheme(root) {
    applySavedTheme();
    (root || DOC).querySelectorAll(".ark-theme-toggle").forEach(function (b) {
      if (b.__arkThemeWired) return; b.__arkThemeWired = true;
      b.addEventListener("click", function () { setTheme(effectiveDark() ? "light" : "dark"); });
    });
    updateThemeToggleUI();
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onSys = function () {
        var s = savedTheme();
        if (s !== "dark" && s !== "light") { updateThemeToggleUI(); DOC.dispatchEvent(new CustomEvent("ark:themechange", { detail: { theme: "system" } })); }
      };
      if (mq.addEventListener) mq.addEventListener("change", onSys); else if (mq.addListener) mq.addListener(onSys);
    }
  }

  /* ---- public API + auto-init -------------------------------------------- */
  function enhance(eco) {
    // 1) If a server-rendered switcher exists but has an empty menu, populate it.
    DOC.querySelectorAll(".ark-switcher").forEach(function (sw) {
      var existing = sw.querySelector(".ark-switcher-menu");
      if (existing && existing.children.length > 0) return; // already populated server-side
      var menu = buildSwitcherMenu(eco);
      if (!menu) return;
      if (existing) existing.replaceWith(menu); else sw.appendChild(menu);
    });

    // 2) Mount mode: explicit placeholders get full chrome built in.
    var hMount = DOC.querySelector("[data-ark-header]");
    if (hMount && !hMount.children.length) hMount.appendChild(buildHeader(eco));
    var fMount = DOC.querySelector("[data-ark-footer]");
    if (fMount && !fMount.children.length) fMount.appendChild(buildFooter(eco));

    // 3) Copy buttons everywhere.
    wireCopyButtons(DOC);

    // 3b) Strip any leaked internal `<!-- ... -->` markers from rendered prose.
    stripLeakedComments(DOC);

    // 4) Light/dark toggle (follow system, then remember).
    wireTheme(DOC);
  }

  var API = {
    config: CFG,
    getEcosystem: getEcosystem,
    buildHeader: buildHeader,
    buildFooter: buildFooter,
    buildSwitcher: makeSwitcher,
    wireCopyButtons: wireCopyButtons,
    setTheme: setTheme,
    wireTheme: wireTheme,
    effectiveDark: effectiveDark,
    /** Mount full chrome into a container (SPA / injected use). */
    mount: function (opts) {
      Object.assign(CFG, opts || {});
      getEcosystem(function (eco) {
        eco = eco || (CFG.ecosystem || {});
        var host = (opts && opts.header) || DOC.querySelector("[data-ark-header]");
        var foot = (opts && opts.footer) || DOC.querySelector("[data-ark-footer]");
        if (host) { host.innerHTML = ""; host.appendChild(buildHeader(eco)); }
        if (foot) { foot.innerHTML = ""; foot.appendChild(buildFooter(eco)); }
        wireCopyButtons(DOC);
      });
    }
  };
  window.ArcanumChrome = API;

  // Inline favicon mark (kept in sync with favicon/favicon.svg).
  var ARK_MARK_SVG =
    '<svg viewBox="0 0 32 32" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">' +
    '<path d="M16 3 4 27h5l2.4-5h9.2l2.4 5h5L16 3Zm-2.7 14L16 11l2.7 6h-5.4Z" fill="currentColor"/>' +
    '<circle cx="16" cy="25.5" r="1.6" fill="currentColor"/></svg>';

  function init() { getEcosystem(function (eco) { enhance(eco || (CFG.ecosystem || {})); }); }
  if (DOC.readyState === "loading") DOC.addEventListener("DOMContentLoaded", init);
  else init();
})();
