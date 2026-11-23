/*
 * content-source.js: the one cache-vs-network policy for content JSON.
 *
 * The cases that matter on the wall are the ones a preview never shows: a
 * network that answers nothing (Wi-Fi up, upstream dead), a Cache Storage
 * that exists but refuses (a third-party iframe with storage blocked), and a
 * `?slide=` embed that must not leave the television's cache in a visitor's
 * browser. content-source.js is a plain browser script, so it is loaded into
 * a vm context with fetch, caches and timers faked — the timer is a fake
 * clock the test fires by hand, so nothing here waits four real seconds.
 *
 * Run with: node --test tests/content-source.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = await fs.readFile(path.join(ROOT, "web", "js", "content-source.js"), "utf8");

function json(body, status = 200) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

/* An in-memory Cache Storage with one cache, keyed by the path string. */
function makeCaches() {
  const entries = new Map();
  const cache = {
    puts: 0,
    async match(key) {
      const hit = entries.get(key);
      return hit ? hit.clone() : undefined;
    },
    async put(key, response) {
      cache.puts++;
      entries.set(key, response);
    }
  };
  return {
    entries,
    cache,
    opened: 0,
    async open() {
      this.opened++;
      return cache;
    }
  };
}

function makeClock() {
  let next = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pending(ms) {
      return [...timers.values()].filter((t) => t.ms === ms).length;
    },
    fireAll(ms) {
      for (const [id, t] of [...timers]) {
        if (t.ms === ms) {
          timers.delete(id);
          t.fn();
        }
      }
    }
  };
}

function load({ fetch, caches }) {
  const clock = makeClock();
  const sandbox = {
    fetch,
    console: { warn() {}, log() {} },
    VhfDiagnostics: { bump() {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  };
  if (caches !== undefined) sandbox.caches = caches;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE + "\nthis.__cs = VhfContentSource;", sandbox);
  return { cs: sandbox.__cs, clock };
}

/* Closure-private in the module, so read from its source. */
const NETWORK_TIMEOUT_MS = Number(/var NETWORK_TIMEOUT_MS = (\d+);/.exec(SOURCE)[1]);

/* Lets promise chains (and the Response body reads inside them) run. */
async function settles(promise, ticks = 50) {
  let done = false;
  promise.then(() => (done = true), () => (done = true));
  for (let i = 0; i < ticks; i++) await new Promise((r) => setImmediate(r));
  return done;
}

const hang = () => new Promise(() => {});

test("a healthy network is read and the copy cached for next time", async () => {
  const caches = makeCaches();
  const { cs } = load({ fetch: async () => json({ version: 7 }), caches });
  assert.deepEqual(await cs.fetchJson("content/playlist.json"), { version: 7 });
  await settles(Promise.resolve());
  assert.deepEqual(await (await caches.cache.match("content/playlist.json")).json(), { version: 7 });
});

test("a network that never answers loses to the cached copy at the timeout", async () => {
  const caches = makeCaches();
  caches.entries.set("content/playlist.json", json({ version: 1 }));
  const { cs, clock } = load({ fetch: hang, caches });

  const read = cs.fetchJson("content/playlist.json");
  assert.equal(await settles(read), false, "must not give up on the network before the timeout");
  assert.equal(clock.pending(NETWORK_TIMEOUT_MS), 1);
  clock.fireAll(NETWORK_TIMEOUT_MS);
  assert.equal(await settles(read), true, "the cached copy must answer once the timeout passes");
  assert.deepEqual(await read, { version: 1 });
});

test("a slow network that loses the race still refreshes the cache", async () => {
  const caches = makeCaches();
  caches.entries.set("content/playlist.json", json({ version: 1 }));
  let answer;
  const { cs, clock } = load({ fetch: () => new Promise((r) => (answer = r)), caches });

  const read = cs.fetchJson("content/playlist.json");
  await settles(Promise.resolve());
  clock.fireAll(NETWORK_TIMEOUT_MS);
  assert.deepEqual(await read, { version: 1 });

  answer(json({ version: 2 }));
  await settles(Promise.resolve());
  assert.deepEqual(await (await caches.cache.match("content/playlist.json")).json(), { version: 2 });
});

test("with nothing cached, a slow network is waited for, not failed early", async () => {
  const caches = makeCaches();
  const { cs, clock } = load({ fetch: hang, caches });
  const read = cs.fetchJson("content/playlist.json");
  await settles(Promise.resolve());
  clock.fireAll(NETWORK_TIMEOUT_MS);
  assert.equal(await settles(read), false);
});

test("a failed network falls back to the cache, and with no cache it fails", async () => {
  const caches = makeCaches();
  caches.entries.set("content/settings.json", json({ version: 3 }));
  const offline = () => Promise.reject(new TypeError("Failed to fetch"));
  const { cs } = load({ fetch: offline, caches });
  assert.deepEqual(await cs.fetchJson("content/settings.json"), { version: 3 });
  await assert.rejects(cs.fetchJson("content/playlist.json"), /Failed to fetch/);
});

test("a 200 that is not JSON never replaces the last good copy", async () => {
  const caches = makeCaches();
  caches.entries.set("content/playlist.json", json({ version: 1 }));
  const { cs } = load({ fetch: async () => json("<html>not json</html>"), caches });
  assert.deepEqual(await cs.fetchJson("content/playlist.json"), { version: 1 });
  assert.equal(caches.cache.puts, 0);
});

test("a Cache Storage that refuses costs the cache, not the content", async () => {
  const refusing = {
    open: () => Promise.reject(Object.assign(new Error("security policy"), { name: "SecurityError" }))
  };
  const { cs } = load({ fetch: async () => json({ version: 5 }), caches: refusing });
  assert.deepEqual(await cs.fetchJson("content/playlist.json"), { version: 5 });
});

test("no Cache Storage at all reads straight from the network", async () => {
  const { cs } = load({ fetch: async () => json({ version: 6 }) });
  assert.deepEqual(await cs.fetchJson("content/playlist.json"), { version: 6 });
});

test("with the cache switched off (a ?slide= embed), nothing is opened or written", async () => {
  const caches = makeCaches();
  const { cs } = load({ fetch: async () => json({ version: 8 }), caches });
  cs.setCacheEnabled(false);
  assert.deepEqual(await cs.fetchJson("content/playlist.json"), { version: 8 });
  assert.equal(caches.opened, 0);
  assert.equal(caches.cache.puts, 0);
});
