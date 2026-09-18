/*
 * scripts/lint-content.mjs exercised against small in-memory fixture
 * content dirs — not the real content/ — so each rule can be checked in
 * isolation against both a bad case and a clean case.
 *
 * Run with: node --test tests/lint-content.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { lintContentDir } from "../scripts/lint-content.mjs";

const BASE_PLAYLIST = { version: 1, playlist: [{ id: "info-1", type: "information", duration: 10, enabled: true, content: { title: "Welcome", body: "A place to heal." } }] };
const BASE_ANNOUNCEMENTS = { version: 1, announcements: [] };
const BASE_EVENTS = { version: 3, events: [] };
const BASE_GALLERY = { version: 1, photos: Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, src: `https://example.com/${i}.jpg`, width: 800, height: 600 })) };

async function makeFixture({ playlist, announcements, events, gallery } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vhf-lint-test-"));
  await fs.writeFile(path.join(dir, "playlist.json"), JSON.stringify(playlist ?? BASE_PLAYLIST));
  await fs.mkdir(path.join(dir, "announcements"), { recursive: true });
  await fs.writeFile(path.join(dir, "announcements", "announcements.json"), JSON.stringify(announcements ?? BASE_ANNOUNCEMENTS));
  await fs.mkdir(path.join(dir, "generated"), { recursive: true });
  await fs.writeFile(path.join(dir, "generated", "events.json"), JSON.stringify(events ?? BASE_EVENTS));
  await fs.writeFile(path.join(dir, "generated", "gallery.json"), JSON.stringify(gallery ?? BASE_GALLERY));
  return dir;
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

test("a clean fixture produces no warnings", async (t) => {
  const dir = await makeFixture();
  t.after(() => cleanup(dir));
  const warnings = await lintContentDir(dir);
  assert.deepEqual(warnings, []);
});

test("flags literal markdown emphasis in an event description", async (t) => {
  const dir = await makeFixture({
    events: { version: 3, events: [{ id: "e1", title: "Workshop", start: "2026-01-01T00:00:00.000Z", description: "**Bring a jacket** and boots." }] }
  });
  t.after(() => cleanup(dir));
  const warnings = await lintContentDir(dir);
  assert.ok(warnings.some((w) => w.id === "e1" && /markdown emphasis/.test(w.reason)));
});

test("flags an ALL-CAPS run longer than ~20 characters", async (t) => {
  const dir = await makeFixture({
    events: { version: 3, events: [{ id: "e2", title: "Workshop", start: "2026-01-01T00:00:00.000Z", description: "PLEASE ARRIVE EARLY AND PARK IN THE BACK LOT, thanks." }] }
  });
  t.after(() => cleanup(dir));
  const warnings = await lintContentDir(dir);
  assert.ok(warnings.some((w) => w.id === "e2" && /ALL-CAPS/.test(w.reason)));
});

test("does not flag a short acronym like VHF or a 5K", async (t) => {
  const dir = await makeFixture({
    events: { version: 3, events: [{ id: "e3", title: "Workshop", start: "2026-01-01T00:00:00.000Z", description: "Join VHF for a 5K fun run on Saturday morning." }] }
  });
  t.after(() => cleanup(dir));
  const warnings = await lintContentDir(dir);
  assert.deepEqual(warnings, []);
});

test("flags a description that is entirely registration boilerplate", async (t) => {
  const dir = await makeFixture({
    events: { version: 3, events: [{ id: "e4", title: "Workshop", start: "2026-01-01T00:00:00.000Z", description: "Please register. Space is limited." }] }
  });
  t.after(() => cleanup(dir));
  const warnings = await lintContentDir(dir);
  assert.ok(warnings.some((w) => w.id === "e4" && /entirely administrative/.test(w.reason)));
});

test("does not flag a description that merely mentions registration alongside real content", async (t) => {
  const dir = await makeFixture({
    events: {
      version: 3,
      events: [{
        id: "e4b",
        title: "Workshop",
        start: "2026-01-01T00:00:00.000Z",
        description: "Learn hand-building techniques with clay in this beginner-friendly session led by our resident potter."
      }]
    }
  });
  t.after(() => cleanup(dir));
  const warnings = await lintContentDir(dir);
  assert.ok(!warnings.some((w) => w.id === "e4b" && /entirely administrative/.test(w.reason)));
});

test("flags a description truncated mid-word", async (t) => {
  // 240 characters, no terminal punctuation — the failure mode of
  // sources/calendar/index.mjs's truncateText(), which is called with
  // maxLen: 240 for descriptions and can fail open onto a raw character
  // limit instead of a clean sentence/word boundary.
  const description = "Staff will be here to provide brief health exams, heartworm tests, as well as vaccines appropriate to your pets and a full review of preventative care options available through the clinic for veterans and their families year round outrigh";
  assert.equal(description.length, 238); // within tolerance of the 240 truncation ceiling
  const dir = await makeFixture({
    events: { version: 3, events: [{ id: "e5", title: "Workshop", start: "2026-01-01T00:00:00.000Z", description }] }
  });
  t.after(() => cleanup(dir));
  const warnings = await lintContentDir(dir);
  assert.ok(warnings.some((w) => w.id === "e5" && /truncated/.test(w.reason)));
});

test("does not flag a complete sentence ending in terminal punctuation", async (t) => {
  const dir = await makeFixture({
    events: { version: 3, events: [{ id: "e6", title: "Workshop", start: "2026-01-01T00:00:00.000Z", description: "Come learn the basics of hand-building with clay and connect with creativity." }] }
  });
  t.after(() => cleanup(dir));
  const warnings = await lintContentDir(dir);
  assert.deepEqual(warnings, []);
});

test("flags the farm's own address in an event location", async (t) => {
  const dir = await makeFixture({
    events: { version: 3, events: [{ id: "e7", title: "Workshop", start: "2026-01-01T00:00:00.000Z", location: "Veterans Healing Farm, 138 Kimzey Rd, Mills River, NC 28759" }] }
  });
  t.after(() => cleanup(dir));
  const warnings = await lintContentDir(dir);
  assert.ok(warnings.some((w) => w.id === "e7" && /farm's own postal address/.test(w.reason)));
});

test("does not flag a genuine off-site venue in the same town/ZIP as the farm", async (t) => {
  const dir = await makeFixture({
    events: { version: 3, events: [{ id: "e8", title: "5K", start: "2026-01-01T00:00:00.000Z", location: "Mills River Park, 124 Town Center Dr, Mills River, NC 28759, USA" }] }
  });
  t.after(() => cleanup(dir));
  const warnings = await lintContentDir(dir);
  assert.deepEqual(warnings, []);
});

test("flags an enabled announcement scene with an empty announcement pool", async (t) => {
  const dir = await makeFixture({
    playlist: { version: 1, playlist: [{ id: "ann", type: "announcement", duration: 10, enabled: true, content: {} }] },
    announcements: { version: 1, announcements: [] }
  });
  t.after(() => cleanup(dir));
  const warnings = await lintContentDir(dir);
  assert.ok(warnings.some((w) => /empty|zero announcements/.test(w.reason)));
});

test("does not flag a disabled announcement scene with an empty pool", async (t) => {
  const dir = await makeFixture({
    playlist: { version: 1, playlist: [{ id: "ann", type: "announcement", duration: 10, enabled: false, content: {} }] },
    announcements: { version: 1, announcements: [] }
  });
  t.after(() => cleanup(dir));
  const warnings = await lintContentDir(dir);
  assert.deepEqual(warnings, []);
});

test("flags the gallery pool falling below the floor", async (t) => {
  const dir = await makeFixture({
    gallery: { version: 1, photos: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, src: `https://example.com/${i}.jpg`, width: 800, height: 600 })) }
  });
  t.after(() => cleanup(dir));
  const warnings = await lintContentDir(dir);
  assert.ok(warnings.some((w) => /below the floor/.test(w.reason)));
});
