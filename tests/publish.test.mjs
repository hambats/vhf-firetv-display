/*
 * The two guarantees the publish path owes the display.
 *
 *   1. Invalid content never reaches dist/ — a failed build leaves whatever is
 *      already deployed alone rather than replacing it with something broken.
 *   2. dist/ contains exactly what the viewer fetches: every file the engine
 *      asks for, and none of the PC-side curation notes.
 *
 * Run with: node --test tests/publish.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { PUBLISHED_CONTENT } from "../scripts/build-site.mjs";
import {
  spawnPlan,
  parsePorcelainZ,
  classifyEntries,
  commitArgs,
  isNewBuild,
  parseAheadBehind
} from "../scripts/publish.mjs";
import { ROOT, runBuild, makeFixture, exists, cleanup } from "./helpers/build-fixture.mjs";

test("a successful build publishes every file the engine fetches", async (t) => {
  const dir = await makeFixture();
  t.after(() => cleanup(dir));

  const { code, out } = await runBuild(dir);
  assert.equal(code, 0, "build should succeed on valid content:\n" + out);

  /*
   * The engine's own fetch list, read out of the source rather than restated
   * here: adding a content file to web/js without adding it to
   * PUBLISHED_CONTENT is exactly the mistake this catches — it works in local
   * preview, where the whole repo is served, and 404s once deployed.
   */
  const engineSrc = await fs.readFile(path.join(ROOT, "web", "js", "engine.js"), "utf8");
  const fetched = [...engineSrc.matchAll(/["'`](content\/[A-Za-z0-9_/.-]+\.json)["'`]/g)]
    .map((m) => m[1])
    .filter((p) => !p.endsWith("version.json"));
  assert.ok(fetched.length >= 5, "expected to find the engine's content fetches, got " + fetched.length);

  for (const rel of fetched) {
    assert.ok(
      await exists(path.join(dir, "dist", rel)),
      `engine.js fetches ${rel}, but the build did not publish it — add it to PUBLISHED_CONTENT`
    );
  }
});

test("curation notes and candidate artwork never reach dist/", async (t) => {
  const dir = await makeFixture();
  t.after(() => cleanup(dir));

  const { code } = await runBuild(dir);
  assert.equal(code, 0);

  /*
   * gallery-exclude.json carries a free-text `reason` for every photo pulled
   * from rotation — working notes about VHF's own photographs, written for the
   * curator, not for the public.
   */
  for (const rel of ["content/gallery-exclude.json", "content/events-exclude.json"]) {
    assert.equal(await exists(path.join(dir, "dist", rel)), false, `${rel} must not be published`);
    assert.equal(
      PUBLISHED_CONTENT.includes(rel.replace("content/", "")),
      false,
      `${rel} must not be in PUBLISHED_CONTENT`
    );
  }
});

test("invalid content fails the build and leaves dist/ untouched", async (t) => {
  const dir = await makeFixture();
  t.after(() => cleanup(dir));

  assert.equal((await runBuild(dir)).code, 0, "fixture should build cleanly first");
  const good = await fs.readFile(path.join(dir, "dist", "content", "playlist.json"), "utf8");

  const playlist = path.join(dir, "content", "playlist.json");
  const original = await fs.readFile(playlist, "utf8");
  const broken = JSON.parse(original);
  broken.playlist[0].type = "not-a-real-scene-type";
  await fs.writeFile(playlist, JSON.stringify(broken, null, 2));

  const { code, out } = await runBuild(dir);
  assert.notEqual(code, 0, "build must fail on an invalid scene type");
  assert.match(out, /validation failed/i);

  const after = await fs.readFile(path.join(dir, "dist", "content", "playlist.json"), "utf8");
  assert.equal(after, good, "the previously published playlist must survive a failed build");
});

/*
 * scripts/publish.mjs's git handling. These run real git against a throwaway
 * repository: the bugs they pin down were all in the space between what the
 * script handed git and what git actually received.
 */

const NASTY_MESSAGE = 'Rename "Q&A" slide to 100%PATH% done';

test("git is spawned without a shell, so a commit message arrives verbatim", () => {
  const win = spawnPlan("git", ["commit", "-m", NASTY_MESSAGE], "win32");
  assert.equal(win.shell, false);
  assert.deepEqual(win.args, ["commit", "-m", NASTY_MESSAGE]);

  // npm is a .cmd shim on Windows and still needs one; it never carries user text.
  const npm = spawnPlan("npm", ["test"], "win32");
  assert.equal(npm.shell, true);
  assert.equal(spawnPlan("npm", ["test"], "linux").shell, false);
});

test("porcelain -z parsing keeps unusual names, renames and untracked folders intact", () => {
  const out = [
    " M content/artwork/curated/program-x/Maddie’s pie.jpg",
    "R  content/new name.json",
    "content/old name.json",
    "?? content/artwork/drive/program-new/",
    "?? content/artwork/candidates/x.png",
    ""
  ].join("\0");
  const entries = parsePorcelainZ(out);
  assert.deepEqual(entries.map((e) => e.path), [
    "content/artwork/curated/program-x/Maddie’s pie.jpg",
    "content/new name.json",
    "content/artwork/drive/program-new",
    "content/artwork/candidates/x.png"
  ]);
  assert.equal(entries[1].from, "content/old name.json");

  const { staging, heldBack, renamedFrom } = classifyEntries(entries);
  assert.deepEqual(heldBack, ["content/artwork/candidates/x.png"]);
  assert.ok(staging.includes("content/artwork/drive/program-new"));
  assert.deepEqual(renamedFrom, ["content/old name.json"]);
});

test("ahead/behind counts are read from rev-list", () => {
  assert.deepEqual(parseAheadBehind("2\t5\n"), { ahead: 2, behind: 5 });
  assert.deepEqual(parseAheadBehind("0\t0"), { ahead: 0, behind: 0 });
});

test("a publish commit holds exactly the publish, whatever else is staged", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vhf-git-"));
  t.after(() => cleanup(dir));
  const g = (...args) => execFileSync("git", ["--literal-pathspecs", ...args], { cwd: dir, encoding: "utf8" });
  const write = async (rel, body) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), body);
  };

  g("init", "-q");
  g("config", "user.name", "test");
  g("config", "user.email", "test@example.com");
  g("config", "core.autocrlf", "false");
  await write("content/artwork/curated/program-x/Maddie’s pie.jpg", "a");
  await write("content/artwork/curated/program-x/flyer[1].jpg", "a");
  await write("content/old.json", "{\"old\": true}");
  await write("content/gone.json", "{\"gone\": true}");
  await write("app/Main.kt", "a");
  g("add", "-A");
  g("commit", "-q", "-m", "init");

  await write("content/artwork/curated/program-x/Maddie’s pie.jpg", "b");
  await write("content/artwork/curated/program-x/flyer[1].jpg", "b");
  await write("content/artwork/drive/program-new/1abc.jpg", "new");
  await write("content/artwork/candidates/draft.png", "not for publishing");
  await fs.rm(path.join(dir, "content", "gone.json"));
  g("mv", "content/old.json", "content/renamed.json");
  await write("app/Main.kt", "unrelated work in progress");
  g("add", "app/Main.kt");

  const entries = parsePorcelainZ(g("status", "--porcelain", "-z", "--", "content", "web"));
  const { staging, heldBack, renamedFrom } = classifyEntries(entries);
  // git reports a wholly untracked folder as the folder itself.
  assert.deepEqual(heldBack, ["content/artwork/candidates"]);

  g("add", "--", ...staging);
  g(...commitArgs(NASTY_MESSAGE, staging.concat(renamedFrom)));

  assert.equal(g("log", "-1", "--format=%s").trim(), NASTY_MESSAGE);
  const committed = g("-c", "core.quotePath=false", "show", "--name-status", "--format=", "HEAD").trim().split("\n").sort();
  assert.deepEqual(committed, [
    "A\tcontent/artwork/drive/program-new/1abc.jpg",
    "D\tcontent/gone.json",
    "M\tcontent/artwork/curated/program-x/Maddie’s pie.jpg",
    "M\tcontent/artwork/curated/program-x/flyer[1].jpg",
    "R100\tcontent/old.json\tcontent/renamed.json"
  ]);
  // The unrelated staged change is still staged, and still uncommitted.
  assert.match(g("status", "--porcelain", "--", "app"), /^M  app\/Main\.kt/);
});

test("a publish is only verified by a build made after the push", () => {
  const pushStartedAt = Date.parse("2026-11-08T18:00:00Z");
  const old = { version: Date.parse("2026-11-07T17:55:00Z") };
  const fresh = { version: pushStartedAt + 45_000 };

  // The bug: with the pre-push read failed, the old manifest passed.
  assert.equal(isNewBuild(old, { before: null, pushStartedAt }), false);
  assert.equal(isNewBuild(old, { before: old, pushStartedAt }), false);
  assert.equal(isNewBuild(fresh, { before: old, pushStartedAt }), true);
  assert.equal(isNewBuild(fresh, { before: null, pushStartedAt }), true);
  assert.equal(isNewBuild(null, { before: old, pushStartedAt }), false);
  // A manifest that names its commit is matched exactly.
  assert.equal(isNewBuild({ ...fresh, commit: "abc1234" }, { pushStartedAt, commit: "abc1234def" }), true);
  assert.equal(isNewBuild({ ...fresh, commit: "fff0000" }, { pushStartedAt, commit: "abc1234def" }), false);
});
