#!/usr/bin/env node
/*
 * Builds the Netlify publish site: validates every content/ JSON file, then
 * copies web/ (viewer + scene engine) and content/ into dist/ so the same
 * relative paths (content/playlist.json, content/generated/events.json, ...)
 * work both in local preview and once deployed.
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
const ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(ROOT, "web");
const CONTENT_DIR = path.join(ROOT, "content");
const DIST_DIR = path.join(ROOT, "dist");

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

  console.log("[build-site] copying content/ -> dist/content/");
  await copyDir(CONTENT_DIR, path.join(DIST_DIR, "content"));

  const version = {
    version: Date.now(),
    builtAt: new Date().toISOString()
  };
  await fs.writeFile(
    path.join(DIST_DIR, "content", "version.json"),
    JSON.stringify(version, null, 2) + "\n"
  );

  console.log("[build-site] done -> dist/");
}

main().catch((err) => {
  console.error("[build-site] unexpected failure:", err);
  process.exitCode = 1;
});
