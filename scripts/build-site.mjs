#!/usr/bin/env node
/*
 * Builds the publish site: validates every content/ JSON file, then copies
 * web/ (viewer + scene engine) and the *publishable subset* of content/ into
 * dist/ so the same relative paths (content/playlist.json,
 * content/generated/events.json, ...) work both in local preview and once
 * deployed.
 *
 * Only what the viewer actually fetches is published — see PUBLISHED_CONTENT.
 * The curation files (gallery-exclude.json, events-exclude.json) are
 * PC-side-only working notes: the display reads neither, and their free-text
 * `reason` fields record why each photo was pulled from rotation. They have no
 * business on a public URL.
 *
 * Never publishes a partially-invalid content set: if any JSON file fails to
 * parse, the build fails and dist/ is left untouched (whatever was
 * previously deployed stays live).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateContentDir } from "./validate-content.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/*
 * VHF_BUILD_ROOT lets the test suite point the build at a fixture tree instead
 * of the repo, so "a bad content file never reaches dist/" can be asserted
 * without corrupting the real content/ to prove it.
 */
const ROOT = process.env.VHF_BUILD_ROOT
  ? path.resolve(process.env.VHF_BUILD_ROOT)
  : path.resolve(__dirname, "..");
const WEB_DIR = path.join(ROOT, "web");
const CONTENT_DIR = path.join(ROOT, "content");
const DIST_DIR = path.join(ROOT, "dist");

/*
 * Everything under content/ that the viewer fetches, and nothing else. Each
 * entry is a path relative to content/; a directory is copied whole. Grep
 * web/js for "content/" before changing this list — a file the engine loads
 * but this list omits is a display that works locally and breaks deployed.
 */
export const PUBLISHED_CONTENT = [
  "playlist.json",
  "settings.json",
  "announcements",
  "generated/events.json",
  "generated/gallery.json",
  "generated/curated-photos.json",
  "artwork/brand",
  "artwork/curated"
];

async function copyPublishedContent(src, dest) {
  for (const rel of PUBLISHED_CONTENT) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    let stat;
    try {
      stat = await fs.stat(from);
    } catch {
      throw new Error(
        `PUBLISHED_CONTENT lists content/${rel}, which does not exist. ` +
          "Either the file was removed or the list is stale."
      );
    }
    if (stat.isDirectory()) {
      await copyDir(from, to);
    } else {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
    }
  }

  const skipped = await unpublishedUnder(src, "");
  if (skipped.length > 0) {
    console.log("[build-site] not published (PC-side only): " + skipped.join(", "));
  }
}

/*
 * Names what the build deliberately left behind, at the shallowest useful
 * level: a wholly-unpublished directory is reported as itself, a partially
 * published one is opened up so "artwork/candidates" is named rather than
 * hidden inside an "artwork" that looks published.
 */
async function unpublishedUnder(dir, prefix) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name === ".gitkeep") continue;
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (PUBLISHED_CONTENT.includes(rel)) continue;
    const isAncestor = PUBLISHED_CONTENT.some((p) => p.startsWith(rel + "/"));
    if (isAncestor && entry.isDirectory()) {
      out.push(...(await unpublishedUnder(path.join(dir, entry.name), rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/*
 * Rewrites the two stamped lines in dist/sw.js.
 *
 * BUILD names the shell cache, so a publish invalidates the previous build's
 * HTML/CSS/JS rather than serving it forever — a cache-first Service Worker
 * with a fixed cache name is a display that can never be updated again.
 *
 * SHELL is generated rather than hand-listed for the same reason
 * PUBLISHED_CONTENT is checked by a test: a precache list maintained by hand
 * goes stale silently, and the symptom appears weeks later as a display that
 * boots offline into a page missing its stylesheet.
 */
async function stampServiceWorker(distDir, buildVersion) {
  const swPath = path.join(distDir, "sw.js");
  let source;
  try {
    source = await fs.readFile(swPath, "utf8");
  } catch {
    console.log("[build-site] no sw.js to stamp");
    return;
  }

  const shell = ["./", ...(await shellFiles(distDir, ""))];
  const stamped = source
    .replace(/^var BUILD = .*$/m, `var BUILD = ${JSON.stringify(String(buildVersion))};`)
    .replace(/^var SHELL = .*$/m, `var SHELL = ${JSON.stringify(shell)};`);

  if (stamped === source) {
    throw new Error("sw.js has no BUILD/SHELL lines to stamp — did its header change?");
  }
  await fs.writeFile(swPath, stamped);
  console.log(`[build-site] stamped sw.js: build ${buildVersion}, ${shell.length} shell files`);
}

/*
 * The app shell: everything the page needs to boot, and nothing that only
 * matters once it has. Content JSON is excluded because content-source.js
 * owns it; photos and artwork are excluded because they are cached on demand
 * at their real cost rather than all 22MB of them at install.
 */
async function shellFiles(distDir, prefix) {
  const skip = new Set(["content", "sw.js"]);
  const entries = await fs.readdir(path.join(distDir, prefix), { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const rel = prefix ? prefix + "/" + entry.name : entry.name;
    if (skip.has(rel)) continue;
    if (entry.isDirectory()) out.push(...(await shellFiles(distDir, rel)));
    else out.push(rel);
  }
  return out;
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".gitkeep") continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function main() {
  console.log("[build-site] validating content/ against docs/CONTENT_SCHEMA.md...");
  const errors = await validateContentDir(CONTENT_DIR);
  if (errors.length > 0) {
    console.error("[build-site] content validation failed:");
    for (const e of errors) console.error("  - " + e);
    process.exitCode = 1;
    return;
  }
  console.log("[build-site] content OK");

  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(DIST_DIR, { recursive: true });

  console.log("[build-site] copying web/ -> dist/");
  await copyDir(WEB_DIR, DIST_DIR);

  console.log("[build-site] copying published content/ -> dist/content/");
  await copyPublishedContent(CONTENT_DIR, path.join(DIST_DIR, "content"));

  const version = {
    version: Date.now(),
    builtAt: new Date().toISOString()
  };

  await stampServiceWorker(DIST_DIR, version.version);
  await fs.writeFile(
    path.join(DIST_DIR, "content", "version.json"),
    JSON.stringify(version, null, 2) + "\n"
  );

  console.log("[build-site] done -> dist/");
}

/* Importable for its PUBLISHED_CONTENT list; only builds when run directly. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[build-site] unexpected failure:", err);
    process.exitCode = 1;
  });
}
