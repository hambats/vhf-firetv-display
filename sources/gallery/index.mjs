#!/usr/bin/env node
/*
 * VHF Website Gallery adapter (Phase 5, gallery-first per CLAUDE.md).
 * PC-side only — the Fire TV never talks to this. Run via
 * `node sources/gallery/index.mjs` (or scripts/sync-sources.mjs), which
 * writes content/generated/gallery.json. That file is the only thing scene
 * code (web/) ever reads; it never fetches the gallery site directly.
 *
 * What it does:
 *   1. Fetches each yearly gallery page's HTML (public, no auth).
 *   2. Extracts every Squarespace CDN image URL, skipping the site logo.
 *   3. For each one, reads just enough bytes (an HTTP Range request) to
 *      parse its real pixel dimensions from the WebP header, and drops
 *      anything below a minimum size — Squarespace serves some
 *      social-media re-posts only as small (~206x206) thumbnails
 *      regardless of the requested `?format=`, and those look bad
 *      stretched to fill a 1920x1080 photo scene.
 *   4. Drops anything listed in content/gallery-exclude.json (hand-maintained —
 *      a photo that needs context an unattended TV can't provide, spotted in
 *      rotation, gets its id added there and is excluded on every future run).
 *   5. Picks which survivors make the MAX_PHOTOS pool via weighted random
 *      sampling that heavily favors more recent photos (see RECENCY_DECAY),
 *      so re-running this after new gallery photos go up mostly replaces
 *      older ones rather than diluting them 1-in-N forever.
 *   6. Writes the result to content/generated/gallery.json.
 *
 * This only parses the WebP VP8X container (the format Squarespace's image
 * service outputs once a `?format=` transform is requested, which is the
 * common case here). A URL that isn't VP8X-framed is skipped rather than
 * guessed at — safer to under-include than to ship a broken/unsized photo.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const OUTPUT_PATH = path.join(ROOT, "content", "generated", "gallery.json");
const EXCLUDE_PATH = path.join(ROOT, "content", "gallery-exclude.json");
const SETTINGS_PATH = path.join(ROOT, "content", "settings.json");

const GALLERY_PAGES = [
  "https://www.veteranshealingfarm.org/gallery-2026",
  "https://www.veteranshealingfarm.org/gallery-2025",
  "https://www.veteranshealingfarm.org/gallery-2024-present"
];

const CONCURRENCY = 16;
const IMAGE_URL_RE = /src="(https:\/\/images\.squarespace-cdn\.com\/[^"]+)"/g;

// Defaults — overridden by content/settings.json's "gallery" object if
// present (that's what the admin tool's Gallery Weights panel edits).
const DEFAULT_MIN_DIMENSION = 1200; // px, on the longer side
const DEFAULT_MAX_PHOTOS = 120; // cap the pool; plenty for rotation, keeps sync fast
// Rank 0 (most recent) gets weight 1; rank N gets weight exp(-N / RECENCY_DECAY).
// Smaller = more heavily skewed toward the newest photos. At 35, a photo
// ranked ~100 back is already >30x less likely to be picked than the newest.
const DEFAULT_RECENCY_DECAY = 35;

async function loadGallerySettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const doc = JSON.parse(raw);
    const g = doc.gallery || {};
    return {
      minDimension: typeof g.minDimension === "number" ? g.minDimension : DEFAULT_MIN_DIMENSION,
      maxPhotos: typeof g.maxPhotos === "number" ? g.maxPhotos : DEFAULT_MAX_PHOTOS,
      recencyDecay: typeof g.recencyDecay === "number" ? g.recencyDecay : DEFAULT_RECENCY_DECAY
    };
  } catch {
    return { minDimension: DEFAULT_MIN_DIMENSION, maxPhotos: DEFAULT_MAX_PHOTOS, recencyDecay: DEFAULT_RECENCY_DECAY };
  }
}

// Filenames like 20260506_110209.jpg (phone camera default naming) carry a
// real timestamp. Anything else (Facebook/Instagram numeric ids, IMG_1234,
// arbitrary names) has no reliable date, so it falls back to a coarse
// per-gallery-year timestamp — still enough to keep this year's photos
// ranked ahead of last year's even without a parseable exact date.
const GALLERY_YEAR_FALLBACK = {
  "https://www.veteranshealingfarm.org/gallery-2026": "2026-01-01T00:00:00Z",
  "https://www.veteranshealingfarm.org/gallery-2025": "2025-01-01T00:00:00Z",
  "https://www.veteranshealingfarm.org/gallery-2024-present": "2024-01-01T00:00:00Z"
};

function parseDateFromFilename(url) {
  const filename = url.split("/").pop() || "";
  const m = filename.match(/(20\d{2})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return isNaN(date.getTime()) ? null : date;
}

function weightedSampleWithoutReplacement(itemsWithWeights, n) {
  // Efraimidis-Spirakis: give each item a random key raised to 1/weight, take
  // the top N by key. Higher weight -> key stays closer to 1 -> more likely
  // to win, without the O(n^2) cost of repeatedly re-rolling a weighted pick.
  const keyed = itemsWithWeights.map(({ item, weight }) => ({
    item,
    key: Math.pow(Math.random(), 1 / Math.max(weight, 1e-9))
  }));
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, n).map((k) => k.item);
}

async function extractImageUrls(pageUrl) {
  const res = await fetch(pageUrl);
  if (!res.ok) throw new Error(`${pageUrl} -> HTTP ${res.status}`);
  const html = await res.text();
  const found = new Set();
  for (const match of html.matchAll(IMAGE_URL_RE)) {
    const url = match[1].split("?")[0];
    if (/logo/i.test(url)) continue;
    found.add(url);
  }
  return [...found];
}

async function readWebpDimensions(url) {
  const res = await fetch(url + "?format=2500w", {
    headers: { Range: "bytes=0-31" }
  });
  if (!res.ok && res.status !== 206) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
  if (buf.toString("ascii", 12, 16) !== "VP8X") return null; // see file header note
  const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
  const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
  return { width, height };
}

function idFromUrl(url) {
  // Previously truncated to 60 chars, which let two different photos (or the
  // same photo after a Squarespace filename change past position 60) collide
  // on their id — a gallery-exclude.json entry could then stop matching the
  // photo it was meant to suppress, or start matching the wrong one. The id
  // is still derived from the URL's filename segment (Squarespace filenames
  // are the meaningful unique part; the rest of the URL is a shared CDN path
  // prefix), but it is no longer truncated, so it stays a full-fidelity,
  // collision-resistant key for as long as the filename is.
  const segment = url.split("/").filter(Boolean).pop() || "photo";
  return segment
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

async function loadExcludedIds() {
  try {
    const raw = await fs.readFile(EXCLUDE_PATH, "utf8");
    const doc = JSON.parse(raw);
    return new Set((doc.excluded || []).map((e) => e.id));
  } catch (err) {
    if (err.code === "ENOENT") return new Set();
    throw err;
  }
}

async function main() {
  const settings = await loadGallerySettings();
  console.log(`[gallery] settings: minDimension=${settings.minDimension} maxPhotos=${settings.maxPhotos} recencyDecay=${settings.recencyDecay}`);

  const excludedIds = await loadExcludedIds();
  if (excludedIds.size > 0) {
    console.log(`[gallery] ${excludedIds.size} id(s) excluded via content/gallery-exclude.json`);
  }

  const allUrls = new Map(); // url -> sourcePage

  for (const page of GALLERY_PAGES) {
    console.log(`[gallery] fetching ${page}`);
    let urls;
    try {
      urls = await extractImageUrls(page);
    } catch (err) {
      console.error(`[gallery] failed to read ${page}: ${err.message}`);
      continue;
    }
    for (const url of urls) {
      if (!allUrls.has(url)) allUrls.set(url, page);
    }
  }

  console.log(`[gallery] found ${allUrls.size} candidate images, checking dimensions (concurrency ${CONCURRENCY})...`);

  const entries = [...allUrls.entries()];
  const photos = [];
  let nextIndex = 0;
  let checked = 0;

  async function worker() {
    while (nextIndex < entries.length) {
      const i = nextIndex++;
      const [url, sourcePage] = entries[i];
      let dims = null;
      try {
        dims = await readWebpDimensions(url);
      } catch {
        // Treat a failed size check the same as "too small" — skip it.
      }
      checked++;
      if (checked % 50 === 0) console.log(`[gallery]   checked ${checked}/${entries.length}`);
      if (!dims || Math.max(dims.width, dims.height) < settings.minDimension) continue;
      const id = idFromUrl(url);
      if (excludedIds.has(id)) continue;
      if (/screenshot/i.test(id)) continue;
      // A meaningfully-taller-than-4:5 frame (e.g. a phone screenshot) reads
      // wrong in a 16:9 photo grid designed around landscape/portrait photos.
      if (dims.width / dims.height < 0.7) continue;
      const filenameDate = parseDateFromFilename(url);
      const takenAt = filenameDate ? filenameDate.toISOString() : GALLERY_YEAR_FALLBACK[sourcePage] || null;
      photos.push({
        id: id,
        src: url + "?format=2500w",
        width: dims.width,
        height: dims.height,
        sourcePage,
        takenAt,
        dateSource: filenameDate ? "filename" : "gallery-page-fallback"
      });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Most recent first (missing dates sort last), then weighted-sample the
  // pool so recent photos dominate without making it 100% deterministic.
  photos.sort((a, b) => new Date(b.takenAt || 0).getTime() - new Date(a.takenAt || 0).getTime());
  const weighted = photos.map((item, rank) => ({ item, weight: Math.exp(-rank / settings.recencyDecay) }));
  const kept = weightedSampleWithoutReplacement(weighted, settings.maxPhotos).sort(
    (a, b) => new Date(b.takenAt || 0).getTime() - new Date(a.takenAt || 0).getTime()
  );

  console.log(`[gallery] kept ${kept.length} of ${photos.length} qualifying photos (>= ${settings.minDimension}px on the long side, capped at ${settings.maxPhotos}, recency-weighted)`);

  const output = {
    version: 1,
    source: "vhf-gallery-scrape",
    generatedAt: new Date().toISOString(),
    photos: kept
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`[gallery] wrote ${path.relative(ROOT, OUTPUT_PATH)}`);
}

main().catch((err) => {
  console.error("[gallery] unexpected failure:", err);
  process.exitCode = 1;
});
