/*
 * A one-shot capability check, run at startup.
 *
 * The development machine is a current desktop browser; the display is a Fire
 * OS 7 WebView, an older Chromium that nothing in this repo can pin or
 * upgrade. Every feature this page leans on degrades *silently* when it is
 * missing — no Cache Storage means no offline content, no Intl time zone
 * support means every event time is quietly wrong, no CSS custom properties
 * means an unstyled display — so the check exists to turn "the TV looks odd"
 * into a line someone can read.
 *
 * It never blocks: a missing capability is recorded and logged, and the
 * display runs with whatever it has. Refusing to start would replace a
 * degraded display with no display at all.
 *
 * ES5 only — this file has to parse on the very WebViews it is checking.
 */
(function () {
  "use strict";

  function has(fn) {
    try {
      return !!fn();
    } catch (err) {
      return false;
    }
  }

  var checks = {
    promise: has(function () { return typeof Promise === "function"; }),
    fetch: has(function () { return typeof fetch === "function"; }),
    serviceWorker: has(function () { return "serviceWorker" in navigator; }),
    cacheStorage: has(function () { return typeof caches !== "undefined"; }),
    cssVariables: has(function () {
      return window.CSS && CSS.supports && CSS.supports("(--a: 0)");
    }),
    objectFit: has(function () {
      return "objectFit" in document.documentElement.style;
    }),
    /*
     * The one that matters most, and the least obvious. events.json stores
     * UTC; the display formats through an explicit America/New_York time zone
     * so a television with a wrong or reset clock setting cannot shift every
     * event time by a fixed offset. If Intl cannot do time zones, that
     * protection is gone and nothing on screen would look wrong.
     */
    intlTimeZone: has(function () {
      var formatted = new Date("2026-07-04T16:00:00Z").toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit"
      });
      return /12:00/.test(formatted);
    })
  };

  var missing = [];
  for (var key in checks) {
    if (Object.prototype.hasOwnProperty.call(checks, key) && !checks[key]) missing.push(key);
  }

  VhfDiagnostics.set("compat", missing.length === 0 ? "ok" : "missing: " + missing.join(","));
  window.VhfCompat = checks;

  /*
   * ---- The rebuild probe ----
   *
   * Nothing above may change because of this section: those are what the
   * display relies on today. These are what a rebuild *wants* to rely on
   * (modern syntax, ES modules, newer CSS and image formats), and the rule
   * is to prove each on the television before using it (proposal F11). The
   * answer has to be readable without touching the TV, so it goes to the
   * ?diag=1 overlay and, when the heartbeat is on, into every ping body
   * (VhfCompat.summary(), read by engine.js).
   *
   * Every test runs inside has(): a syntax test is a string handed to the
   * Function constructor, so an engine that cannot parse it throws a
   * SyntaxError that is caught here instead of failing this file's parse.
   */
  function syntax(source) {
    return has(function () {
      return new Function(source)() === true;
    });
  }

  function cssSupports(property, value) {
    return has(function () {
      return window.CSS && CSS.supports && CSS.supports(property, value);
    });
  }

  var userAgent = has(function () { return navigator.userAgent; }) ? String(navigator.userAgent) : "";
  var chromeMatch = /Chrome\/(\d+)/.exec(userAgent);

  var features = {
    es2017: syntax("var f = async function () { await 0; }; return typeof f === 'function' && typeof Object.entries === 'function';"),
    es2020: syntax("var o = {}; return (o?.a ?? 1) === 1 && 1n === BigInt(1) && typeof globalThis === 'object';"),
    es2022: syntax("class A { #x = 1; static y = 2; get x() { return this.#x; } } return new A().x === 1 && [1].at(-1) === 1;"),
    dynamicImport: syntax("var f = function () { return import('./x.js'); }; return typeof f === 'function';"),
    modules: has(function () { return "noModule" in document.createElement("script"); }),
    structuredClone: has(function () { return typeof structuredClone === "function"; }),
    fetch: checks.fetch,
    abortController: has(function () { return typeof AbortController === "function"; }),
    intersectionObserver: has(function () { return typeof IntersectionObserver === "function"; }),
    resizeObserver: has(function () { return typeof ResizeObserver === "function"; }),
    cssVariables: checks.cssVariables,
    cssClamp: cssSupports("width", "clamp(1px, 2px, 3px)"),
    textWrapBalance: cssSupports("text-wrap", "balance"),
    aspectRatio: cssSupports("aspect-ratio", "16 / 9"),
    containerQueries: cssSupports("container-type", "inline-size"),
    backdropFilter: cssSupports("backdrop-filter", "blur(2px)") || cssSupports("-webkit-backdrop-filter", "blur(2px)"),
    serviceWorker: checks.serviceWorker,
    cacheStorage: checks.cacheStorage,
    visibilityChange: has(function () {
      return typeof document.visibilityState === "string" && "onvisibilitychange" in document;
    }),
    webp: null, // null until the decode test below settles
    avif: null
  };

  function summarize(withUserAgent) {
    var no = [];
    var pending = [];
    var total = 0;
    var ok = 0;
    for (var name in features) {
      if (!Object.prototype.hasOwnProperty.call(features, name)) continue;
      total += 1;
      if (features[name] === null) pending.push(name);
      else if (features[name]) ok += 1;
      else no.push(name);
    }
    var parts = [
      "chrome=" + (chromeMatch ? chromeMatch[1] : "?"),
      "ok=" + ok + "/" + total
    ];
    if (no.length) parts.push("no=" + no.join(","));
    if (pending.length) parts.push("pending=" + pending.join(","));
    if (withUserAgent) parts.push("ua=" + userAgent.slice(0, 200));
    return parts.join(" ");
  }

  function publish() {
    try {
      VhfDiagnostics.set("probe", summarize(false));
    } catch (err) { /* the overlay is optional */ }
  }

  // 1x1 images, generated with Pillow and decode-checked.
  var IMAGE_SAMPLES = {
    webp: "data:image/webp;base64,UklGRjoAAABXRUJQVlA4IC4AAADwAQCdASoBAAEAAUAmJaACdLoB+AAEyAAA/q4X/zYEDND6YP/SbPE2eJs+OYAA",
    avif: "data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADrbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAAAAAAAOcGl0bQAAAAAAAQAAAB5pbG9jAAAAAEQAAAEAAQAAAAEAAAETAAAAJwAAAChpaW5mAAAAAAABAAAAGmluZmUCAAAAAAEAAGF2MDFDb2xvcgAAAABqaXBycAAAAEtpcGNvAAAAFGlzcGUAAAAAAAAAAQAAAAEAAAAQcGl4aQAAAAADCAgIAAAADGF2MUOBAAwAAAAAE2NvbHJuY2x4AAEADQAGgAAAABdpcG1hAAAAAAAAAAEAAQQBAoMEAAAAL21kYXQSAAoIGAAGiAhoNCAyGRTHh4ZlAgggnlAAAABIWtlcu9vRQxmukxg="
  };

  function probeImage(name) {
    try {
      var image = new Image();
      var settled = false;
      var settle = function (ok) {
        if (settled) return;
        settled = true;
        features[name] = ok;
        publish();
      };
      image.onload = function () { settle(image.naturalWidth === 1); };
      image.onerror = function () { settle(false); };
      window.setTimeout(function () { settle(false); }, 5000);
      image.src = IMAGE_SAMPLES[name];
    } catch (err) {
      features[name] = false;
    }
  }

  probeImage("webp");
  probeImage("avif");
  publish();

  checks.features = features;
  checks.userAgent = userAgent;
  checks.summary = function () {
    return summarize(true);
  };

  if (missing.length > 0) {
    console.warn(
      "[VHF] this browser is missing capabilities the display relies on: " +
        missing.join(", ") +
        ". The display will still run, degraded. See web/js/compat.js."
    );
  } else {
    console.log("[VHF] compatibility check passed");
  }
})();
