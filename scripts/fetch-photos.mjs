#!/usr/bin/env node
/*
 * PC-side photo mirror. Run after sources/gallery/index.mjs (sync-sources
 * does both), before build. Downloads every photo in the pool once, resizes
 * it to what the display can actually show, writes it into content/photos/,
 * and rewrites each entry's `src` to that local path.
 *
 * Why this exists, given that sw.js caches photos on the device anyway:
 *
 *   1. Same-origin. A cross-origin image caches as an *opaque* response —
 *      a failure can't be told from a success and it's charged against the
 *      quota at a padded size. Mirrored photos are same-origin and ordinary.
 *   2. Cold start. The first run after a cache eviction no longer depends on
 *      the Squarespace CDN being reachable at render time.
 *   3. Dead URLs surface here, on the PC, at build time — not as a skipped
 *      scene on the wall that nobody is watching.
 *   4. Bytes. See the sizing note below.
 *
 * Sizing. The obvious target is the 1920x1080 panel, but photos are drawn
 * with `object-fit: cover` and then Ken Burns-zoomed to scale(1.12), so a
 * full-bleed photo needs 1920*1.12 = 2150 real pixels across to stay sharp at
 * peak zoom. That — not 1920 — is the honest floor. Squarespace serves a
 * fixed size ladder (2500w, then 1500w; 1920w and 2000w silently return the
 * 2500w original), so the CDN cannot produce this size and 1500w would be an
 * upscale. Resizing here is the only way to get it exactly right.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const GALLERY_PATH = path.join(ROOT, "content", "generated", "gallery.json");
const SETTINGS_PATH = path.join(ROOT, "content", "settings.json");
const PHOTO_DIR = path.join(ROOT, "content", "photos");
const PUBLIC_PREFIX = "/content/photos";

const DEFAULTS = {
  frameWidth: 1920,
  frameHeight: 1080,
  maxZoom: 1.12,   // must match the Ken Burns keyframes in web/css/scene.css
  quality: 80,
  maxFailureRatio: 0.1
};

const CONCURRENCY = 6;

async function loadMirrorSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const m = (JSON.parse(raw).gallery || {}).mirror || {};
    return {
      frameWidth: m.frameWidth || DEFAULTS.frameWidth,
      frameHeight: m.frameHeight || DEFAULTS.frameHeight,
      maxZoom: m.maxZoom || DEFAULTS.maxZoom,
      quality: m.quality || DEFAULTS.quality,
      maxFailureRatio: m.maxFailureRatio ?? DEFAULTS.maxFailureRatio
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// The scale at which this photo exactly covers the zoomed frame. Below 1 the
// source has pixels to spare and we shrink; at or above 1 it is already at or
// under what the display wants, so we re-encode without resizing rather than
// upscaling into a bigger file that shows nothing more.
function targetSize(width, height, cfg) {
  const cover = Math.max(cfg.frameWidth / width, cfg.frameHeight / height);
  const scale = cover * cfg.maxZoom;
  if (!(scale < 1)) return null;
  return {
    width: Math.ceil(width * scale),
    height: Math.ceil(height * scale)
  };
}

async function mirrorOne(photo, cfg, force) {
  const remote = photo.remoteSrc || photo.src;
  const file = `${photo.id}.webp`;
  const absolute = path.join(PHOTO_DIR, file);

  if (!force) {
    try {
      const stat = await fs.stat(absolute);
      if (stat.size > 0) {
        const meta = await sharp(absolute).metadata();
        return { photo, file, bytes: stat.size, width: meta.width, height: meta.height, skipped: true };
      }
    } catch {
      // Not mirrored yet — fall through and fetch it.
    }
  }

  const res = await fetch(remote);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const source = Buffer.from(await res.arrayBuffer());

  const image = sharp(source);
  const meta = await image.metadata();
  const size = targetSize(meta.width, meta.height, cfg);
  const pipeline = size ? image.resize(size.width, size.height) : image;
  const output = await pipeline.webp({ quality: cfg.quality }).toBuffer();

  await fs.writeFile(absolute, output);
  return {
    photo,
    file,
    bytes: output.length,
    sourceBytes: source.length,
    width: size ? size.width : meta.width,
    height: size ? size.height : meta.height
  };
}

async function main() {
  const force = process.argv.includes("--force");
  const cfg = await loadMirrorSettings();

  const doc = JSON.parse(await fs.readFile(GALLERY_PATH, "utf8"));
  const photos = doc.photos || [];
  if (photos.length === 0) {
    console.error("[photos] gallery.json has no photos — run sources/gallery/index.mjs first");
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(PHOTO_DIR, { recursive: true });
  console.log(`[photos] mirroring ${photos.length} photos -> ${path.relative(ROOT, PHOTO_DIR)}`);

  const queue = photos.slice();
  const mirrored = [];
  const failed = [];
  let downloaded = 0;
  let skipped = 0;
  let savedBytes = 0;

  async function worker() {
    while (queue.length > 0) {
      const photo = queue.shift();
      try {
        const result = await mirrorOne(photo, cfg, force);
        mirrored.push(result);
        if (result.skipped) {
          skipped++;
        } else {
          downloaded++;
          savedBytes += result.sourceBytes - result.bytes;
          if (downloaded % 20 === 0) console.log(`[photos]   fetched ${downloaded}`);
        }
      } catch (err) {
        // A dead gallery URL is the whole point of catching this here rather
        // than on the wall: name it, drop it from the pool, keep going.
        failed.push({ id: photo.id, reason: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  for (const { id, reason } of failed) {
    console.warn(`[photos] DEAD  ${id}: ${reason}`);
  }

  const ratio = failed.length / photos.length;
  if (ratio > cfg.maxFailureRatio) {
    console.error(
      `[photos] ${failed.length}/${photos.length} photos failed (over the ${Math.round(cfg.maxFailureRatio * 100)}% ceiling) — ` +
      "leaving gallery.json untouched; this looks like a network or gallery-wide problem, not dead photos"
    );
    process.exitCode = 1;
    return;
  }

  doc.photos = mirrored.map(({ photo, file, width, height }) => ({
    ...photo,
    src: `${PUBLIC_PREFIX}/${file}`,
    remoteSrc: photo.remoteSrc || photo.src,
    width,
    height
  }));
  doc.mirroredAt = new Date().toISOString();
  await fs.writeFile(GALLERY_PATH, JSON.stringify(doc, null, 2) + "\n", "utf8");

  // Anything left in content/photos/ that is no longer in the pool is dead
  // weight in the repo and in dist/ — a resampled pool drops photos every run.
  const keep = new Set(mirrored.map((m) => m.file));
  let pruned = 0;
  for (const name of await fs.readdir(PHOTO_DIR)) {
    if (name.endsWith(".webp") && !keep.has(name)) {
      await fs.unlink(path.join(PHOTO_DIR, name));
      pruned++;
    }
  }

  const totalBytes = mirrored.reduce((sum, m) => sum + m.bytes, 0);
  console.log(
    `[photos] ${mirrored.length} in pool (${downloaded} fetched, ${skipped} already mirrored, ` +
    `${failed.length} dead, ${pruned} pruned) — ${(totalBytes / 1048576).toFixed(1)}MB on disk` +
    (downloaded > 0 ? `, saved ${(savedBytes / 1048576).toFixed(1)}MB on what was fetched` : "")
  );
}

main().catch((err) => {
  console.error(`[photos] ${err.message}`);
  process.exitCode = 1;
});
