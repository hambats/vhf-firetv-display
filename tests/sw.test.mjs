/*
 * The Service Worker's promises, exercised against the stamped sw.js that a
 * real build produces.
 *
 * These are here because the one case that matters — reopening the display
 * with the network gone — is the hardest to stage by hand. A browser preview
 * cannot be taken offline reliably, and by the time the failure shows up on a
 * television it is a blank screen in a building nobody is standing in. So the
 * fetch handler is run directly, with a `fetch` that fails the way a dead
 * network fails, and the response is inspected.
 *
 * sw.js is loaded into a vm context with the Service Worker globals faked.
 * Node's own Request/Response/URL are close enough to the real thing for the
 * handler's purposes; `caches` is a small in-memory stand-in.
 *
 * Run with: node --test tests/sw.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { promises as fs } from "node:fs";
import { runBuild, makeFixture, cleanup } from "./helpers/build-fixture.mjs";

const ORIGIN = "https://display.test";

/* ---- a minimal Cache Storage ---- */

function keyOf(request) {
  const url = typeof request === "string" ? new URL(request, ORIGIN + "/").href : request.url;
  return url;
}

class FakeCache {
  constructor(fetchImpl) {
    this.entries = new Map(); // insertion-ordered, which is what trimming relies on
    this.fetchImpl = fetchImpl;
    this.putFailsWith = null;
  }
  async match(request) {
    return this.entries.get(keyOf(request)) || undefined;
  }
  async put(request, response) {
    if (this.putFailsWith) throw this.putFailsWith;
    this.entries.set(keyOf(request), response);
  }
  async add(request) {
    const response = await this.fetchImpl(request);
    if (!response || !response.ok) throw new Error("add failed");
    await this.put(request, response);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
  async delete(request) {
    return this.entries.delete(keyOf(request));
  }
}

function makeCaches(fetchImpl) {
  const open = new Map();
  return {
    store: open,
    async open(name) {
      if (!open.has(name)) open.set(name, new FakeCache(fetchImpl));
      return open.get(name);
    },
    async keys() {
      return [...open.keys()];
    },
    async delete(name) {
      return open.delete(name);
    }
  };
}

/* ---- loading sw.js ---- */

async function loadSw(swSource, fetchImpl) {
  const listeners = {};
  const caches = makeCaches(fetchImpl);
  const context = {
    self: {
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      location: { origin: ORIGIN, href: ORIGIN + "/sw.js" },
      skipWaiting: async () => {},
      clients: { claim: async () => {} }
    },
    caches,
    fetch: fetchImpl,
    /*
     * In a real worker a relative URL resolves against the worker's scope;
     * Node's Request demands an absolute one. sw.js precaches paths like
     * "index.html" and "./", so without this shim the test would fail on a
     * difference between Node and the browser rather than on the code.
     */
    Request: class ScopedRequest extends Request {
      constructor(input, init) {
        super(typeof input === "string" ? new URL(input, ORIGIN + "/").href : input, init);
      }
    },
    Response,
    URL,
    console: { log() {}, warn() {}, error() {} }
  };
  vm.createContext(context);
  vm.runInContext(swSource, context);
  return { listeners, caches, context };
}

function fireFetch(listeners, request) {
  let responded = null;
  const event = {
    request,
    respondWith(p) {
      responded = p;
    },
    waitUntil() {}
  };
  listeners.fetch[0](event);
  return responded;
}

async function fireLifecycle(listeners, type) {
  const waits = [];
  listeners[type][0]({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}

/*
 * A stamped sw.js, built once and reused: BUILD and SHELL are rewritten by
 * scripts/build-site.mjs, and testing the unstamped source would test a file
 * that never runs anywhere.
 */
let stamped = null;
async function stampedSw() {
  if (stamped) return stamped;
  const dir = await makeFixture();
  const { code, out } = await runBuild(dir);
  assert.equal(code, 0, "fixture build failed:\n" + out);
  const source = await fs.readFile(path.join(dir, "dist", "sw.js"), "utf8");
  await cleanup(dir);
  stamped = source;
  return stamped;
}

const offline = () => Promise.reject(new TypeError("Failed to fetch"));
const serving = (body, init) => () => Promise.resolve(new Response(body, init));

test("the build stamps a real cache name and shell list into sw.js", async () => {
  const source = await stampedSw();
  const build = /^var BUILD = "(.+)";$/m.exec(source);
  const shell = /^var SHELL = (\[.*\]);$/m.exec(source);
  assert.ok(build && build[1] !== "dev", "BUILD should be stamped with the build version");
  const files = JSON.parse(shell[1]);
  for (const required of ["index.html", "js/engine.js", "css/scene.css"]) {
    assert.ok(files.includes(required), `shell list is missing ${required}`);
  }
  assert.ok(
    files.some((f) => /\.woff2$/.test(f)),
    "the self-hosted fonts must be precached, or the display loses its brand offline"
  );
  assert.ok(
    !files.some((f) => f.indexOf("content/") === 0),
    "content JSON belongs to content-source.js, not the shell cache"
  );
});

test("installing precaches the whole app shell", async () => {
  const source = await stampedSw();
  const { listeners, caches } = await loadSw(source, serving("ok", { status: 200 }));
  await fireLifecycle(listeners, "install");

  const name = (await caches.keys()).find((n) => n.indexOf("vhf-shell-") === 0);
  const cache = await caches.open(name);
  const cached = (await cache.keys()).map((r) => r.url);
  const shell = JSON.parse(/^var SHELL = (\[.*\]);$/m.exec(source)[1]);
  assert.equal(cached.length, shell.length);
});

test("one missing shell file does not fail the whole install", async () => {
  const source = await stampedSw();
  let first = true;
  const oneMissing = () => {
    if (first) {
      first = false;
      return Promise.resolve(new Response("nope", { status: 404 }));
    }
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
  const { listeners, caches } = await loadSw(source, oneMissing);
  await fireLifecycle(listeners, "install");

  const name = (await caches.keys()).find((n) => n.indexOf("vhf-shell-") === 0);
  const cache = await caches.open(name);
  const shell = JSON.parse(/^var SHELL = (\[.*\]);$/m.exec(source)[1]);
  /* addAll would have cached nothing at all here. */
  assert.equal((await cache.keys()).length, shell.length - 1);
});

test("a navigation with the network gone is served the cached shell", async () => {
  const source = await stampedSw();
  /* Install while the network works, then lose it — the actual sequence on a
     television: published once, then the router dies or the building loses
     its connection, and someone power-cycles the TV. */
  const network = { fail: false };
  const fetchImpl = (req) =>
    network.fail ? offline() : Promise.resolve(new Response("<!DOCTYPE html><div id=\"stage\"></div>", { status: 200 }));

  const { listeners } = await loadSw(source, fetchImpl);
  await fireLifecycle(listeners, "install");
  network.fail = true;

  const request = new Request(ORIGIN + "/?diag=1");
  Object.defineProperty(request, "mode", { value: "navigate" });
  const response = await fireFetch(listeners, request);

  assert.ok(response, "the worker must answer a navigation it can serve from cache");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="stage"/);
});

test("content JSON is left to content-source.js, and version.json is never cached", async () => {
  const source = await stampedSw();
  const { listeners } = await loadSw(source, serving("{}", { status: 200 }));
  await fireLifecycle(listeners, "install");

  for (const url of ["/content/playlist.json", "/content/version.json", "/content/generated/events.json"]) {
    const responded = fireFetch(listeners, new Request(ORIGIN + url));
    assert.equal(responded, null, `${url} must fall through to the browser, not the worker`);
  }
});

test("gallery photos are cached and the cache stays bounded", async () => {
  const source = await stampedSw();
  const photo = () => Promise.resolve(new Response("jpegbytes", { status: 200 }));
  const { listeners, caches, context } = await loadSw(source, photo);
  await fireLifecycle(listeners, "install");

  const max = context.MAX_IMAGES;
  assert.ok(max > 0, "MAX_IMAGES should be readable from the worker");

  for (let i = 0; i < max + 10; i++) {
    const request = new Request("https://images.squarespace-cdn.test/photo-" + i + ".jpg?format=2500w");
    Object.defineProperty(request, "destination", { value: "image" });
    await fireFetch(listeners, request);
  }

  const cache = await caches.open("vhf-images-v1");
  const keys = await cache.keys();
  assert.ok(
    keys.length <= max,
    `image cache grew to ${keys.length}, above the ${max} cap — opaque responses are quota-padded, ` +
      "and a quota error takes the shell cache down with it"
  );
  /* Oldest-first eviction: the earliest photos should be the ones gone. */
  assert.ok(!keys.some((k) => k.url.indexOf("photo-0.jpg") !== -1));
  assert.ok(keys.some((k) => k.url.indexOf("photo-" + (max + 9) + ".jpg") !== -1));
});

test("local artwork does not share the capped cache with the gallery", async () => {
  const source = await stampedSw();
  const { listeners, caches } = await loadSw(source, serving("imgbytes", { status: 200 }));
  await fireLifecycle(listeners, "install");

  const logo = new Request(ORIGIN + "/content/artwork/brand/vhf-logo.webp");
  Object.defineProperty(logo, "destination", { value: "image" });
  await fireFetch(listeners, logo);

  const local = await caches.open("vhf-local-images-v1");
  assert.equal((await local.keys()).length, 1, "the brand mark belongs in the local image cache");
  const remote = await caches.open("vhf-images-v1");
  assert.equal(
    (await remote.keys()).length,
    0,
    "the logo is on every scene; putting it in the evicting cache loses it first"
  );
});

test("activating clears the previous build's shell but keeps the photos", async () => {
  const source = await stampedSw();
  const { listeners, caches } = await loadSw(source, serving("ok", { status: 200 }));

  await caches.open("vhf-shell-oldbuild");
  await caches.open("vhf-images-v1");
  await caches.open("vhf-local-images-v1");
  await fireLifecycle(listeners, "install");
  await fireLifecycle(listeners, "activate");

  const names = await caches.keys();
  assert.ok(!names.includes("vhf-shell-oldbuild"), "a stale shell cache would pin the display to an old build");
  assert.ok(names.includes("vhf-images-v1"), "photos do not change when the code does");
  assert.ok(names.includes("vhf-local-images-v1"));
});
