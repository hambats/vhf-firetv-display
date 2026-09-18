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
  // How long the page may run before it reloads itself at a scene boundary.
  // Nothing is known to leak; that is exactly why this exists. A setTimeout
  // chain and a DOM that have been running for weeks are the parts most
  // likely to drift or accumulate something nobody predicted, and a reload at
  // a crossfade is invisible. Cheap insurance against an unknown.
  var PERIODIC_RELOAD_MS = 6 * 60 * 60 * 1000;
  // The stall detector's own tick. It is deliberately not tied to the scene
  // loop: its whole job is to notice that the scene loop has stopped.
  var WATCHDOG_INTERVAL_MS = 30 * 1000;
  // How long the display stays showing normal content after a remote wake
  // during quiet hours, before falling back to black again. Long enough for
  // someone to actually look at the screen, short enough that a stray
  // button press doesn't light up the building overnight.
  var WAKE_DURATION_MS = 10 * 60 * 1000;
  // How often quiet hours are re-checked (day rollover, wake expiring)
  // while the display is black.
  var QUIET_RECHECK_MS = 60 * 1000;
  var layers = document.querySelectorAll(".stage__layer");

  /*
   * ---- Quiet hours ----
   *
   * The farm is closed some days (settings.json: hours.closedWeekdays,
   * 0=Sunday..6=Saturday), and there is no reason to keep a television lit
   * in an empty building. On a closed day the loop shows a black frame
   * instead of the playlist. The remote's BACK key (app/DisplayActivity.kt)
   * calls VhfQuietHours.wake() so on-site staff can still check the display
   * is alive without waiting for the next open day; the override expires on
   * its own so nobody has to remember to turn it back off.
   */
  var wakeUntil = 0;
  var pendingTimeout = null;
  var advanceRef = null; // set once runLoop is underway

  function closedWeekdays(settings) {
    return (settings && settings.hours && settings.hours.closedWeekdays) || [];
  }

  function currentWeekday(tz) {
    if (tz && window.VhfCompat && VhfCompat.intlTimeZone) {
      var parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date());
      var names = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      if (names.hasOwnProperty(parts)) return names[parts];
    }
    return new Date().getDay();
  }

  function isQuietHours(settings) {
    if (Date.now() < wakeUntil) return false;
    var closed = closedWeekdays(settings);
    if (closed.length === 0) return false;
    var today = currentWeekday(settings && settings.timezone);
    for (var i = 0; i < closed.length; i++) {
      if (closed[i] === today) return true;
    }
    return false;
  }

  window.VhfQuietHours = {
    wake: function () {
      wakeUntil = Date.now() + WAKE_DURATION_MS;
      log("woken from quiet hours for " + Math.round(WAKE_DURATION_MS / 60000) + " min");
      if (pendingTimeout !== null) {
        window.clearTimeout(pendingTimeout);
        pendingTimeout = null;
      }
      if (advanceRef) advanceRef();
    }
  };

  function log(msg) {
    console.log("[VHF] " + msg);
    VhfDiagnostics.set("scene", msg);
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
      }),
      fetchJson("content/generated/curated-photos.json").catch(function () {
        return { version: 1, sets: {} };
      })
    ]).then(function (results) {
      return {
        playlist: results[0],
        settings: results[1],
        events: results[2],
        announcements: results[3],
        gallery: results[4],
        curated: results[5].sets || {}
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
            VhfDiagnostics.bump("imageFailed");
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

  /*
   * ---- Staying current, and staying alive ----
   *
   * Two failures this section exists to prevent, neither of which is visible
   * in a five-minute preview:
   *
   *   1. A page opened on Monday is still showing Monday's events on Friday.
   *      Nothing in the loop ever re-reads content, so without a poll the
   *      display silently becomes a photograph of a past week.
   *   2. The loop stops. engine.js guarantees exactly one reschedule per tick
   *      and arms it before anything that can throw, so the loop can no longer
   *      stop *itself* — but it can still be stopped from outside (a throwing
   *      timer, a WebView suspending, something nobody has thought of). Only
   *      something outside the loop can notice that, which is what the
   *      watchdog is.
   *
   * Both recover the same way: reload the page. A reload at a crossfade is
   * invisible on screen and clears whatever state went wrong.
   */
  var reloadPending = null; // reason string, or null

  function requestReload(reason) {
    if (reloadPending) return;
    reloadPending = reason;
    log("reload queued (" + reason + "); will apply at the next scene boundary");
  }

  function applyReloadIfPending() {
    if (!reloadPending) return false;
    console.log("[VHF] reloading: " + reloadPending);
    location.reload();
    return true;
  }

  function fetchVersion() {
    return fetch("content/version.json?t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("version.json -> HTTP " + res.status);
        return res.json();
      });
  }

  function startVersionPoll(settings) {
    var minutes = (settings && settings.syncIntervalMinutes) || 20;
    var known = null;

    function poll() {
      fetchVersion().then(
        function (manifest) {
          VhfDiagnostics.set("contentVersion", manifest.version);
          VhfDiagnostics.set("lastSync", new Date().toISOString().slice(11, 19));
          if (known === null) {
            known = manifest.version;
            return;
          }
          if (manifest.version !== known) {
            known = manifest.version;
            /*
             * Content is re-read on reload, so this covers new events and new
             * photos immediately. Changed *code* can take one further reload:
             * the Service Worker serves the shell from cache while fetching
             * the new build in the background. That is the right trade for a
             * display — booting instantly from cache matters more than
             * picking up a CSS change on the first try.
             */
            requestReload("content version " + manifest.version);
          }
        },
        function (err) {
          /* A failed poll is not an error worth counting: the network being
             down is the normal condition this whole milestone is about. The
             cached content keeps playing and the next poll tries again. */
          VhfDiagnostics.set("lastSync", "failed " + new Date().toISOString().slice(11, 19));
          console.warn("[VHF] version poll failed", err);
        }
      );
    }

    poll();
    window.setInterval(poll, minutes * 60 * 1000);
    window.setTimeout(function () {
      requestReload("periodic refresh");
    }, PERIODIC_RELOAD_MS);
  }

  /*
   * Watches the one number that proves the display is alive: when a scene last
   * changed. Anything longer than several times the current scene's dwell means
   * the loop is not coming back on its own.
   *
   * This can only catch a dead loop in a live page. A WebView that has crashed
   * outright takes this timer with it — that case belongs to the native shell's
   * own watchdog (app/, BUILD_TREE §5), which is why both layers exist.
   */
  function startWatchdog(state) {
    window.setInterval(function () {
      var expected = Math.max(state.currentSceneMs * 3, 60000);
      var idle = Date.now() - state.lastAdvance;
      if (idle < expected) return;
      VhfDiagnostics.error(
        new Error("no scene change in " + Math.round(idle / 1000) + "s"),
        "watchdog"
      );
      location.reload();
    }, WATCHDOG_INTERVAL_MS);
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
    // Before any scene renders: event times must never be formatted in the
    // television's own idea of local time. See scenes.js setTimeZone.
    VhfScenes.setTimeZone(data.settings && data.settings.timezone);
    startVersionPoll(data.settings);

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
    // Shared with the watchdog, which reads it from outside the loop.
    var state = { lastAdvance: Date.now(), currentSceneMs: DEFAULT_DURATION_SECONDS * 1000 };
    startWatchdog(state);

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
        state.lastAdvance = Date.now();
        state.currentSceneMs = ms || DEFAULT_DURATION_SECONDS * 1000;
        pendingTimeout = window.setTimeout(advance, ms);
      }

      // A scene boundary is the only invisible moment to reload, and this is
      // it — before any work for the next scene has been done.
      if (applyReloadIfPending()) return;

      if (isQuietHours(data.settings)) {
        upcoming = null;
        showLayer(VhfScenes.renderBlank());
        log("quiet hours: showing black scene");
        scheduleNext(QUIET_RECHECK_MS);
        return;
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
            console.error("[VHF] " + consecutiveSkips + " scenes skipped in a row; keeping pace instead of skipping further");
          }
          consecutiveSkips = 0;
          // A scene that never built has no node to show. Hold the current
          // frame for one dwell rather than blanking the screen; the point of
          // breaking the skip streak is to stop spinning, not to display
          // nothing.
          if (scene.node) {
            showLayer(scene.node);
            log("showing " + scene.item.id + " (" + scene.item.type + ")");
          } else {
            log("holding: " + scene.item.id + " (" + scene.item.type + ") could not be built");
          }
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

    advanceRef = advance;
    advance();
  }

  function start() {
    loadContent()
      .then(runLoop)
      .catch(function (err) {
        VhfDiagnostics.error(err, "content load");
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
