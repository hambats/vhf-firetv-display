/*
 * The heartbeat (engine.js, docs/HEARTBEAT.md): the page pings a dead-man's
 * switch only while it is genuinely doing its job. Silence is the alert, so
 * the rules that matter are when it must stay silent:
 *
 *   - pings when visible + advancing + inside opening hours on an open day;
 *   - never when hidden, on a closed day, after hours, or not advancing;
 *   - never in ?slide= embeds (visitors' browsers) or any other query string,
 *     never from a non-television browser;
 *   - fully off (no timer, no request) with no url;
 *   - a ping that throws or rejects cannot stall the scene loop.
 *
 * Same technique as tests/engine.test.mjs: the real engine.js in a vm
 * context with a hand-rolled fake clock, here with a fake Date as well so
 * "now" is a chosen instant at the venue (America/New_York).
 *
 * Run with: node --test tests/heartbeat.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_PATH = path.join(ROOT, "web", "js", "engine.js");

const HB_URL = "https://hc-ping.example/abc-123";
const DWELL_MS = 12000;
const TEN_MINUTES = 10 * 60 * 1000;
const QUIET_RECHECK_MS = 60000;

const TUESDAY_NOON = Date.parse("2026-11-24T17:00:00Z"); // Tue 12:00 in New York
const TUESDAY_EVENING = Date.parse("2026-11-24T23:30:00Z"); // Tue 18:30
const MONDAY_NOON = Date.parse("2026-11-23T17:00:00Z"); // Mon 12:00 (closed)

const FIRE_TV_UA =
  "Mozilla/5.0 (Linux; Android 9; AFTTI43 Build/PS7633; wv) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Version/4.0 Chrome/138.0.7204.0 Mobile Safari/537.36";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

function makeClock(start) {
  let nextId = 1;
  const timers = new Map();
  const clock = {
    now: start,
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
    intervals(ms) {
      return [...timers.values()].filter((t) => t.interval && t.ms === ms).length;
    },
    pending(ms) {
      return [...timers.values()].filter((t) => !t.interval && t.ms === ms).length;
    },
    fireTimeouts(ms) {
      for (const [id, t] of [...timers]) {
        if (!t.interval && t.ms === ms) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    fireIntervals(ms) {
      for (const t of [...timers.values()]) if (t.interval && t.ms === ms) t.fn();
    }
  };
  return clock;
}

function fakeDate(clock) {
  return class extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() {
      return clock.now;
    }
  };
}

async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function scene(id) {
  return { __id: id, style: { setProperty() {} }, querySelector: () => null, querySelectorAll: () => [] };
}

async function boot({
  now = TUESDAY_NOON,
  search = "",
  ua = FIRE_TV_UA,
  heartbeat = { url: HB_URL },
  open = { from: "09:00", to: "17:00" },
  closedWeekdays = [0, 1],
  visibility = "visible",
  pingFails = null // null | "throw" | "reject"
} = {}) {
  const clock = makeClock(now);
  const shown = [];
  const pings = [];
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
  const playlist = ["a", "b", "c"].map((id) => ({ id, type: "t", enabled: true, duration: DWELL_MS / 1000 }));
  const settings = { timezone: "America/New_York", hours: { closedWeekdays } };
  if (open) settings.hours.open = open;
  if (heartbeat) settings.heartbeat = heartbeat;
  const document = { querySelectorAll: () => layers, visibilityState: visibility };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document,
    navigator: { userAgent: ua },
    location: { search, reload() {} },
    Date: fakeDate(clock),
    fetch(url, init) {
      if (url === HB_URL) {
        pings.push({ url, init });
        if (pingFails === "throw") throw new Error("network stack exploded");
        if (pingFails === "reject") return Promise.reject(new Error("offline"));
        return Promise.resolve({ type: "opaque" });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 7 }) });
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    addEventListener() {},
    parent: null,
    VhfCompat: { intlTimeZone: true, summary: () => "chrome=138 ok=es2017,modules" },
    VhfContentSource: {
      fetchJson(p) {
        if (/playlist/.test(p)) return Promise.resolve({ playlist });
        if (/settings/.test(p)) return Promise.resolve(settings);
        return Promise.resolve({});
      },
      setCacheEnabled() {}
    },
    VhfScenes: {
      render: (item) => scene(item.id),
      renderBlank: () => scene("blank"),
      renderError: () => scene("error"),
      setTimeZone() {},
      setEmbedded() {},
      markImageFailed() {},
      upcomingEvents: () => [{ id: "e1" }, { id: "e2" }]
    },
    VhfDiagnostics: {
      visible: false,
      startedAt: now,
      fields: {},
      set(k, v) {
        this.fields[k] = v;
      },
      get(k) {
        return this.fields[k];
      },
      bump() {},
      count: () => 0,
      errors: () => 0,
      error() {}
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await fs.readFile(ENGINE_PATH, "utf8"), sandbox);
  await flush();
  return { sandbox, clock, shown, pings, document };
}

async function beat(clock, ms = TEN_MINUTES) {
  clock.fireIntervals(ms);
  await flush();
}

test("pings when visible, advancing, and inside opening hours on an open day", async () => {
  const { clock, shown, pings } = await boot();
  assert.deepEqual(shown, ["a"]);
  assert.equal(clock.intervals(TEN_MINUTES), 1, "default interval is 10 minutes");

  await beat(clock);
  assert.equal(pings.length, 1);
  const { init } = pings[0];
  assert.equal(init.method, "POST");
  assert.equal(init.mode, "no-cors");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.match(init.body, /content=7 /);
  assert.match(init.body, /events=2 /);
  assert.match(init.body, /scene=a/);
  assert.match(init.body, /probe chrome=138/);
  assert.ok(init.body.length <= 1000);
});

test("never pings while hidden behind another app, and resumes when visible", async () => {
  const { clock, pings, document, sandbox } = await boot({ visibility: "hidden" });
  await beat(clock);
  assert.equal(pings.length, 0);
  assert.match(sandbox.VhfDiagnostics.fields.heartbeat, /hidden/);

  document.visibilityState = "visible";
  await beat(clock);
  assert.equal(pings.length, 1);
});

test("never pings on a closed day", async () => {
  const { clock, shown, pings } = await boot({ now: MONDAY_NOON });
  assert.deepEqual(shown, ["blank"]);
  await beat(clock);
  clock.fireTimeouts(QUIET_RECHECK_MS);
  await flush();
  await beat(clock);
  assert.equal(pings.length, 0);
});

test("never pings outside opening hours on an open day", async () => {
  const { clock, shown, pings } = await boot({ now: TUESDAY_EVENING });
  assert.deepEqual(shown, ["a"], "the display itself still runs after hours");
  await beat(clock);
  assert.equal(pings.length, 0);
});

test("never pings without hours.open, even with a url", async () => {
  const { clock, pings } = await boot({ open: null });
  await beat(clock);
  assert.equal(pings.length, 0);
});

test("never pings when the scenes have stopped advancing", async () => {
  const { clock, pings } = await boot();
  clock.now += 5 * 60 * 1000; // five minutes with no scene change
  await beat(clock);
  assert.equal(pings.length, 0);

  clock.fireTimeouts(DWELL_MS); // the loop moves again
  await flush();
  await beat(clock);
  assert.equal(pings.length, 1);
});

test("?slide= embeds and other query strings never arm the heartbeat", async () => {
  for (const search of ["?slide=e1", "?slide=next", "?diag=1", "?awake=1"]) {
    const { clock, pings } = await boot({ search });
    assert.equal(clock.intervals(TEN_MINUTES), 0, search);
    await beat(clock);
    assert.equal(pings.length, 0, search);
  }
});

test("an ordinary desktop browser on the bare URL never pings", async () => {
  const { clock, pings, sandbox } = await boot({ ua: DESKTOP_UA });
  assert.equal(clock.intervals(TEN_MINUTES), 0);
  await beat(clock);
  assert.equal(pings.length, 0);
  assert.match(sandbox.VhfDiagnostics.fields.heartbeat, /not the television/);
});

test("no url means fully off: no timer, no request", async () => {
  for (const heartbeat of [null, { url: "" }, { intervalMinutes: 10 }, { url: "http://insecure.example/x" }]) {
    const { clock, pings, sandbox } = await boot({ heartbeat });
    assert.equal(clock.intervals(TEN_MINUTES), 0, JSON.stringify(heartbeat));
    await beat(clock);
    assert.equal(pings.length, 0);
    assert.equal(sandbox.VhfDiagnostics.fields.heartbeat, "off");
  }
});

test("intervalMinutes sets the ping interval", async () => {
  const { clock, pings } = await boot({ heartbeat: { url: HB_URL, intervalMinutes: 5 } });
  assert.equal(clock.intervals(TEN_MINUTES), 0);
  assert.equal(clock.intervals(5 * 60 * 1000), 1);
  await beat(clock, 5 * 60 * 1000);
  assert.equal(pings.length, 1);
});

for (const pingFails of ["throw", "reject"]) {
  test(`a ping that ${pingFails}s cannot stall the scene loop`, async () => {
    const { clock, shown, pings } = await boot({ pingFails });
    for (let lap = 0; lap < 4; lap++) {
      await beat(clock);
      clock.fireTimeouts(DWELL_MS);
      await flush();
      assert.equal(clock.pending(DWELL_MS), 1, "exactly one armed scene timer");
    }
    assert.equal(pings.length, 4, "every beat still tried");
    assert.deepEqual(shown, ["a", "b", "c", "a", "b"]);
  });
}
