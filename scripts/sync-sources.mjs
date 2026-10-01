#!/usr/bin/env node
/*
 * Runs every content source adapter, build-side only. Each adapter writes only
 * to content/generated/ (and the Drive feed to content/artwork/drive/) — this
 * script never touches anything a human hand-edits (playlist.json,
 * settings.json, announcements.json, content/artwork/curated/).
 *
 * Order matters for the first two: the Drive feed has to land before
 * curated-photos folds it into the photo sets, and before the calendar reads
 * its class folders as extra program keywords. Gallery and calendar are
 * independent of each other.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function moduleUrl(...parts) {
  // pathToFileURL, not the bare path: ESM import() accepts only file:, data:
  // and node: URLs, and a Windows absolute path parses as scheme "d:". On
  // POSIX a bare path happens to work, which is why this ran fine everywhere
  // except the machine the display is actually published from.
  return pathToFileURL(path.join(ROOT, ...parts)).href;
}

async function run(label, modulePath) {
  console.log(`\n=== ${label} ===`);
  await import(moduleUrl(modulePath));
}

async function main() {
  console.log("\n=== drive ===");
  /*
   * A Drive failure (sharing changed, key revoked, Google down) must not hold
   * back the calendar: an out-of-date events list is worse than a week without
   * new class photos. So it is caught here, the last good Drive content stays
   * in place, and the failure is recorded in a marker the CI workflow checks
   * *after* publishing -- the run still ends red, it just does not take the
   * calendar down with it.
   */
  const marker = path.join(ROOT, ".cache", "drive-sync-failed");
  await fs.rm(marker, { force: true });
  try {
    const { syncDrive } = await import(moduleUrl("sources", "drive", "index.mjs"));
    await syncDrive();
  } catch (err) {
    const message = String((err && err.message) || err);
    console.error(`[drive] FAILED -- keeping the last good Drive content: ${message}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Google Drive sync failed::${message.replace(/\r?\n/g, " ")}`);
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, message + "\n");
  }

  console.log("\n=== curated-photos ===");
  const { buildCuratedPhotos } = await import(moduleUrl("sources", "curated-photos", "index.mjs"));
  await buildCuratedPhotos();

  await run("gallery", path.join("sources", "gallery", "index.mjs"));
  await run("calendar", path.join("sources", "calendar", "index.mjs"));
  console.log("\n[sync-sources] done. Review the diff in content/generated/ before publishing.");
}

main().catch((err) => {
  console.error("[sync-sources] unexpected failure:", err);
  process.exitCode = 1;
});
