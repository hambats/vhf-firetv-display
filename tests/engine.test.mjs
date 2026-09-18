/*
 * The loop's core liveness guarantee: a scene that throws while rendering is
 * skipped, logged, and the loop keeps advancing to whatever comes after it —
 * it does not stall the playlist. This is the fault the watchdog section of
 * engine.js exists to describe (see docs/BUILD_TREE.md M1): before the fix,
 * a single thrown scene froze the loop forever, verified by fault injection
 * against the pre-fix build.
 *
 * engine.js is a self-invoking browser script with no exports and no build
 * step (unlike sw.js, it is not stamped), so it is loaded into a vm context
 * the same way tests/sw.test.mjs loads sw.js: real globals faked just enough
 * for the script to run, with fetch/render/timers all under the test's
 * control so nothing here waits on a real clock.
 *
 * Timers are a hand-rolled fake clock rather than real ones. This lets the
 * test both drive the loop tick-by-tick deterministically AND assert the
 * "exactly one reschedule per tick" invariant directly: after each tick
 * settles, the only pending timers must be the three long-lived ones engine.js
 * arms once at startup (the watchdog interval, the version-poll interval, the
 * periodic-reload timeout) plus exactly one scene-advance timer. No leak, no
 * double-arm.
 *
 * Run with: node --test tests/engine.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_PATH = path.join(ROOT, "web", "js", "engine.js");

/* ---- a fake clock: setTimeout/setInterval/clearTimeout/clearInterval that
   never actually wait. The test fires timers itself, one at a time. ---- */

function makeClock() {
  let nextId = 1;
  const timers = new Map(); // id -> { fn, interval }

  return {
    setTimeout(fn) {
      const id = nextId++;
      timers.set(id, { fn, interval: false });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn) {
      const id = nextId++;
      timers.set(id, { fn, interval: true });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    ids() {
      return new Set(timers.keys());
    },
    size() {
      return timers.size;
    },
    fire(id) {
      const timer = timers.get(id);
      assert.ok(timer, "tried to fire a timer that isn't pending: " + id);
      if (!timer.interval) timers.delete(id);
      timer.fn();
    }
  };
}

/* Drain the real microtask queue engine.js's Promise chains run on (prepare
   -> warmImages -> ready.then -> scheduleNext). Our fake clock only stands
   in for setTimeout/setInterval; Promises here are real Node Promises, same
   as tests/sw.test.mjs relies on for its fetch chains. */
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/* ---- a minimal DOM: two crossfade layers, nothing else ---- */

function makeLayer(tracking) {
  return {
    innerHTML: "",
    _child: null,
    classList: {
      _visible: false,
      add() {
        this._visible = true;
      },
      remove() {
        this._visible = false;
      }
    },
    appendChild(node) {
      this._child = node;
      if (node && node.__id) tracking.shown.push(node.__id);
    },
    get offsetWidth() {
      return 100;
    }
  };
}

/* ---- fake scene nodes: no images, so warmImages resolves synchronously
   and the test never needs to simulate image loading ---- */

function makeSceneNode(id) {
  return {
    __id: id,
    style: { setProperty() {} },
    querySelectorAll() {
      return [];
    }
  };
}

const PLAYLIST_ITEMS = [
  { id: "a", type: "test", enabled: true, duration: 5 },
  { id: "throws", type: "test", enabled: true, duration: 5 },
  { id: "c", type: "test", enabled: true, duration: 5 }
];

function makeContext(clock, tracking) {
  const layers = [makeLayer(tracking), makeLayer(tracking)];

  const VhfContentSource = {
    fetchJson(pathname) {
      if (/playlist\.json/.test(pathname)) return Promise.resolve({ playlist: PLAYLIST_ITEMS });
      if (/settings\.json/.test(pathname)) return Promise.resolve({});
      if (/events\.json/.test(pathname)) return Promise.resolve({ version: 1, events: [] });
      if (/announcements\.json/.test(pathname)) return Promise.resolve({ version: 1, announcements: [] });
      if (/gallery\.json/.test(pathname)) return Promise.resolve({ version: 1, photos: [] });
      if (/curated-photos\.json/.test(pathname)) return Promise.resolve({ version: 1, sets: {} });
      return Promise.reject(new Error("unexpected fetchJson path: " + pathname));
    }
  };

  const VhfScenes = {
    render(item) {
      tracking.rendered.push(item.id);
      if (item.id === "throws") throw new Error("scene render exploded on purpose");
      return makeSceneNode(item.id);
    },
    renderError(item) {
      return makeSceneNode("error:" + item.id);
    },
    renderBlank() {
      return makeSceneNode("blank");
    },
    setTimeZone() {},
    markImageFailed() {}
  };

  const VhfDiagnostics = {
    set() {},
    bump() {},
    error(err, tag) {
      tracking.diagErrors.push({ err, tag });
    }
  };

  const sandbox = {
    console: {
      log(msg) {
        tracking.logs.push(String(msg));
      },
      warn() {},
      error() {}
    },
    document: {
      querySelectorAll() {
        return layers;
      }
    },
    location: { reload() {} },
    fetch() {
      // Version poll: report a stable version so it never queues a reload
      // mid-test. Its own timer chain isn't what this test is exercising.
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 1 }) });
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    VhfContentSource,
    VhfScenes,
    VhfDiagnostics
  };
  sandbox.window = sandbox; // engine.js calls window.setTimeout / window.VhfQuietHours etc.

  vm.createContext(sandbox);
  return { sandbox, layers };
}

