/*
 * The single place that decides cache vs network for content JSON
 * (playlist/settings/events/announcements). Every fetch goes through here so
 * there is exactly one cache policy instead of one per call site.
 *
 * Policy: network-first, cache-fallback. A successful fetch always updates
 * the cache; a failed fetch (offline, DNS, 5xx) falls back to the last good
 * cached copy so a temporary network blip doesn't blank the display.
 *
 * Scope note: this covers the JSON content files and nothing else. Images —
 * the gallery photos and the local artwork — belong to web/sw.js, which
 * intercepts <img> requests and caches them with a policy suited to their
 * size and origin. The Service Worker deliberately passes content/*.json
 * straight through so this module stays the single decision point for
 * content, and so version.json can never be served stale.
 *
 * The counters below feed the ?diag=1 overlay: "cache 0h/12m" says every
 * content read reached the network, which is what a healthy display looks
 * like. A rising hit count is the display running on cached content, which
 * is the mechanism working — but also the thing worth knowing about.
 */
var VhfContentSource = (function () {
  "use strict";

  var CACHE_NAME = "vhf-content-v1";

  function cacheSupported() {
    return typeof caches !== "undefined";
  }

  function fetchJson(path) {
    if (!cacheSupported()) {
      return fetch(path, { cache: "no-store" }).then(function (res) {
        if (!res.ok) throw new Error(path + " -> HTTP " + res.status);
        return res.json();
      });
    }

    return caches.open(CACHE_NAME).then(function (cache) {
      return fetch(path, { cache: "no-store" })
        .then(function (res) {
          if (!res.ok) throw new Error(path + " -> HTTP " + res.status);
          cache.put(path, res.clone());
          VhfDiagnostics.bump("cacheMiss");
          return res.json();
        })
        .catch(function (networkErr) {
          return cache.match(path).then(function (cached) {
            if (!cached) throw networkErr;
            VhfDiagnostics.bump("cacheHit");
            console.warn("[VHF] network failed for " + path + ", serving cached copy", networkErr);
            return cached.json();
          });
        });
    });
  }

  return { fetchJson: fetchJson };
})();
