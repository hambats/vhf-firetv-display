#!/usr/bin/env node
/*
 * Builds content/generated/curated-photos.json from content/artwork/curated/.
 * PC-side only, like sources/gallery and sources/calendar — the display never
 * scans a filesystem, it only ever reads the generated JSON.
 *
 * Each subfolder of content/artwork/curated/ becomes one named photo set:
 *   content/artwork/curated/program-pottery/*.jpg  -> curated["program-pottery"]
 *   content/artwork/curated/in-uniform/*.jpg        -> curated["in-uniform"]
 *   content/artwork/curated/military-art/*.jpg      -> curated["military-art"]
 *
 * Two kinds of set, told apart by naming convention rather than a config
 * file: a "program-*" set is matched to playlist items and calendar events by
 * id/keyword (see web/js/scenes.js appendWash and sources/calendar's
 * PROGRAM_KEYWORDS); any other set (in-uniform, military-art, ...) is a
 * standalone category referenced directly from playlist.json via
 * content.source.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imageSize } from "./image-size.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const CURATED_DIR = path.join(ROOT, "content", "artwork", "curated");
const OUTPUT_PATH = path.join(ROOT, "content", "generated", "curated-photos.json");

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

async function main() {
  const sets = {};
  let entries;
  try {
    entries = await fs.readdir(CURATED_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") entries = [];
    else throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(CURATED_DIR, entry.name);
    const files = (await fs.readdir(dir))
      .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
      .sort();
    if (files.length === 0) continue;

    // Optional per-photo caption text — a hand-maintained captions.json
    // sitting next to the images in the same folder, e.g. military-art's
    // Iwo Jima photo getting its own line of history instead of sharing
    // the pool's generic eyebrow. Absent by default; never required.
    let captions = {};
    try {
      captions = JSON.parse(await fs.readFile(path.join(dir, "captions.json"), "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    /*
     * Optional per-photo crop focus, same shape as content/gallery-focus.json
     * does for the scraped pool: a hand-maintained focus.json beside the
     * images, mapping a filename to an object-position value.
     *
     * A cover crop centres on the middle of the frame, which is wrong
     * whenever the subject is not there — a tall shot of a piece of pottery
     * held up to the camera centres on the wall behind it. Absent by
     * default; only the photos that actually crop badly need an entry.
     */
    let focus = {};
    try {
      focus = JSON.parse(await fs.readFile(path.join(dir, "focus.json"), "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }

    /*
     * Intrinsic dimensions, so the display can pick a slide's layout from the
     * shape of the photograph on it (DESIGN_PLAN D3.2) without measuring the
     * image itself. Scraped gallery photos have carried width and height all
     * along; this brings curated ones level. Header-only and dependency-free --
     * see image-size.mjs.
     */
    sets[entry.name] = await Promise.all(files.map(async (f) => {
      const photo = {
        id: `${entry.name}/${f}`,
        src: `content/artwork/curated/${entry.name}/${encodeURIComponent(f)}`
      };
      const size = await imageSize(path.join(dir, f));
      if (size) {
        photo.width = size.width;
        photo.height = size.height;
      }
      if (captions[f]) photo.caption = captions[f];
      if (focus[f]) photo.focus = focus[f];
      return photo;
    }));
  }

  const output = {
    version: 1,
    source: "content/artwork/curated (hand-curated, PC-side only)",
    generatedAt: new Date().toISOString(),
    sets
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");

  const summary = Object.entries(sets).map(([name, photos]) => `${name}(${photos.length})`).join(", ");
  console.log(`[curated-photos] wrote ${Object.keys(sets).length} set(s) -> ${path.relative(ROOT, OUTPUT_PATH)}${summary ? ": " + summary : ""}`);
}

main().catch((err) => {
  console.error("[curated-photos] failed:", err);
  process.exit(1);
});
