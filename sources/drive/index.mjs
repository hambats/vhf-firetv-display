#!/usr/bin/env node
/*
 * Pulls photos and flyers from a shared Google Drive folder into the display.
 * Build-side only, like sources/gallery and sources/calendar: the television
 * never talks to Google, it only ever reads what this writes into the repo.
 *
 * The folder is an ordinary Drive share ("anyone with the link can view") that
 * VHF's social media lead fills in, so new class photos stop depending on
 * someone editing content/artwork/curated/ by hand. Layout, matched by name and
 * case-insensitively:
 *
 *   <shared folder>/
 *     Classes/
 *       Pottery/            -> curated set "program-pottery", merged with the
 *       Wreath Making/         hand-curated one; also matches calendar events
 *       ...                    whose title contains the folder name
 *     Flyers/               -> set "drive-flyers": designed graphics shown whole,
 *                              each until the date in its filename, or for
 *                              FLYER_DEFAULT_DAYS after it was added
 *     Farm Photos/          -> folded into the general photo rotation
 *                              ("gen-pop-additions")
 *
 * Every image is fetched through Drive's own thumbnail renderer at TV size
 * rather than as the original file. That one choice does four jobs without an
 * image library: iPhone HEIC comes back as JPEG, EXIF rotation is applied,
 * a 12 MB phone original comes back as a few hundred KB, and the re-encoded
 * file carries no EXIF at all, so a phone's GPS location never reaches the
 * public site.
 *
 * Drive is the source of truth for what it contributes: a photo deleted there
 * leaves the display on the next sync. Nothing outside content/artwork/drive/
 * and content/generated/drive.json is ever written or removed.
 *
 * Configuration comes from the environment, never from content/: settings.json
 * is published, and the folder id is the folder's share link.
 *   DRIVE_FOLDER_ID  the shared folder's id (the part after /folders/ in its link)
 *   DRIVE_API_KEY    a Google Cloud API key with the Drive API enabled
 * With either missing this adapter skips and changes nothing.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { imageSizeFromBuffer } from "../curated-photos/image-size.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DRIVE_DIR = path.join(ROOT, "content", "artwork", "drive");
const MANIFEST_PATH = path.join(ROOT, "content", "generated", "drive.json");

const API = "https://www.googleapis.com/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

// Longest edge, in pixels, of what is fetched. The panel is 1920 wide; a
// portrait photo is contained at 1080 tall, so 1920 covers both shapes.
const FETCH_LONG_EDGE = 1920;
// Below this the photo visibly softens on a 43" panel. Social graphics are
// typically 1080 square, which is why this is not the gallery's 1200.
const MIN_LONG_EDGE = 1000;
const FLYER_DEFAULT_DAYS = 30;
const CAPTION_MAX = 140;

export const SECTIONS = {
  classes: { match: ["classes", "class", "classphotos", "programs"] },
  flyers: { match: ["flyers", "flyer", "graphics", "posters"], setId: "drive-flyers", dir: "flyers" },
  farm: { match: ["farmphotos", "farm", "general", "generalphotos"], setId: "gen-pop-additions", dir: "farm-photos" }
};

function normalize(name) {
  return String(name || "").toLowerCase().replace(/[^a-z]/g, "");
}

export function sectionFor(folderName) {
  const n = normalize(folderName);
  for (const [key, def] of Object.entries(SECTIONS)) {
    if (def.match.includes(n)) return key;
  }
  return null;
}

export function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// "Pottery" -> program-pottery, the id the hand-curated folder, the calendar's
// keyword table and the playlist's information slides already use, so a Drive
// folder for an existing program joins that program instead of forking it.
export function classSetId(folderName) {
  const slug = slugify(folderName);
  return slug ? `program-${slug}` : null;
}

// The words a person adds to a folder name that never appear in the calendar
// title: "Pottery Classes" should still match "Pottery with Sophia".
const NOISE_WORDS = new Set(["class", "classes", "workshop", "workshops", "photos", "photo", "pics", "pictures", "series"]);

export function classKeyword(folderName) {
  return String(folderName || "")
    .toLowerCase()
    .replace(/[’]/g, "'")
    .split(/\s+/)
    .filter((w) => w && !NOISE_WORDS.has(w))
    .join(" ")
    .trim();
}

/*
 * When a flyer stops showing. A date in the filename wins, because a flyer is
 * almost always for one dated thing and Maddie knows the date when she saves
 * it: "2026-11-21 wreath.png", "wreath 11-21.png" and "Wreath 11.21.png" all
 * run through November 21. Without one it shows for FLYER_DEFAULT_DAYS after
 * it was added, so a forgotten flyer retires itself instead of advertising a
 * past class forever.
 *
 * Returned as an ISO instant just after midnight Eastern on the day after, in
 * UTC (04:00Z is midnight EDT, 23:00 the previous evening in EST) -- the farm
 * is closed at either hour, so the hour of drift across DST costs nothing.
 */
