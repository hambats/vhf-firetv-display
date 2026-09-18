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
