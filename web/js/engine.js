/*
 * Playlist engine for the browser viewer. Loads playlist/settings/events as
 * plain JSON (same files a Fire TV build would sync/cache), then loops
 * through enabled scenes forever, crossfading between them. A scene that
 * fails to render is skipped, logged, and the loop continues — a single bad
 * item must never stall the playlist.
 *
 * Scenes are built and their images preloaded one dwell ahead, off-DOM, so a
 * scene is only ever shown once it can actually paint. Without that, the
 * crossfade reveals an empty frame while a 2500px gallery photo downloads,
 * and a photo whose URL has died shows as a blank rectangle for its full
 * dwell, every time it comes around. A scene whose content images all failed
 * is skipped instead of shown, and its URLs are struck from the rotation.
 */
(function () {
  "use strict";

  var DEFAULT_DURATION_SECONDS = 10;
  // How long a scene may spend warming its images before we show it
  // anyway. Capped well under a dwell so a slow CDN can never stall the
  // loop; the first scene gets a shorter budget because until it paints
  // the television is showing nothing at all.
  var MAX_PRELOAD_MS = 8000;
  var FIRST_PAINT_MAX_PRELOAD_MS = 2500;
  // A scene whose content images all failed is skipped rather than shown
  // as an empty frame — but if everything is failing (network down, and
  // no Service Worker yet) skipping must not become a hot loop, so after
  // this many in a row we show the next scene regardless and let the
  // display degrade at normal pace instead of thrashing.
  var MAX_CONSECUTIVE_SKIPS = 5;
  var layers = document.querySelectorAll(".stage__layer");
  var diag = document.getElementById("diag");
  var showDiag = /[?&]diag=1/.test(location.search);
  if (showDiag) diag.hidden = false;

  function log(msg) {
    console.log("[VHF] " + msg);
    if (showDiag) diag.textContent = msg;
  }

  function loadContent() {
    var fetchJson = VhfContentSource.fetchJson;
    return Promise.all([
      fetchJson("content/playlist.json"),
      fetchJson("content/settings.json"),
      fetchJson("content/generated/events.json").catch(function () {
        return { version: 1, events: [] };
      }),
      fetchJson("content/announcements/announcements.json").catch(function () {
        return { version: 1, announcements: [] };
      }),
      fetchJson("content/generated/gallery.json").catch(function () {
        return { version: 1, photos: [] };
      })
    ]).then(function (results) {
      return {
        playlist: results[0],
        settings: results[1],
        events: results[2],
        announcements: results[3],
        gallery: results[4]
      };
    });
  }

  function activeItems(playlist) {
    var items = (playlist && playlist.playlist) || [];
    return items.filter(function (item) {
      return item.enabled !== false;
    });
  }

  // Resolves once every image in the scene has settled (loaded or
  // errored) or the budget expires, whichever comes first. Never
  // rejects: a broken image must not be able to take down a scene, let
  // alone the loop.
  //
  // Returns false only when the scene has content images and every one of
  // them definitively errored. A budget expiry deliberately returns true:
  // a slow image is still likely to paint part-way through the dwell,
  // whereas treating "slow" as "broken" would blank every photo scene on
  // a weak connection — exactly when the display can least afford it.
  function warmImages(node, budgetMs) {
    var images = node && node.querySelectorAll ? node.querySelectorAll("img") : [];
    if (images.length === 0) return Promise.resolve(true);

    var required = 0;
    var requiredFailed = 0;
    var settled = [];

    function track(image) {
      var isContent = image.getAttribute("data-vhf-role") === "content";
      if (isContent) required++;
      return new Promise(function (resolve) {
        function done(ok) {
          if (!ok) {
            if (isContent) requiredFailed++;
            // A broken-image glyph is worse than nothing on a television.
            image.style.display = "none";
            VhfScenes.markImageFailed(image.src);
            console.warn("[VHF] image failed to load: " + image.src);
          }
          resolve();
        }
        if (image.complete) return done(image.naturalWidth > 0);
        image.addEventListener("load", function () {
          // Decode before the crossfade where supported, so a large photo
          // does not hitch the fade while the compositor decodes it.
          if (typeof image.decode === "function") {
            image.decode().then(function () { done(true); }, function () { done(true); });
          } else {
            done(true);
          }
        });
        image.addEventListener("error", function () { done(false); });
      });
    }

    for (var i = 0; i < images.length; i++) settled.push(track(images[i]));

    var budget = new Promise(function (resolve) {
      window.setTimeout(resolve, budgetMs);
    });

    return Promise.race([Promise.all(settled), budget]).then(function () {
      return !(required > 0 && requiredFailed === required);
    });
  }

  var currentLayerIndex = 0;

  function showLayer(node) {
    var current = layers[currentLayerIndex];
    var nextIndex = (currentLayerIndex + 1) % layers.length;
    var next = layers[nextIndex];

    next.innerHTML = "";
    next.appendChild(node);

    // Force layout so the opacity transition actually runs.
    void next.offsetWidth;

    next.classList.add("stage__layer--visible");
    current.classList.remove("stage__layer--visible");
    currentLayerIndex = nextIndex;
  }

  function runLoop(data) {
    var items = activeItems(data.playlist);
    if (items.length === 0) {
      log("playlist has no enabled items");
      showLayer(VhfScenes.renderError({ id: "playlist", type: "n/a" }, new Error("empty playlist")));
      return;
    }

    var index = 0;
    var upcoming = null; // a scene already built and warmed, ready to show
    var consecutiveSkips = 0;
    var firstPaint = true;

    function nextItem() {
      var item = items[index % items.length];
      index += 1;
      return item;
    }

    // Build a scene and wait for its images, off-DOM. CSS animations do
    // not start until the node is inserted, so warming ahead costs the
    // scene nothing — it still animates from the moment it appears.
    // Never rejects; a failure comes back as usable:false.
    function prepare(item, budgetMs) {
      var seconds = item.duration || DEFAULT_DURATION_SECONDS;
      var node;
      try {
        node = VhfScenes.render(item, data);
        // Ken Burns (scene.css) reads this to match its animation length
        // to this scene’s actual dwell time instead of a fixed guess —
        // otherwise an 8s scene would crossfade out mid-animation while a
        // 14s scene would sit still after the animation finished early.
        if (node && node.style) node.style.setProperty("--vhf-scene-duration", seconds + "s");
      } catch (err) {
        console.error("[VHF] scene render failed", item, err);
        return Promise.resolve({ item: item, seconds: seconds, node: null, usable: false });
      }
      var budget = Math.min(seconds * 1000, budgetMs || MAX_PRELOAD_MS);
      return warmImages(node, budget).then(
        function (usable) {
          return { item: item, seconds: seconds, node: node, usable: usable };
        },
        function (err) {
          // Warming itself misbehaved. Showing the scene un-warmed is
          // strictly better than dropping it.
          console.error("[VHF] image preload failed", item, err);
          return { item: item, seconds: seconds, node: node, usable: true };
        }
      );
    }

    function advance() {
      // Exactly one scheduling per tick, whichever path gets there first.
      // The loop staying armed is the property this whole function exists
      // to protect: a display that stops advancing is the failure an
      // unattended appliance cannot have.
      var scheduled = false;
      function scheduleNext(ms) {
        if (scheduled) return;
        scheduled = true;
        window.setTimeout(advance, ms);
      }

      var ready;
      try {
        ready = upcoming || prepare(nextItem(), firstPaint ? FIRST_PAINT_MAX_PRELOAD_MS : MAX_PRELOAD_MS);
      } catch (err) {
        console.error("[VHF] could not prepare a scene", err);
        scheduleNext(DEFAULT_DURATION_SECONDS * 1000);
        return;
      }
      upcoming = null;
      firstPaint = false;

      // Backstop: if that promise rejects, hangs, or never settles for any
      // reason, the loop moves on anyway.
      var backstop = window.setTimeout(function () {
        console.error("[VHF] scene preparation stalled, moving on");
        scheduleNext(0);
      }, MAX_PRELOAD_MS + 2000);

      ready.then(function (scene) {
        window.clearTimeout(backstop);
        if (scheduled) return; // backstop already fired; that tick owns the loop

        // Start warming the following scene now, during this one’s dwell.
        // This is what removes the blank frame at the crossfade: by the
        // time we show it, its images are already decoded.
        try {
          upcoming = prepare(nextItem(), MAX_PRELOAD_MS);
        } catch (err) {
          console.error("[VHF] could not pre-build the next scene", err);
          upcoming = null;
        }

        try {
          if (!scene.usable && consecutiveSkips < MAX_CONSECUTIVE_SKIPS) {
            consecutiveSkips += 1;
            log("skipping " + scene.item.id + " (" + scene.item.type + "): no usable image");
            // Move straight to the replacement rather than holding an
            // empty frame for the full dwell. The replacement is already
            // warming, so this waits on it rather than flashing.
            scheduleNext(0);
            return;
          }
          if (!scene.usable) {
            console.error("[VHF] " + consecutiveSkips + " scenes skipped in a row; showing anyway to keep pace");
          }
          consecutiveSkips = 0;
          showLayer(scene.node);
          log("showing " + scene.item.id + " (" + scene.item.type + ")");
        } catch (err) {
          // Displaying failed, not just building. Leave whatever is on
          // screen up rather than blanking it, and let the next scene try.
          console.error("[VHF] scene display failed, holding previous scene", scene.item, err);
        }
        scheduleNext(scene.seconds * 1000);
      }, function (err) {
        window.clearTimeout(backstop);
        console.error("[VHF] scene pipeline failed", err);
        scheduleNext(DEFAULT_DURATION_SECONDS * 1000);
      });
    }

    advance();
  }

  function start() {
    loadContent()
      .then(runLoop)
      .catch(function (err) {
        console.error("[VHF] failed to load content", err);
        log("failed to load content: " + err.message);
        showLayer(
          VhfScenes.renderError(
            { id: "content-load", type: "n/a" },
            err
          )
        );
        // Retry periodically rather than staying blank forever.
        window.setTimeout(start, 15000);
      });
  }

  start();
})();
