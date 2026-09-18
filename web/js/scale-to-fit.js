/*
 * Scales the fixed 1920x1080 #frame to fit the current window, letterboxed
 * (never cropped, never stretched) so the viewer always shows the exact
 * on-TV 16:9 composition — including caption overlays — regardless of the
 * browser window size. No-op at 1920x1080 (scale 1), which is what the
 * actual Fire TV WebView renders at.
 */
(function () {
  "use strict";

  var FRAME_WIDTH = 1920;
  var FRAME_HEIGHT = 1080;
  var frame = document.getElementById("frame");

  function applyScale() {
    var scale = Math.min(
      window.innerWidth / FRAME_WIDTH,
      window.innerHeight / FRAME_HEIGHT
    );
    var left = (window.innerWidth - FRAME_WIDTH * scale) / 2;
    var top = (window.innerHeight - FRAME_HEIGHT * scale) / 2;

    frame.style.transform = "scale(" + scale + ")";
    frame.style.left = left + "px";
    frame.style.top = top + "px";
  }

  window.addEventListener("resize", applyScale);
  applyScale();
})();
