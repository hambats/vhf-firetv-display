/*
 * Closed days, and the remote's BACK key.
 *
 * The closed-day "wake on BACK" is gone (proposal F5): knowing the display is
 * alive is the heartbeat's job, not staff pressing buttons. But the installed
 * 1.2.1 shell (app/.../DisplayActivity.kt onKeyUp) still evaluates
 *
 *     window.VhfQuietHours && window.VhfQuietHours.wake();
 *
 * on every BACK press, on any day, and the web side ships before any new APK.
 * So these tests pin that the shell's exact expression is a harmless no-op:
 * it does not throw, does not light a closed day, and does not skip or
 * double the scene loop on an open one. Closed days stay a lit black screen.
 *
 * The real engine.js in a vm context, a fake clock the test fires by hand.
 * Each scene carries one content image that never loads, so warming waits on
 * its budget timer and the test controls exactly when a tick is "in flight".
 *
 * Run with: node --test tests/engine-quiet.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_PATH = path.join(ROOT, "web", "js", "engine.js");

// Distinct from every engine constant (2.5s/8s budgets, 10s backstop, 60s
// quiet recheck), so a pending timer of this length is a scene dwell.
const DWELL_MS = 12000;
const FIRST_PAINT_BUDGET_MS = 2500;
const PRELOAD_BUDGET_MS = 8000;
const QUIET_RECHECK_MS = 60000;

function makeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms, interval: false });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms, interval: true });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    pending(ms) {
      return [...timers].filter(([, t]) => !t.interval && t.ms === ms).map(([id]) => id);
    },
    fireAll(ms) {
      for (const [id, t] of [...timers]) {
        if (!t.interval && t.ms === ms) {
          timers.delete(id);
          t.fn();
        }
      }
    }
  };
}

async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function sceneWithSlowImage(id) {
  const image = { complete: false, getAttribute: () => "content", addEventListener() {}, style: {} };
  return {
    __id: id,
    style: { setProperty() {} },
    querySelector: () => null,
    querySelectorAll: () => [image]
  };
}

async function boot({ closedToday, diag = false, items }) {
  const clock = makeClock();
  const shown = [];
  const layer = () => ({
    innerHTML: "",
    classList: { add() {}, remove() {} },
    appendChild(node) {
      shown.push(node.__id);
    },
    get offsetWidth() {
      return 1;
    }
  });
  const layers = [layer(), layer()];
  const playlist = (items || ["a", "b", "c"]).map((id) => ({ id, type: "t", enabled: true, duration: DWELL_MS / 1000 }));
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: { querySelectorAll: () => layers },
    location: { search: "", reload() {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 1 }) }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    addEventListener() {},
    VhfContentSource: {
      fetchJson(p) {
        if (/playlist/.test(p)) return Promise.resolve({ playlist });
        // Every weekday closed, or none: "today" is then closed or open
        // whatever the real date is.
        if (/settings/.test(p)) return Promise.resolve({ hours: { closedWeekdays: closedToday ? [0, 1, 2, 3, 4, 5, 6] : [] } });
        return Promise.resolve({});
      }
    },
    VhfScenes: {
      render(item) {
        if (item.id === "throttled") throw new Error("throttled: showing 1 in 2 passes");
        return sceneWithSlowImage(item.id);
      },
      renderBlank: () => ({ __id: "blank", querySelectorAll: () => [] }),
      renderError: () => ({ __id: "error", querySelectorAll: () => [] }),
      setTimeZone() {},
      markImageFailed() {}
    },
    VhfDiagnostics: { visible: diag, set() {}, bump() {}, error() {} }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await fs.readFile(ENGINE_PATH, "utf8"), sandbox);
  await flush();
  return { sandbox, clock, shown };
}

// The exact expression the installed 1.2.1 shell evaluates on a BACK press
// (DisplayActivity.kt onKeyUp). Each press is its own task on the device.
const SHELL_BACK_JS = "window.VhfQuietHours && window.VhfQuietHours.wake();";

async function press(sandbox) {
  vm.runInContext(SHELL_BACK_JS, sandbox);
  await flush();
}

test("there is no VhfQuietHours to wake", async () => {
  const { sandbox } = await boot({ closedToday: true });
  assert.equal(sandbox.VhfQuietHours, undefined);
});

test("a closed day stays black through BACK presses, on one recheck timer", async () => {
  const { sandbox, clock, shown } = await boot({ closedToday: true });
  assert.deepEqual(shown, ["blank"]);
  assert.equal(clock.pending(QUIET_RECHECK_MS).length, 1);

  await press(sandbox);
  await press(sandbox);
  clock.fireAll(FIRST_PAINT_BUDGET_MS);
  await flush();
  assert.deepEqual(shown, ["blank"], "BACK no longer lights a closed day");
  assert.equal(clock.pending(QUIET_RECHECK_MS).length, 1);
  assert.equal(clock.pending(DWELL_MS).length, 0);

  // The recheck keeps the frame black, still on exactly one timer.
  clock.fireAll(QUIET_RECHECK_MS);
  await flush();
  assert.deepEqual(shown, ["blank", "blank"]);
  assert.equal(clock.pending(QUIET_RECHECK_MS).length, 1);
});

test("BACK on an open day does not skip the scene on screen", async () => {
  const { sandbox, clock, shown } = await boot({ closedToday: false });
  clock.fireAll(FIRST_PAINT_BUDGET_MS);
  await flush();
  assert.deepEqual(shown, ["a"]);
  const armed = clock.pending(DWELL_MS);
  assert.equal(armed.length, 1);

  await press(sandbox);
  clock.fireAll(PRELOAD_BUDGET_MS); // "b" finishes warming
  await flush();

  assert.deepEqual(shown, ["a"], "the scene on screen keeps its full dwell");
  assert.deepEqual(clock.pending(DWELL_MS), armed, "the same dwell timer is still the one armed");
});

test("a BACK press mid-tick leaves exactly one loop", async () => {
  // The window right after a throttled scene is skipped: the replacement is
  // still warming and no dwell timer is armed.
  const { sandbox, clock, shown } = await boot({ closedToday: false, items: ["a", "throttled", "c"] });
  clock.fireAll(FIRST_PAINT_BUDGET_MS);
  await flush();
  clock.fireAll(DWELL_MS); // "throttled" was prepared ahead and is skipped
  await flush();
  clock.fireAll(0); // the immediate re-tick; "c" is still warming
  await flush();
  assert.equal(clock.pending(DWELL_MS).length, 0);

  await press(sandbox);
  clock.fireAll(PRELOAD_BUDGET_MS);
  await flush();

  assert.deepEqual(shown, ["a", "c"]);
  assert.equal(clock.pending(DWELL_MS).length, 1);
});

test("?diag=1 skip-ahead acts on a parked loop and is ignored mid-tick", async () => {
  const { sandbox, clock, shown } = await boot({ closedToday: false, diag: true });
  clock.fireAll(FIRST_PAINT_BUDGET_MS);
  await flush();
  clock.fireAll(PRELOAD_BUDGET_MS); // "b" warmed, the loop is parked on "a"
  await flush();

  sandbox.VhfEngine.advanceNow();
  await flush();
  assert.deepEqual(shown, ["a", "b"], "a parked loop skips ahead");

  clock.fireAll(DWELL_MS); // "b"'s dwell ends; "c" was only just started, so this tick waits on it
  await flush();
  sandbox.VhfEngine.advanceNow(); // mid-tick: must not start a second chain
  await flush();
  clock.fireAll(PRELOAD_BUDGET_MS);
  await flush();
  assert.equal(clock.pending(DWELL_MS).length, 1);
});
