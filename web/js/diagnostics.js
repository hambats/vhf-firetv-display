/*
 * The overlay you turn on when the television is doing something inexplicable.
 *
 * Loaded first, before every other script, for two reasons: the global error
 * handlers it installs have to be in place before anything can throw, and
 * every other module records through it, so it has to exist when they load.
 *
 * `?diag=1` shows the panel. Without it the module still records everything —
 * the recording is what makes the numbers available to the watchdog and to
 * anyone who opens the console — it just draws nothing, because an error
 * legible to a viewer is a bug (BUILD_TREE §3).
 *
 * ES5 only, no dependencies: this runs on a Fire OS 7 WebView.
 */
var VhfDiagnostics = (function () {
  "use strict";

  var STARTED_AT = Date.now();
  var visible = /[?&]diag=1/.test(location.search);
  var el = null;
  var fields = {};
  var counters = {};
  var lastError = null;
  var errorCount = 0;

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  /* Uptime is the number that matters most here: it is how you tell a display
     that has been quietly restarting all night from one that has genuinely
     been up since Friday. */
  function uptime() {
    var s = Math.floor((Date.now() - STARTED_AT) / 1000);
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    return (d > 0 ? d + "d " : "") + pad(h) + ":" + pad(m) + ":" + pad(s % 60);
  }

  function set(key, value) {
    fields[key] = value;
  }

  function bump(key) {
    counters[key] = (counters[key] || 0) + 1;
  }

  function get(key) {
    return fields[key];
  }

  function count(key) {
    return counters[key] || 0;
  }

  function error(err, where) {
    errorCount += 1;
    var message = err && err.message ? err.message : String(err);
    lastError = {
      at: new Date().toISOString(),
      where: where || "unknown",
      message: message
    };
    console.error("[VHF] " + (where || "error") + ": " + message, err);
  }

  function lastErrorInfo() {
    return lastError;
  }

  function errors() {
    return errorCount;
  }

  function line(label, value) {
    return label + " " + value;
  }

  function render() {
    if (!visible) return;
    if (!el) el = document.getElementById("diag");
    if (!el) return;
    el.hidden = false;

    var parts = [
      line("up", uptime()),
      line("v", fields.contentVersion || "?"),
      line("sync", fields.lastSync || "never"),
      line("sw", fields.sw || "?"),
      line("cache", count("cacheHit") + "h/" + count("cacheMiss") + "m"),
      line("img", count("imageFailed") + " failed"),
      line("err", String(errorCount))
    ];
    if (fields.scene) parts.push(fields.scene);
    if (fields.photoId) parts.push("photo " + fields.photoId);
    parts.push("[→/space/n: skip scene]");
    if (lastError) parts.push("! " + lastError.where + ": " + lastError.message);
    el.textContent = parts.join("  ·  ");
  }

  /*
   * Global handlers. These do not *fix* anything — their job is to make a
   * failure countable, so the stall detector in engine.js and anyone reading
   * the overlay can tell "nothing is happening because the loop died" from
   * "nothing is happening because there is nothing to show".
   */
  window.addEventListener("error", function (ev) {
    error(ev.error || ev.message, "window.onerror");
  });
  window.addEventListener("unhandledrejection", function (ev) {
    error(ev.reason, "unhandledrejection");
  });

  if (visible) window.setInterval(render, 1000);

  return {
    visible: visible,
    startedAt: STARTED_AT,
    set: set,
    get: get,
    bump: bump,
    count: count,
    error: error,
    errors: errors,
    lastError: lastErrorInfo,
    uptime: uptime,
    render: render
  };
})();
