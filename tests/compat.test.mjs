/*
 * The compatibility probe (web/js/compat.js). Two properties matter more than
 * any single answer it gives:
 *
 *   1. It can never break the page. An engine that cannot parse modern
 *      syntax, has no CSS.supports, no Image, no user agent, still loads the
 *      file, keeps the checks the display relies on today, and gets a summary.
 *   2. Its answer is readable off the device: a compact summary (for the
 *      heartbeat body) and an overlay line (for ?diag=1), updated when the
 *      asynchronous image-decode tests settle.
 *
 * compat.js is a plain browser script, so it runs in a vm context with just
 * enough of a browser faked around it, like the engine tests.
 *
 * Run with: node --test tests/compat.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPAT_PATH = path.join(ROOT, "web", "js", "compat.js");

const FIRE_TV_UA =
  "Mozilla/5.0 (Linux; Android 9; AFTTI43 Build/PS7633; wv) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.0 Mobile Safari/537.36";

function diagnostics() {
  const fields = {};
  return { fields, set: (k, v) => { fields[k] = v; } };
}

async function run(sandbox) {
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await fs.readFile(COMPAT_PATH, "utf8"), sandbox);
  return sandbox;
}

function modernSandbox({ decodes = { webp: true, avif: true } } = {}) {
  const images = [];
  class FakeImage {
    constructor() {
      images.push(this);
      this.naturalWidth = 0;
    }
    set src(value) {
      this._src = value;
    }
    finish() {
      const ok = /webp/.test(this._src) ? decodes.webp : decodes.avif;
      if (ok) {
        this.naturalWidth = 1;
        this.onload();
      } else {
        this.onerror();
      }
    }
  }
  const supported = new Set(["(--a: 0)", "width:clamp(1px, 2px, 3px)", "text-wrap:balance", "aspect-ratio:16 / 9", "container-type:inline-size", "backdrop-filter:blur(2px)"]);
  return {
    images,
    sandbox: {
      console: { log() {}, warn() {} },
      VhfDiagnostics: diagnostics(),
      navigator: { userAgent: FIRE_TV_UA, serviceWorker: {} },
      document: {
        documentElement: { style: { objectFit: "" } },
        visibilityState: "visible",
        onvisibilitychange: null,
        createElement: () => ({ noModule: false })
      },
      CSS: { supports: (p, v) => supported.has(v === undefined ? p : p + ":" + v) },
      fetch() {},
      caches: {},
      AbortController: class {},
      IntersectionObserver: class {},
      ResizeObserver: class {},
      structuredClone: (v) => v,
      Image: FakeImage,
      setTimeout() {}
    }
  };
}

test("a modern engine: every feature is detected and summarised compactly", async () => {
  const { sandbox, images } = modernSandbox();
  await run(sandbox);
  const compat = sandbox.VhfCompat;

  // The checks the display relies on today are unchanged.
  for (const key of ["promise", "fetch", "serviceWorker", "cacheStorage", "cssVariables", "objectFit", "intlTimeZone"]) {
    assert.equal(compat[key], true, key);
  }
  assert.equal(sandbox.VhfDiagnostics.fields.compat, "ok");

  assert.equal(compat.features.es2017, true);
  assert.equal(compat.features.es2020, true);
  assert.equal(compat.features.es2022, true);
  assert.equal(compat.features.modules, true);
  assert.equal(compat.features.textWrapBalance, true);
  assert.equal(compat.features.webp, null, "pending until the decode settles");
  assert.match(compat.summary(), /pending=webp,avif/);

  images.forEach((image) => image.finish());
  assert.equal(compat.features.webp, true);
  assert.equal(compat.features.avif, true);

  const summary = compat.summary();
  assert.match(summary, /^chrome=138 ok=21\/21 ua=Mozilla/);
  assert.ok(summary.length < 300, summary);
  assert.equal(sandbox.VhfDiagnostics.fields.probe, "chrome=138 ok=21/21", "the overlay line leaves out the UA");
});

test("missing features are named, and a failed decode counts as missing", async () => {
  const { sandbox, images } = modernSandbox({ decodes: { webp: true, avif: false } });
  delete sandbox.IntersectionObserver;
  sandbox.CSS = { supports: (p) => p === "(--a: 0)" };
  await run(sandbox);
  images.forEach((image) => image.finish());
  assert.match(
    sandbox.VhfCompat.summary(),
    /no=intersectionObserver,cssClamp,textWrapBalance,aspectRatio,containerQueries,backdropFilter,avif/
  );
});

test("an old engine: the probe cannot break the page", async () => {
  // No modern syntax (the Function constructor throws SyntaxError, as an
  // ES5 engine parsing `async`/`?.`/`#x` would), no CSS.supports, no Image,
  // no navigator, no visibility API.
  const sandbox = {
    console: { log() {}, warn() {} },
    VhfDiagnostics: diagnostics(),
    document: { documentElement: { style: {} }, createElement: () => ({}) },
    Function: function () {
      throw new SyntaxError("Unexpected token");
    },
    setTimeout() {}
  };
  await run(sandbox);
  const compat = sandbox.VhfCompat;
  assert.equal(compat.features.es2017, false);
  assert.equal(compat.features.es2020, false);
  assert.equal(compat.features.modules, false);
  assert.equal(compat.features.webp, false);
  assert.equal(compat.features.avif, false);
  assert.equal(compat.features.visibilityChange, false);
  assert.match(compat.summary(), /^chrome=\? ok=0\/21 no=/);
  assert.match(sandbox.VhfDiagnostics.fields.compat, /^missing: /);
});
