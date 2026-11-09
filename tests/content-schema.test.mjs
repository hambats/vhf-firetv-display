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

test("parse errors name nested files with forward slashes on every OS", async (t) => {
  const dir = await makeFixture();
  t.after(() => cleanup(dir));
  await fs.writeFile(path.join(dir, "content", ANNOUNCEMENTS), "{ not json");
  const errors = await validateContentDir(path.join(dir, "content"));
  assert.ok(errors.some((e) => e.startsWith("content/announcements/announcements.json:")), String(errors));
});
