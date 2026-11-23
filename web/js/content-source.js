/*
 * The single place that decides cache vs network for content JSON
 * (playlist/settings/events/announcements). Every fetch goes through here so
 * there is exactly one cache policy instead of one per call site.
 *
 * Policy: network-first, cache-fallback. A successful fetch always updates
 * the cache; a failed fetch (offline, DNS, 5xx) falls back to the last good
 * cached copy so a temporary network blip doesn't blank the display.
 *
 * "Network-first" is bounded: a network that has not answered within
 * NETWORK_TIMEOUT_MS loses to the cached copy, and the request carries on in
 * the background to refresh the cache for next time. Unbounded, a reload on a
 * connection that is up but going nowhere (Wi-Fi fine, upstream dead) held a
 * black screen for the network stack's own timeouts, which run to minutes.
 * With no cached copy there is nothing better to show, so it waits as long as
 * the network does.
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
 *
 * ES5 only, like the rest of web/js.
 */
var VhfContentSource = (function () {
  "use strict";

  var CACHE_NAME = "vhf-content-v1";
  // Same budget as NETWORK_TIMEOUT_MS in sw.js, which bounds the navigation
  // that comes before these reads on a reload.
  var NETWORK_TIMEOUT_MS = 4000;

  // Switched off for a `?slide=` embed (engine.js): a website visitor has no
  // use for the television's offline copy and should not be left holding one.
  var cacheEnabled = true;

  function setCacheEnabled(on) {
    cacheEnabled = !!on;
  }

  /*
   * The content cache, or null when there is none to use. Cache Storage can
   * exist and still refuse — a third-party iframe with storage blocked has
   * `caches`, and open() rejects with SecurityError — and that must cost the
   * cache, not the content: the network is still there.
   */
  function openCache() {
    if (!cacheEnabled) return Promise.resolve(null);
    try {
      if (typeof caches === "undefined") return Promise.resolve(null);
      return caches.open(CACHE_NAME).then(null, function (err) {
        console.warn("[VHF] content cache unavailable, reading from the network only", err);
        return null;
      });
    } catch (err) {
      return Promise.resolve(null);
    }
  }

  function fromNetwork(path) {
    return fetch(path, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error(path + " -> HTTP " + res.status);
      return res;
    });
  }

  function networkFirst(path, cache) {
    return new Promise(function (resolve, reject) {
      var done = false;
      function settle(fn, value) {
        if (done) return;
        done = true;
        fn(value);
      }

      // The cached copy parsed, or null when there is none or it is unreadable.
      function cached() {
        return cache
          .match(path)
          .then(function (hit) {
            return hit ? hit.json() : null;
          })
          .then(null, function () {
            return null;
          });
      }

      function serveCached(data, why, err) {
        VhfDiagnostics.bump("cacheHit");
        console.warn("[VHF] " + why + " for " + path + ", serving cached copy", err || "");
        settle(resolve, data);
      }

      var timer = window.setTimeout(function () {
        cached().then(function (data) {
          if (data !== null && !done) serveCached(data, "network slow");
        });
      }, NETWORK_TIMEOUT_MS);

      fromNetwork(path)
        .then(function (res) {
          // Parsed before it is stored, so a body that is not JSON can never
          // replace the last good copy.
          var copy = res.clone();
          return res.json().then(function (data) {
            cache.put(path, copy).then(null, function (err) {
              console.warn("[VHF] could not cache " + path, err);
            });
            return data;
          });
        })
        .then(
          function (data) {
            window.clearTimeout(timer);
            if (!done) VhfDiagnostics.bump("cacheMiss");
            settle(resolve, data);
          },
          function (networkErr) {
            window.clearTimeout(timer);
            if (done) return;
            cached().then(function (data) {
              if (data === null) settle(reject, networkErr);
              else serveCached(data, "network failed", networkErr);
            });
          }
        );
    });
  }

  function fetchJson(path) {
    return openCache().then(function (cache) {
      if (cache) return networkFirst(path, cache);
      return fromNetwork(path).then(function (res) {
        return res.json();
      });
    });
  }

  return { fetchJson: fetchJson, setCacheEnabled: setCacheEnabled };
})();
