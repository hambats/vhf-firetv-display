/*
 * The gallery adapter must never write a broken pool. The CI sync publishes
 * whatever lands in content/generated/gallery.json, so a scrape that half
 * failed has to fail the run rather than empty the photo scenes on the wall.
 *
 * Runs the real adapter as a child process, exactly as `npm run sync-sources`
 * and the admin's sync button do, against a throwaway tree and a stubbed
 * fetch -- no network, and the repo's own gallery.json is never touched.
 *
 * Run with: node --test tests/gallery.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SENTINEL = JSON.stringify({ version: 1, source: "last good sync", photos: [{ id: "keep-me" }] }, null, 2) + "\n";

/*
 * Stands in for the Squarespace gallery pages and its image CDN. Each page
 * lists `perPage` photos; a Range request for one returns a 32-byte WebP VP8X
 * header carrying its dimensions, which is all the adapter reads.
 */
const STUB = `
const cfg = JSON.parse(process.env.GALLERY_STUB);
function vp8x(w, h) {
  const b = Buffer.alloc(32);
  b.write("RIFF", 0, "ascii"); b.write("WEBP", 8, "ascii"); b.write("VP8X", 12, "ascii");
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}
globalThis.fetch = async (url) => {
  url = String(url);
  const page = /veteranshealingfarm\\.org\\/(gallery-[\\w-]+)/.exec(url);
  if (page) {
    if (cfg.failPages.includes(page[1])) return new Response("unavailable", { status: 503 });
    const imgs = [];
    for (let i = 0; i < cfg.perPage; i++) {
      const n = String(cfg.pages.indexOf(page[1]) * 100 + i).padStart(4, "0");
      imgs.push('<img src="https://images.squarespace-cdn.com/content/v1/site/' + n + '/IMG_' + n + '.jpg">');
    }
    return new Response("<html>" + imgs.join("") + "</html>", { status: 200 });
  }
  if (url.includes("squarespace-cdn.com")) return new Response(vp8x(2500, 1875), { status: 206 });
  return new Response("not stubbed", { status: 404 });
};
`;

const PAGES = ["gallery-2026", "gallery-2025", "gallery-2024-present"];

async function makeTree() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vhf-gallery-"));
  await fs.mkdir(path.join(dir, "sources", "gallery"), { recursive: true });
  await fs.mkdir(path.join(dir, "content", "generated"), { recursive: true });
  await fs.copyFile(path.join(ROOT, "sources", "gallery", "index.mjs"), path.join(dir, "sources", "gallery", "index.mjs"));
  await fs.writeFile(path.join(dir, "content", "generated", "gallery.json"), SENTINEL);
  await fs.writeFile(path.join(dir, "stub-fetch.mjs"), STUB);
  return dir;
}

function runGallery(dir, cfg) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(path.join(dir, "stub-fetch.mjs")).href, path.join(dir, "sources", "gallery", "index.mjs")],
      {
        env: { ...process.env, GITHUB_ACTIONS: "", GALLERY_STUB: JSON.stringify({ pages: PAGES, failPages: [], perPage: 10, ...cfg }) },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const readOutput = (dir) => fs.readFile(path.join(dir, "content", "generated", "gallery.json"), "utf8");
const cleanup = (dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

test("a healthy scrape writes the pool", async (t) => {
  const dir = await makeTree();
  t.after(() => cleanup(dir));
  const { code, out } = await runGallery(dir, {});
  assert.equal(code, 0, out);
  const doc = JSON.parse(await readOutput(dir));
  assert.equal(doc.photos.length, 30);
  assert.equal(new Set(doc.photos.map((p) => p.id)).size, 30);
});

test("one unreadable gallery page fails the sync and keeps the last good pool", async (t) => {
  const dir = await makeTree();
  t.after(() => cleanup(dir));
  const { code, out } = await runGallery(dir, { failPages: ["gallery-2025"] });
  assert.notEqual(code, 0, "a missing page must fail the run, not shrink the pool");
  assert.match(out, /could not be read/);
  assert.equal(await readOutput(dir), SENTINEL);
});

test("every page down never writes an empty pool", async (t) => {
  const dir = await makeTree();
  t.after(() => cleanup(dir));
  const { code } = await runGallery(dir, { failPages: PAGES });
  assert.notEqual(code, 0);
  assert.equal(await readOutput(dir), SENTINEL);
});

test("a pool below the lint floor is refused, not published", async (t) => {
  // Pages that load but match almost nothing: what a Squarespace template
  // change looks like from here.
  const dir = await makeTree();
  t.after(() => cleanup(dir));
  const { code, out } = await runGallery(dir, { perPage: 5 });
  assert.notEqual(code, 0);
  assert.match(out, /below the floor of 20/);
  assert.equal(await readOutput(dir), SENTINEL);
});
