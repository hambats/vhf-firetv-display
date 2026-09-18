#!/usr/bin/env node
/*
 * Runs every content source adapter, PC-side only. Each adapter writes only
 * to content/generated/ — this script never touches anything a human hand-
 * edits (playlist.json, settings.json, announcements.json).
 *
 * Currently: gallery (then the photo mirror, which rewrites the pool's `src`
 * to the local copies) and calendar. Instagram is still not started; add it
 * here once its adapter lands.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function run(label, modulePath) {
  console.log(`\n=== ${label} ===`);
  await import(modulePath);
}

async function main() {
  await run("gallery", path.join(ROOT, "sources", "gallery", "index.mjs"));
  await run("photos", path.join(ROOT, "scripts", "fetch-photos.mjs"));
  await run("calendar", path.join(ROOT, "sources", "calendar", "index.mjs"));
  console.log("\n[sync-sources] done. Review the diff in content/generated/ before publishing.");
}

main().catch((err) => {
  console.error("[sync-sources] unexpected failure:", err);
  process.exitCode = 1;
});
