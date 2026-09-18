/*
 * The single place that decides cache vs network for content JSON
 * (playlist/settings/events/announcements). Every fetch goes through here so
 * there is exactly one cache policy instead of one per call site.
 *
 * Policy: network-first, cache-fallback. A successful fetch always updates
 * the cache; a failed fetch (offline, DNS, 5xx) falls back to the last good
 * cached copy so a temporary network blip doesn't blank the display.
 *
 * Scope note (Phase 3): this covers the JSON content files. Photo/artwork
 * images are direct links to the VHF gallery (Squarespace CDN) and are
 * intentionally NOT cached here — that would need a Service Worker to
 * intercept <img> requests, which is out of scope for the browser preview.
 * Real offline image resilience is a Fire TV concern: Phase 4's
 * ContentCache.kt downloads referenced images to local files as part of the
 * publish/sync step, so the TV never depends on the gallery being reachable
 * at render time even though this browser viewer does.
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
          return res.json();
        })
        .catch(function (networkErr) {
          return cache.match(path).then(function (cached) {
            if (!cached) throw networkErr;
            console.warn("[VHF] network failed for " + path + ", serving cached copy", networkErr);
            return cached.json();
          });
        });
    });
  }

  return { fetchJson: fetchJson };
})();
