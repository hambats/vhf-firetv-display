#!/usr/bin/env node
/*
 * Runs every content source adapter, PC-side only. Each adapter writes only
 * to content/generated/ — this script never touches anything a human hand-
 * edits (playlist.json, settings.json, announcements.json).
 *
 * Currently: gallery and calendar. Instagram is still not started; add it
 * here once its adapter lands.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function run(label, modulePath) {
  console.log(`\n=== ${label} ===`);
  // pathToFileURL, not the bare path: ESM import() accepts only file:, data:
  // and node: URLs, and a Windows absolute path parses as scheme "d:". On
  // POSIX a bare path happens to work, which is why this ran fine everywhere
  // except the machine the display is actually published from.
  await import(pathToFileURL(modulePath).href);
}

async function main() {
  await run("gallery", path.join(ROOT, "sources", "gallery", "index.mjs"));
  await run("calendar", path.join(ROOT, "sources", "calendar", "index.mjs"));
  console.log("\n[sync-sources] done. Review the diff in content/generated/ before publishing.");
}

main().catch((err) => {
  console.error("[sync-sources] unexpected failure:", err);
  process.exitCode = 1;
});
