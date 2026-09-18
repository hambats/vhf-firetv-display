/*
 * Playlist engine for the browser viewer. Loads playlist/settings/events as
 * plain JSON (same files a Fire TV build would sync/cache), then loops
 * through enabled scenes forever, crossfading between them. A scene that
 * fails to render is skipped, logged, and the loop continues — a single bad
 * item must never stall the playlist.
 */
(function () {
  "use strict";

  var DEFAULT_DURATION_SECONDS = 10;
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

    function advance() {
      var item = items[index % items.length];
      index += 1;
      var seconds = item.duration || DEFAULT_DURATION_SECONDS;

      // Re-arm the loop BEFORE rendering anything. Everything below this
      // line runs inside a try/catch, but the timer is what keeps an
      // unattended display alive, so it must not be reachable by any throw
      // at all — previously showLayer() and this setTimeout sat outside the
      // try, and a single throw from either (a null node, a DOM exception,
      // a failure deep in a weeks-long run) ended the setTimeout chain for
      // good: the television would hold its last frame forever, with no
      // error on screen and nothing to restart it.
      window.setTimeout(advance, seconds * 1000);

      try {
        var node;
        try {
          node = VhfScenes.render(item, data);
          log("showing " + item.id + " (" + item.type + ")");
        } catch (err) {
          console.error("[VHF] scene render failed", item, err);
          node = VhfScenes.renderError(item, err);
        }

        // Ken Burns (scene.css) reads this to match its animation length to
        // this scene's actual dwell time instead of a fixed guess — otherwise
        // an 8s scene would crossfade out mid-animation while a 14s scene
        // would sit still after the animation finished early.
        if (node && node.style) node.style.setProperty("--vhf-scene-duration", seconds + "s");
        showLayer(node);
      } catch (err) {
        // Showing the scene failed, not just building it. Leave whatever is
        // currently on screen up rather than blanking the display, and let
        // the already-scheduled next scene try again.
        console.error("[VHF] scene display failed, holding previous scene", item, err);
      }
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