export function flyerExpiry(fileName, createdTime, now = new Date()) {
  const base = String(fileName || "").replace(/\.[a-z0-9]+$/i, "");
  const created = createdTime ? new Date(createdTime) : now;

  let y, m, d;
  const iso = base.match(/(20\d{2})[-_. ](\d{1,2})[-_. ](\d{1,2})/);
  const short = base.match(/(?:^|[^\d])(\d{1,2})[-_.](\d{1,2})(?:[-_.](\d{2,4}))?(?!\d)/);
  if (iso) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else if (short) {
    m = Number(short[1]);
    d = Number(short[2]);
    if (short[3]) {
      y = Number(short[3].length === 2 ? "20" + short[3] : short[3]);
    } else {
      // No year: the next such date on or after the day it was added.
      y = created.getUTCFullYear();
      if (Date.UTC(y, m - 1, d) < Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate())) y += 1;
    }
  }
  if (y && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
    return new Date(Date.UTC(y, m - 1, d + 1, 4, 0, 0)).toISOString();
  }
  return new Date(created.getTime() + FLYER_DEFAULT_DAYS * 86400000).toISOString();
}

function captionFrom(description) {
  const text = String(description || "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > CAPTION_MAX ? text.slice(0, CAPTION_MAX - 1).trimEnd() + "…" : text;
}

/*
 * Turns the walked folder tree into what should be on the display. Pure, so
 * the rules -- which folder means what, what gets skipped and why -- are
 * tested without a network.
 *
 * tree: [{ name, mimeType, children? , ...drive file fields }] for the root.
 * Returns { sets: { [setId]: { section, folder, dir, keyword?, files: [...] } },
 *           skipped: [{ path, reason }] }
 */
export function planFromTree(tree, now = new Date()) {
  const sets = {};
  const skipped = [];

  function addSet(setId, section, folder, dir, keyword) {
    if (!sets[setId]) sets[setId] = { section, folder, dir, files: [] };
    if (keyword) sets[setId].keyword = keyword;
    return sets[setId];
  }

  // Everything under a folder, however deep: a "Pottery/October" subfolder is
  // still pottery.
  function collect(node, trail, out) {
    for (const child of node.children || []) {
      const where = trail.concat(child.name).join("/");
      if (child.mimeType === FOLDER_MIME) collect(child, trail.concat(child.name), out);
      else if (IMAGE_MIMES.has(child.mimeType)) out.push({ file: child, where });
      else skipped.push({ path: where, reason: child.mimeType.startsWith("video/") ? "video (not shown on the display yet)" : "not a photo" });
    }
  }

  function accept(set, { file, where }, kind) {
    const w = Number(file.imageMediaMetadata?.width) || 0;
    const h = Number(file.imageMediaMetadata?.height) || 0;
    if (w && h && Math.max(w, h) < MIN_LONG_EDGE) {
      skipped.push({ path: where, reason: `too small for the TV (${w}x${h}, needs ${MIN_LONG_EDGE}px on the long side)` });
      return;
    }
    const entry = {
      driveId: file.id,
      name: file.name,
      modifiedTime: file.modifiedTime,
      thumbnailLink: file.thumbnailLink
    };
    const caption = captionFrom(file.description);
    if (caption) entry.caption = caption;
    if (kind === "flyers") {
      entry.expires = flyerExpiry(file.name, file.createdTime, now);
      if (new Date(entry.expires).getTime() <= now.getTime()) {
        skipped.push({ path: where, reason: `flyer expired ${entry.expires.slice(0, 10)}` });
        return;
      }
    }
    set.files.push(entry);
  }

  for (const top of tree) {
    if (top.mimeType !== FOLDER_MIME) {
      skipped.push({ path: top.name, reason: "loose file at the top level -- put it in Classes, Flyers or Farm Photos" });
      continue;
    }
    const section = sectionFor(top.name);
    if (!section) {
      skipped.push({ path: top.name, reason: "unrecognised folder -- expected Classes, Flyers or Farm Photos" });
      continue;
    }

    if (section === "classes") {
      for (const cls of top.children || []) {
        const where = `${top.name}/${cls.name}`;
        if (cls.mimeType !== FOLDER_MIME) {
          skipped.push({ path: where, reason: "loose file in Classes -- put it in a folder named for the class" });
          continue;
        }
        const setId = classSetId(cls.name);
        if (!setId) {
          skipped.push({ path: where, reason: "folder name has no letters or numbers to match a class by" });
          continue;
        }
        const set = addSet(setId, "classes", cls.name, setId, classKeyword(cls.name));
        const found = [];
        collect(cls, [top.name, cls.name], found);
        for (const f of found) accept(set, f, "classes");
      }
    } else {
      const def = SECTIONS[section];
      const set = addSet(def.setId, section, top.name, def.dir);
      const found = [];
      collect(top, [top.name], found);
      for (const f of found) accept(set, f, section);
    }
  }

  for (const set of Object.values(sets)) {
    set.files.sort((a, b) => a.name.localeCompare(b.name) || a.driveId.localeCompare(b.driveId));
  }
  return { sets, skipped };
}

function sniffExtension(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  if (buf.length > 8 && buf.toString("ascii", 1, 4) === "PNG") return ".png";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
  return null;
}

// Drive's thumbnailLink ends in a size suffix ("=s220"); asking for a bigger
// one returns the same image rendered at that size, never upscaled.
export function sizedThumbnail(entry) {
  if (entry.thumbnailLink && /=s\d+$/.test(entry.thumbnailLink)) {
    return entry.thumbnailLink.replace(/=s\d+$/, `=s${FETCH_LONG_EDGE}`);
  }
  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(entry.driveId)}&sz=s${FETCH_LONG_EDGE}`;
}

async function fetchWithRetry(url, what) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (res.ok) return res;
      // 4xx other than rate limiting will not get better by asking again.
      const body = (await res.text()).slice(0, 300);
      lastErr = new Error(`${what}: HTTP ${res.status} ${body}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  throw lastErr;
}