async function bootEngine() {
  const source = await fs.readFile(ENGINE_PATH, "utf8");
  const clock = makeClock();
  const tracking = { rendered: [], logs: [], diagErrors: [], shown: [] };
  const { sandbox, layers } = makeContext(clock, tracking);

  vm.runInContext(source, sandbox);

  // start() -> loadContent() -> runLoop() -> advance() all chain through
  // real Promises; let them settle before the test drives further ticks.
  await flush();

  return { sandbox, clock, tracking, layers };
}

test("a throwing scene is skipped and the loop advances to the next one", async () => {
  const { clock, tracking } = await bootEngine();

  // First tick already ran during boot: "a" renders fine and is shown, and
  // engine.js prefetches "throws" one dwell ahead, which throws immediately.
  assert.deepEqual(tracking.rendered, ["a", "throws"]);
  assert.ok(
    tracking.rendered.length && !tracking.shown.includes("throws"),
    "the throwing scene must never reach the DOM"
  );
  assert.ok(tracking.shown.includes("a"), "the first scene should have painted");

  // Exactly one scene-advance timer should be pending, on top of the three
  // long-lived ones engine.js arms once (watchdog interval, version-poll
  // interval, periodic-reload timeout).
  assert.equal(clock.size(), 4, "expected exactly one armed reschedule beyond the evergreen timers");

  const idsBeforeTick2 = clock.ids();
  const rescheduleId = [...idsBeforeTick2][idsBeforeTick2.size - 1];

  // Advance one tick: this is the tick where the prefetched "throws" scene
  // (already known unusable) would have stalled the pre-fix build.
  clock.fire(rescheduleId);
  await flush();

  assert.ok(
    tracking.logs.some((l) => /skipping throws/.test(l)),
    "the skip must be logged, not silent"
  );
  assert.deepEqual(tracking.shown, ["a"], "still just \"a\" on screen — \"c\" is prefetched, not yet shown");
  assert.equal(clock.size(), 4, "the loop must still be armed with exactly one reschedule after a skip");

  // Advance again: the loop should now show "c", the scene after the one
  // that threw, proving the rotation kept moving rather than freezing.
  const idsBeforeTick3 = clock.ids();
  const nextRescheduleId = [...idsBeforeTick3].find((id) => !idsBeforeTick2.has(id));
  clock.fire(nextRescheduleId);
  await flush();

  assert.deepEqual(tracking.shown, ["a", "c"], "the loop advanced past the throwing scene to \"c\"");
  assert.equal(clock.size(), 4, "still exactly one reschedule armed — no leaked or doubled timer");

  // One more full lap: the loop should keep cycling indefinitely rather than
  // stopping after working around the single fault.
  const idsBeforeTick4 = clock.ids();
  const thirdRescheduleId = [...idsBeforeTick4].find((id) => !idsBeforeTick3.has(id));
  clock.fire(thirdRescheduleId);
  await flush();

  assert.deepEqual(
    tracking.rendered,
    ["a", "throws", "c", "a", "throws"],
    "rotation wraps and keeps re-attempting the throwing scene each lap"
  );
  assert.equal(clock.size(), 4);
});
