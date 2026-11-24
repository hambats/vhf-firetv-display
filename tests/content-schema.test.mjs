/*
 * Every file under content/ matches docs/CONTENT_SCHEMA.md.
 * Run with: node --test tests/content-schema.test.mjs
 * (Node's built-in test runner — no extra dependency needed.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateContentDir } from "../scripts/validate-content.mjs";
import { promises as fs } from "node:fs";
import { makeFixture, cleanup } from "./helpers/build-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_DIR = path.join(ROOT, "content");

test("content/ matches the documented schema", async () => {
  const errors = await validateContentDir(CONTENT_DIR);
  assert.deepEqual(errors, []);
});

/*
 * Hand-typed times. Each case copies content/ to a throwaway tree, breaks one
 * thing, and checks the validator names it.
 */

async function errorsAfter(t, rel, mutate) {
  const dir = await makeFixture();
  t.after(() => cleanup(dir));
  const file = path.join(dir, "content", rel);
  if (mutate === null) {
    await fs.rm(file, { force: true });
  } else {
    const doc = JSON.parse(await fs.readFile(file, "utf8"));
    mutate(doc);
    await fs.writeFile(file, JSON.stringify(doc, null, 2));
  }
  return validateContentDir(path.join(dir, "content"));
}

const ANNOUNCEMENTS = path.join("announcements", "announcements.json");

test("announcement times must carry a UTC offset or Z", async (t) => {
  for (const bad of ["2026-11-08", "2026-11-08T23:59:59", "next tuesday"]) {
    const errors = await errorsAfter(t, ANNOUNCEMENTS, (d) => {
      d.announcements[0].expiration = bad;
    });
    assert.ok(errors.some((e) => /"expiration" must be a full date-time with a UTC offset/.test(e)), `${bad}: ${errors}`);
  }
  const ok = await errorsAfter(t, ANNOUNCEMENTS, (d) => {
    d.announcements[0].activation = "2026-09-01T04:00:00Z";
    d.announcements[0].expiration = "2026-11-08T23:59:59.000-05:00";
  });
  assert.deepEqual(ok, []);
});

test("time overrides are validated: shape, ids and zoned times", async (t) => {
  const errors = await errorsAfter(t, "events-time-overrides.json", (d) => {
    d.overrides["open-studio-2026-12-05"] = { start: "2026-12-05T10:00:00" };
    d.overrides["not-an-id"] = { start: "2026-12-05T15:00:00Z" };
    d.overrides["backwards-2026-12-06"] = { start: "2026-12-06T15:00:00Z", end: "2026-12-06T14:00:00Z" };
    d.overrides["empty-2026-12-07"] = {};
  });
  const text = errors.join("\n");
  assert.match(text, /"open-studio-2026-12-05": "start" must be a full date-time with a UTC offset/);
  assert.match(text, /"not-an-id": key must be an event id/);
  assert.match(text, /"backwards-2026-12-06": "end" is before "start"/);
  assert.match(text, /"empty-2026-12-07": needs "start" and\/or "end"/);
});

test("an unparseable time-overrides file fails validation; a missing one does not", async (t) => {
  const dir = await makeFixture();
  t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, "content", "events-time-overrides.json"), "{ not json");
  const errors = await validateContentDir(path.join(dir, "content"));
  assert.ok(errors.some((e) => e.startsWith("content/events-time-overrides.json:")), String(errors));

  assert.deepEqual(await errorsAfter(t, "events-time-overrides.json", null), []);
});

test("information family and callout are validated", async (t) => {
  const info = (d, id) => d.playlist.find((i) => i.id === id);
  const errors = await errorsAfter(t, "playlist.json", (d) => {
    info(d, "memorial-wall").content.family = "memorial";
    info(d, "our-mission").content.callout = "Dial 988, then press 1";
    info(d, "crisis-line").content.callout = "  ";
  });
  const text = errors.join("\n");
  assert.match(text, /"memorial-wall": "content.family" must be one of impact, crisis/);
  assert.match(text, /"our-mission": "content.callout" is only shown on a "crisis" family slide/);
  assert.match(text, /"crisis-line": "content.callout" must be a non-empty string/);
});

test("parse errors name nested files with forward slashes on every OS", async (t) => {
  const dir = await makeFixture();
  t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, "content", ANNOUNCEMENTS), "{ not json");
  const errors = await validateContentDir(path.join(dir, "content"));
  assert.ok(errors.some((e) => e.startsWith("content/announcements/announcements.json:")), String(errors));
});

test("heartbeat: off by default, https only, and needs opening hours", async (t) => {
  const settingsErrors = (mutate) => errorsAfter(t, "settings.json", mutate);

  assert.deepEqual(await settingsErrors((d) => { delete d.heartbeat; }), []);
  assert.deepEqual(await settingsErrors((d) => { d.heartbeat = { url: "" }; }), []);

  const noHours = await settingsErrors((d) => {
    d.heartbeat = { url: "https://hc-ping.com/0000" };
    delete d.hours.open;
  });
  assert.ok(noHours.some((e) => /"heartbeat.url" needs "hours.open"/.test(e)), String(noHours));

  for (const url of ["http://hc-ping.com/0000", "hc-ping.com/0000", "javascript:alert(1)", 42]) {
    const errors = await settingsErrors((d) => {
      d.heartbeat = { url };
      d.hours.open = { from: "10:00", to: "16:00" };
    });
    assert.ok(errors.some((e) => /"heartbeat.url" must be/.test(e)), `${url}: ${errors}`);
  }

  const ok = await settingsErrors((d) => {
    d.heartbeat = { url: "https://hc-ping.com/0000", intervalMinutes: 10 };
    d.hours.open = { from: "10:00", to: "16:00" };
  });
  assert.deepEqual(ok, []);

  for (const intervalMinutes of [0, 45, "10"]) {
    const errors = await settingsErrors((d) => { d.heartbeat = { url: "", intervalMinutes }; });
    assert.ok(errors.some((e) => /"heartbeat.intervalMinutes"/.test(e)), `${intervalMinutes}: ${errors}`);
  }
});

test("hours.open must be a from < to pair of 24-hour times", async (t) => {
  for (const open of [{ from: "4pm", to: "17:00" }, { from: "16:00", to: "10:00" }, { from: "10:00" }, "10-16", { from: "10:00", to: "24:30" }]) {
    const errors = await errorsAfter(t, "settings.json", (d) => { d.hours.open = open; });
    assert.ok(errors.some((e) => /"hours.open/.test(e)), `${JSON.stringify(open)}: ${errors}`);
  }
  const ok = await errorsAfter(t, "settings.json", (d) => { d.hours.open = { from: "09:30", to: "24:00" }; });
  assert.deepEqual(ok, []);
});