async function listChildren(folderId, key) {
  const files = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,createdTime,modifiedTime,description,thumbnailLink,imageMediaMetadata(width,height))",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      key
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetchWithRetry(`${API}?${params}`, `listing Drive folder ${folderId}`);
    const json = await res.json();
    files.push(...(json.files || []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return files;
}

async function walk(folderId, key, depth = 0) {
  const children = await listChildren(folderId, key);
  for (const c of children) {
    if (c.mimeType === FOLDER_MIME && depth < 4) c.children = await walk(c.id, key, depth + 1);
  }
  return children;
}

async function readManifest() {
  try {
    return JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listLocalFiles(dir) {
  const out = [];
  async function rec(d) {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      // .gitkeep holds the folder open in git so the build always has it to copy.
      if (e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else out.push(p);
    }
  }
  await rec(dir);
  return out;
}

function summaryLines(prev, next, skipped) {
  const before = new Map();
  for (const [setId, s] of Object.entries(prev?.sets || {})) for (const p of s.photos) before.set(p.driveId, { setId, name: p.name });
  const after = new Map();
  for (const [setId, s] of Object.entries(next.sets)) for (const p of s.photos) after.set(p.driveId, { setId, name: p.name });
  const added = [...after].filter(([id]) => !before.has(id)).map(([, v]) => `${v.setId}: ${v.name}`);
  const removed = [...before].filter(([id]) => !after.has(id)).map(([, v]) => `${v.setId}: ${v.name}`);
  return { added, removed, skipped: skipped.map((s) => `${s.path} -- ${s.reason}`) };
}

export async function syncDrive({ env = process.env, now = new Date() } = {}) {
  const folderId = (env.DRIVE_FOLDER_ID || "").trim();
  const key = (env.DRIVE_API_KEY || "").trim();
  if (!folderId || !key) {
    console.log("[drive] DRIVE_FOLDER_ID / DRIVE_API_KEY not set -- skipping; existing Drive content left as it is.");
    return { skipped: true };
  }

  const prev = await readManifest();
  const tree = await walk(folderId, key);
  const plan = planFromTree(tree, now);

  const total = Object.values(plan.sets).reduce((n, s) => n + s.files.length, 0);
  const prevTotal = Object.values(prev?.sets || {}).reduce((n, s) => n + s.photos.length, 0);
  // An empty answer from a folder that had photos yesterday is far likelier to
  // be a sharing setting changed than an intentional wipe, and acting on it
  // would empty every Drive-fed slide at once. Fail loudly instead.
  if (total === 0 && prevTotal > 0 && env.DRIVE_ALLOW_EMPTY !== "1") {
    throw new Error(
      `Drive folder returned no usable photos, but ${prevTotal} were there last sync. ` +
        "Check the folder is still shared as 'anyone with the link'. Set DRIVE_ALLOW_EMPTY=1 if it really was emptied."
    );
  }

  const prevById = new Map();
  for (const s of Object.values(prev?.sets || {})) for (const p of s.photos) prevById.set(p.driveId, p);

  const sets = {};
  const keep = new Set();
  let downloaded = 0;
  for (const [setId, set] of Object.entries(plan.sets)) {
    const photos = [];
    for (const f of set.files) {
      const old = prevById.get(f.driveId);
      const oldPath = old && path.join(ROOT, old.src.split("/").map(decodeURIComponent).join(path.sep));
      let photo;
      if (old && old.modifiedTime === f.modifiedTime && old.dir === set.dir && (await exists(oldPath))) {
        photo = { ...old };
      } else {
        let buf;
        try {
          const res = await fetchWithRetry(sizedThumbnail(f), `fetching ${f.name}`);
          buf = Buffer.from(await res.arrayBuffer());
        } catch (err) {
          plan.skipped.push({ path: `${set.folder}/${f.name}`, reason: `could not be fetched from Drive (${err.message.slice(0, 120)})` });
          continue;
        }
        const ext = sniffExtension(buf);
        const size = ext && imageSizeFromBuffer(buf);
        if (!ext || !size) {
          plan.skipped.push({ path: `${set.folder}/${f.name}`, reason: "Drive did not return a readable image" });
          continue;
        }
        if (Math.max(size.width, size.height) < MIN_LONG_EDGE) {
          plan.skipped.push({ path: `${set.folder}/${f.name}`, reason: `too small for the TV (${size.width}x${size.height})` });
          continue;
        }
        const rel = `content/artwork/drive/${set.dir}/${f.driveId}${ext}`;
        await fs.mkdir(path.join(DRIVE_DIR, set.dir), { recursive: true });
        await fs.writeFile(path.join(ROOT, rel), buf);
        downloaded++;
        photo = {
          driveId: f.driveId,
          name: f.name,
          modifiedTime: f.modifiedTime,
          dir: set.dir,
          src: rel,
          width: size.width,
          height: size.height
        };
      }
      // Caption and expiry follow Drive even when the image itself is reused:
      // editing a description, or renaming a flyer to change its date, should
      // not need the photo to be re-uploaded.
      delete photo.caption;
      delete photo.expires;
      if (f.caption) photo.caption = f.caption;
      if (f.expires) photo.expires = f.expires;
      photo.name = f.name;
      keep.add(path.normalize(path.join(ROOT, photo.src)));
      photos.push(photo);
    }
    sets[setId] = { section: set.section, folder: set.folder, dir: set.dir, photos };
    if (set.keyword) sets[setId].keyword = set.keyword;
  }

  let removedFiles = 0;
  for (const p of await listLocalFiles(DRIVE_DIR)) {
    if (!keep.has(path.normalize(p))) {
      await fs.unlink(p);
      removedFiles++;
    }
  }

  const manifest = {
    version: 1,
    source: "Google Drive shared folder (build-side only; see sources/drive)",
    generatedAt: now.toISOString(),
    sets,
    skipped: plan.skipped
  };
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const s = summaryLines(prev, manifest, plan.skipped);
  const counts = Object.entries(sets).map(([id, v]) => `${id}(${v.photos.length})`).join(", ");
  console.log(`[drive] ${Object.keys(sets).length} set(s): ${counts || "none"}`);
  console.log(`[drive] fetched ${downloaded}, removed ${removedFiles}, skipped ${plan.skipped.length}`);
  for (const line of s.skipped) console.log(`[drive]   skipped: ${line}`);

  if (env.GITHUB_STEP_SUMMARY) {
    const md = ["### Google Drive", ""];
    md.push(`- added: ${s.added.length}`, `- removed: ${s.removed.length}`, `- skipped: ${s.skipped.length}`, "");
    for (const [title, list] of [["Added", s.added], ["Removed", s.removed], ["Skipped", s.skipped]]) {
      if (list.length) md.push(`<details><summary>${title}</summary>`, "", ...list.map((l) => `- ${l}`), "", "</details>", "");
    }
    await fs.appendFile(env.GITHUB_STEP_SUMMARY, md.join("\n") + "\n");
  }
  return { skipped: false, manifest, ...s };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  syncDrive().catch((err) => {
    console.error("[drive] failed:", err.message || err);
    process.exitCode = 1;
  });
}
