#!/usr/bin/env node
/*
 * Validates content/ against docs/CONTENT_SCHEMA.md. Exported as a function
 * so scripts/build-site.mjs and tests/content-schema.test.mjs can both call
 * it directly instead of shelling out.
 *
 * Returns an array of human-readable error strings; empty array = valid.
 * Never throws on bad content — a validation failure is data (a list of
 * problems), not an exceptional condition.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCENE_TYPES = ["photo", "photo-pool", "event", "event-pool", "events", "information", "announcement", "custom"];

// Registration/billing boilerplate that has leaked from the calendar source
// into public descriptions before (regpack sign-up instructions, the
// all-caps no-show fee warning). sources/calendar/index.mjs strips these at
// sync time; this is the safety net that fails the build if one slips back
// in through a future calendar edit worded slightly differently.
const ADMIN_PHRASE_RE = /regpack system|system charge|cancellations must be done|please provide me with/i;

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIsoDate(v) {
  return typeof v === "string" && !isNaN(Date.parse(v));
}

function isValidUrl(v) {
  if (typeof v !== "string") return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw); // throws with a useful message on bad JSON
}

function checkUniqueIds(items, label, errors) {
  const seen = new Set();
  for (const item of items) {
    if (typeof item.id !== "string" || item.id.length === 0) {
      errors.push(`${label}: an entry is missing a string "id"`);
      continue;
    }
    if (seen.has(item.id)) {
      errors.push(`${label}: duplicate id "${item.id}"`);
    }
    seen.add(item.id);
  }
}

function validatePlaylist(doc, errors) {
  const label = "content/playlist.json";
  if (typeof doc.version !== "number") errors.push(`${label}: "version" must be a number`);
  if (!Array.isArray(doc.playlist)) {
    errors.push(`${label}: "playlist" must be an array`);
    return;
  }
  checkUniqueIds(doc.playlist, label, errors);
  for (const item of doc.playlist) {
    const tag = `${label} item "${item.id ?? "?"}"`;
    if (!SCENE_TYPES.includes(item.type)) {
      errors.push(`${tag}: "type" must be one of ${SCENE_TYPES.join(", ")} (got ${JSON.stringify(item.type)})`);
    }
    if (typeof item.duration !== "number" || item.duration <= 0) {
      errors.push(`${tag}: "duration" must be a positive number`);
    }
    if (typeof item.enabled !== "boolean") {
      errors.push(`${tag}: "enabled" must be a boolean`);
    }
    if (!isPlainObject(item.content)) {
      errors.push(`${tag}: "content" must be an object`);
    }
  }
}

function validateSettings(doc, errors) {
  const label = "content/settings.json";
  if (typeof doc.version !== "number") errors.push(`${label}: "version" must be a number`);
  if (typeof doc.syncIntervalMinutes !== "number" || doc.syncIntervalMinutes <= 0) {
    errors.push(`${label}: "syncIntervalMinutes" must be a positive number`);
  }
  if (!isValidUrl(doc.publishUrl)) {
    errors.push(`${label}: "publishUrl" must be a valid absolute URL`);
  }
  if (doc.gallery !== undefined) {
    if (!isPlainObject(doc.gallery)) {
      errors.push(`${label}: "gallery" must be an object if present`);
    } else {
      const g = doc.gallery;
      if (g.maxPhotos !== undefined && (typeof g.maxPhotos !== "number" || g.maxPhotos <= 0)) {
        errors.push(`${label}: "gallery.maxPhotos" must be a positive number`);
      }
      if (g.minDimension !== undefined && (typeof g.minDimension !== "number" || g.minDimension <= 0)) {
        errors.push(`${label}: "gallery.minDimension" must be a positive number`);
      }
      if (g.recencyDecay !== undefined && (typeof g.recencyDecay !== "number" || g.recencyDecay <= 0)) {
        errors.push(`${label}: "gallery.recencyDecay" must be a positive number`);
      }
    }
  }
  if (doc.calendar !== undefined) {
    if (!isPlainObject(doc.calendar)) {
      errors.push(`${label}: "calendar" must be an object if present`);
    } else {
      const c = doc.calendar;
      if (c.calendarId !== undefined && (typeof c.calendarId !== "string" || c.calendarId.length === 0)) {
        errors.push(`${label}: "calendar.calendarId" must be a non-empty string`);
      }
      if (c.windowDays !== undefined && (typeof c.windowDays !== "number" || c.windowDays <= 0)) {
        errors.push(`${label}: "calendar.windowDays" must be a positive number`);
      }
    }
  }
}

function validateEvents(doc, errors) {
  const label = "content/generated/events.json";
  if (typeof doc.version !== "number") errors.push(`${label}: "version" must be a number`);
  if (!Array.isArray(doc.events)) {
    errors.push(`${label}: "events" must be an array`);
    return;
  }
  checkUniqueIds(doc.events, label, errors);
  for (const evt of doc.events) {
    const tag = `${label} event "${evt.id ?? "?"}"`;
    if (typeof evt.title !== "string" || evt.title.length === 0) errors.push(`${tag}: "title" is required`);
    if (typeof evt.description === "string" && /https?:\/\//i.test(evt.description)) {
      errors.push(`${tag}: "description" must not contain a raw URL (unreadable on a television)`);
    }
    if (typeof evt.description === "string" && ADMIN_PHRASE_RE.test(evt.description)) {
      errors.push(`${tag}: "description" contains internal registration/billing text meant for a form, not a public display (see docs — admin leakage review, 2026-09-18)`);
    }
    if (!isIsoDate(evt.start)) errors.push(`${tag}: "start" must be a parseable ISO date`);
    if (evt.end !== undefined) {
      if (!isIsoDate(evt.end)) {
        errors.push(`${tag}: "end" must be a parseable ISO date`);
      } else if (Date.parse(evt.end) < Date.parse(evt.start)) {
        errors.push(`${tag}: "end" is before "start"`);
      }
    }
  }
}

function validateAnnouncements(doc, errors) {
  const label = "content/announcements/announcements.json";
  if (typeof doc.version !== "number") errors.push(`${label}: "version" must be a number`);
  if (!Array.isArray(doc.announcements)) {
    errors.push(`${label}: "announcements" must be an array`);
    return;
  }
  checkUniqueIds(doc.announcements, label, errors);
  for (const a of doc.announcements) {
    const tag = `${label} announcement "${a.id ?? "?"}"`;
    if (typeof a.title !== "string" || a.title.length === 0) errors.push(`${tag}: "title" is required`);
    if (a.activation !== undefined && !isIsoDate(a.activation)) {
      errors.push(`${tag}: "activation" must be a parseable ISO date`);
    }
    if (a.expiration !== undefined && !isIsoDate(a.expiration)) {
      errors.push(`${tag}: "expiration" must be a parseable ISO date`);
    }
  }
}

function validateGallery(doc, errors) {
  const label = "content/generated/gallery.json";
  if (typeof doc.version !== "number") errors.push(`${label}: "version" must be a number`);
  if (!Array.isArray(doc.photos)) {
    errors.push(`${label}: "photos" must be an array`);
    return;
  }
  checkUniqueIds(doc.photos, label, errors);
  for (const p of doc.photos) {
    const tag = `${label} photo "${p.id ?? "?"}"`;
    if (!isValidUrl(p.src)) errors.push(`${tag}: "src" must be a valid absolute URL`);
    if (typeof p.width !== "number" || p.width <= 0) errors.push(`${tag}: "width" must be a positive number`);
    if (typeof p.height !== "number" || p.height <= 0) errors.push(`${tag}: "height" must be a positive number`);
  }
}

function validateCuratedPhotos(doc, errors) {
  const label = "content/generated/curated-photos.json";
  if (typeof doc.version !== "number") errors.push(`${label}: "version" must be a number`);
  if (!isPlainObject(doc.sets)) {
    errors.push(`${label}: "sets" must be an object`);
    return;
  }
  for (const [name, photos] of Object.entries(doc.sets)) {
    if (!Array.isArray(photos)) {
      errors.push(`${label} set "${name}": must be an array`);
      continue;
    }
    for (const p of photos) {
      if (typeof p.src !== "string" || p.src.length === 0) {
        errors.push(`${label} set "${name}" photo "${p.id ?? "?"}": "src" is required`);
      }
    }
  }
}

function validateGalleryExclude(doc, errors) {
  const label = "content/gallery-exclude.json";
  if (typeof doc.version !== "number") errors.push(`${label}: "version" must be a number`);
  if (!Array.isArray(doc.excluded)) {
    errors.push(`${label}: "excluded" must be an array`);
    return;
  }
  checkUniqueIds(doc.excluded, label, errors);
  for (const e of doc.excluded) {
    const tag = `${label} entry "${e.id ?? "?"}"`;
    if (typeof e.reason !== "string" || e.reason.length === 0) errors.push(`${tag}: "reason" is required`);
  }
}

function validateEventsExclude(doc, errors) {
  const label = "content/events-exclude.json";
  if (typeof doc.version !== "number") errors.push(`${label}: "version" must be a number`);
  if (!Array.isArray(doc.excludeTitleContains)) {
    errors.push(`${label}: "excludeTitleContains" must be an array`);
    return;
  }
  for (const term of doc.excludeTitleContains) {
    if (typeof term !== "string" || term.length === 0) {
      errors.push(`${label}: every entry in "excludeTitleContains" must be a non-empty string`);
    }
  }
}

const KNOWN_FILES = [
  { relPath: "playlist.json", validate: validatePlaylist },
  { relPath: "settings.json", validate: validateSettings },
  { relPath: path.join("generated", "events.json"), validate: validateEvents },
  { relPath: path.join("announcements", "announcements.json"), validate: validateAnnouncements },
  { relPath: path.join("generated", "gallery.json"), validate: validateGallery },
  { relPath: path.join("generated", "curated-photos.json"), validate: validateCuratedPhotos },
  { relPath: "gallery-exclude.json", validate: validateGalleryExclude },
  { relPath: "events-exclude.json", validate: validateEventsExclude }
];

// Name -> relative path, reused by admin/server.mjs so it edits exactly the
// files this validator knows about, nothing else.
export const CONTENT_FILES = {
  playlist: "playlist.json",
  settings: "settings.json",
  events: path.join("generated", "events.json"),
  announcements: path.join("announcements", "announcements.json"),
  gallery: path.join("generated", "gallery.json"),
  "gallery-exclude": "gallery-exclude.json",
  "events-exclude": "events-exclude.json"
};

export async function validateContentDir(contentDir) {
  const errors = [];
  for (const { relPath, validate } of KNOWN_FILES) {
    const filePath = path.join(contentDir, relPath);
    let doc;
    try {
      doc = await readJson(filePath);
    } catch (err) {
      errors.push(`content/${relPath}: ${err.message}`);
      continue;
    }
    validate(doc, errors);
  }
  return errors;
}

// Allow running directly: `node scripts/validate-content.mjs [contentDir]`
// (compared via resolved filesystem paths, not raw URL strings, so this
// works on Windows too — file:// URLs use forward slashes, argv[1] doesn't)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const contentDir = process.argv[2] || path.join(process.cwd(), "content");
  const errors = await validateContentDir(contentDir);
  if (errors.length > 0) {
    console.error("Content validation failed:");
    for (const e of errors) console.error("  - " + e);
    process.exitCode = 1;
  } else {
    console.log("Content OK: " + contentDir);
  }
}
