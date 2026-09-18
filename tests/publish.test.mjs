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
import { promises as fs } from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PUBLISHED_CONTENT } from "../scripts/build-site.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runBuild(buildRoot) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "build-site.mjs")], {
      env: { ...process.env, VHF_BUILD_ROOT: buildRoot },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/*
 * A fixture repo: the real content/ and web/, minus the artwork payload (tens
 * of megabytes of photos that make the copy slow and prove nothing). The two
 * published artwork directories still have to exist, because the build treats
 * a missing entry in its allowlist as an error.
 */
async function makeFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vhf-publish-"));
  await fs.cp(path.join(ROOT, "content"), path.join(dir, "content"), {
    recursive: true,
    filter: (src) => !path.relative(ROOT, src).replace(/\\/g, "/").startsWith("content/artwork/")
  });
  await fs.cp(path.join(ROOT, "web"), path.join(dir, "web"), { recursive: true });
  await fs.mkdir(path.join(dir, "content", "artwork", "brand"), { recursive: true });
  await fs.mkdir(path.join(dir, "content", "artwork", "curated"), { recursive: true });
  return dir;
}

const exists = (p) => fs.access(p).then(() => true, () => false);

test("a successful build publishes every file the engine fetches", async (t) => {
  const dir = await makeFixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

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
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

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
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

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
