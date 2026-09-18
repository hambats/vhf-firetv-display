/*
 * The Service Worker: what makes the display survive being restarted with the
 * network down.
 *
 * Before this existed, content-source.js cached the content JSON — and that
 * cached JSON was unreachable, because closing and reopening the display
 * offline meant index.html, the CSS and the JS could not load at all. The
 * content was cached behind a shell that never booted. This fixes exactly
 * that: the shell is served from cache first, so the page always boots, and
 * then its own JSON cache does the rest.
 *
 * Division of labour, deliberately narrow:
 *
 *   - THIS FILE owns the app shell (HTML/CSS/JS/fonts) and images.
 *   - content-source.js still owns the content JSON. Requests for
 *     content/*.json are passed straight through to the network here, so
 *     there is still exactly one cache policy for content instead of two
 *     fighting over it — and version.json in particular must never be served
 *     stale, or the display could never learn that it is out of date.
 *
 * ES5 only (plus the SW APIs themselves): Fire OS 7 WebView.
 */
"use strict";

/* Both lines are rewritten by scripts/build-site.mjs at publish time. The
   defaults keep this file parseable when web/ is opened unbuilt. */
var BUILD = "dev";
var SHELL = ["./", "index.html"];

var SHELL_CACHE = "vhf-shell-" + BUILD;
/*
 * Two image caches, because the two kinds of image have opposite problems.
 *
 * REMOTE: the gallery pool — cross-origin, opaque, ~2500px, effectively
 * unbounded in number. Needs a hard cap.
 *
 * LOCAL: the brand mark and the curated artwork — our own files, finite,
 * inspectable, and on almost every scene. These must NOT share the capped
 * cache: the logo is cached early, so an oldest-first eviction would throw
 * away the one image that appears on every single scene in order to keep a
 * photo that appears once an hour.
 */
var IMAGE_CACHE = "vhf-images-v1";
var LOCAL_IMAGE_CACHE = "vhf-local-images-v1";

/*
 * Photos are ~2500px gallery originals and cross-origin, so they cache as
 * OPAQUE responses: their real size cannot be read, and browsers charge
 * opaque entries against the storage quota at a heavily padded size rather
 * than their true one. That padding is why this cap is far below the 120-photo
 * pool rather than comfortably above it — an uncapped image cache on a
 * television is a quota error waiting to happen, and a quota error takes the
 * *shell* cache down with it. Serving 2500px files to a 1920px panel is the
 * other half of the same cost; both are the case for a publish-time photo
 * mirror, recorded as an open decision in BUILD_TREE §1a.
 */
var MAX_IMAGES = 60;

function isContentJson(url) {
  return url.pathname.indexOf("/content/") !== -1 && /\.json$/.test(url.pathname);
}

function isImage(request, url) {
  if (request.destination === "image") return true;
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(url.pathname);
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      /*
       * addAll is all-or-nothing: one 404 in the list and the whole worker
       * fails to install, leaving the display with no offline story at all.
       * Each file is added individually so a single missing asset costs only
       * that asset.
       */
      return Promise.all(
        SHELL.map(function (path) {
          return cache.add(new Request(path, { cache: "reload" })).catch(function (err) {
            console.warn("[VHF sw] could not precache " + path, err);
          });
        })
      );
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.map(function (name) {
          /* Shell caches are build-stamped, so every older build's shell is
             evicted here. The image cache is deliberately NOT versioned:
             photos do not change when the code does, and re-downloading 60
             gallery originals on every publish would be pointless traffic. */
          if (name.indexOf("vhf-shell-") === 0 && name !== SHELL_CACHE) {
            return caches.delete(name);
          }
          return null;
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* Keep the image cache bounded. Cache.keys() returns entries in insertion
   order, so the front of the list is the oldest — evict from there. */
function trimImageCache(cache) {
  return cache.keys().then(function (keys) {
    if (keys.length <= MAX_IMAGES) return null;
    var excess = keys.slice(0, keys.length - MAX_IMAGES);
    return Promise.all(
      excess.map(function (key) {
        return cache.delete(key);
      })
    );
  });
}

function cacheImage(request, response) {
  return caches.open(IMAGE_CACHE).then(function (cache) {
    return cache.put(request, response).then(
      function () {
        return trimImageCache(cache);
      },
      function (err) {
        /* Almost always QuotaExceededError, thanks to opaque-response padding.
           Drop half the cache and carry on rather than letting the failure
           propagate into the fetch handler, where it would turn a cacheable
           photo into a broken one. */
        console.warn("[VHF sw] image cache put failed, trimming", err);
        return cache.keys().then(function (keys) {
          return Promise.all(
            keys.slice(0, Math.ceil(keys.length / 2)).map(function (key) {
              return cache.delete(key);
            })
          );
        });
      }
    );
  });
}

/* Cache-first with a background refresh: the display paints from cache
   immediately (which is the whole point on a restart), and the next start gets
   whatever was republished since. */
function staleWhileRevalidate(request, cacheName) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(request).then(function (cached) {
      var network = fetch(request)
        .then(function (response) {
          if (response && (response.ok || response.type === "opaque")) {
            cache.put(request, response.clone()).catch(function () {});
          }
          return response;
        })
        .catch(function (err) {
          if (cached) return cached;
          throw err;
        });
      return cached || network;
    });
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  /* content-source.js owns these, and version.json must never be stale. */
  if (isContentJson(url)) return;

  /*
   * A navigation that cannot reach the network must still get the shell back,
   * or the display is a blank page with a cache full of content it cannot
   * read. This is the single most important branch in the file.
   */
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(function () {
        return caches.open(SHELL_CACHE).then(function (cache) {
          return cache.match("index.html").then(function (cached) {
            return cached || cache.match("./");
          });
        });
      })
    );
    return;
  }

  if (isImage(request, url)) {
    if (url.origin === self.location.origin) {
      event.respondWith(staleWhileRevalidate(request, LOCAL_IMAGE_CACHE));
      return;
    }
    event.respondWith(
      caches.open(IMAGE_CACHE).then(function (cache) {
        return cache.match(request).then(function (cached) {
          if (cached) return cached;
          return fetch(request).then(function (response) {
            /* Opaque (cross-origin, no-cors) responses are cacheable and
               render fine; they just cannot be inspected. */
            if (response && (response.ok || response.type === "opaque")) {
              cacheImage(request, response.clone());
            }
            return response;
          });
        });
      })
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  }
});
