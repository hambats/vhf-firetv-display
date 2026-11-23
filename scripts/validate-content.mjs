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

/*
 * A full date-time with an explicit zone: "...Z" or "...-05:00". Anything less
 * is read by Date.parse in whatever zone the reader is in -- a date-only
 * string as UTC midnight (the evening before, in North Carolina), an
 * offset-less one as the television's own local time. Both are wrong by hours
 * on the screen with nothing to show for it, so hand-typed times must say
 * which zone they mean.
 */
const ZONED_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isZonedDateTime(v) {
  return typeof v === "string" && ZONED_DATE_TIME_RE.test(v) && !isNaN(Date.parse(v));
}

const ZONED_HINT = 'a full date-time with a UTC offset or Z, e.g. "2026-11-08T23:59:59-05:00"';

function isValidUrl(v) {
  if (typeof v !== "string") return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

function isValidTimeZone(v) {
  if (typeof v !== "string" || v.length === 0) return false;
  try {
    // Intl throws RangeError on an unknown zone, which is the only reliable
    // way to tell "America/New_York" from "America/New York" or a typo.
    new Intl.DateTimeFormat("en-US", { timeZone: v });
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
    } else if (item.type === "information") {
      validateInformationContent(item.content, tag, errors);
    }
  }
}

// Information-slide families with their own ground (web/css/theme.css). Both
// render with no photo at all; anything else is the default story treatment.
const INFORMATION_FAMILIES = ["impact", "crisis"];

function validateInformationContent(c, tag, errors) {
  if (c.family !== undefined && !INFORMATION_FAMILIES.includes(c.family)) {
    errors.push(`${tag}: "content.family" must be one of ${INFORMATION_FAMILIES.join(", ")} if present (got ${JSON.stringify(c.family)})`);
  }
  if (c.callout !== undefined) {
    if (typeof c.callout !== "string" || c.callout.trim().length === 0) {
      errors.push(`${tag}: "content.callout" must be a non-empty string`);
    } else if (c.family !== "crisis") {
      // Only the crisis family draws it; elsewhere it would silently vanish.
      errors.push(`${tag}: "content.callout" is only shown on a "crisis" family slide`);
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
  // Required, not optional: events.json stores UTC, and without an explicit
  // zone the display formats every event time in whatever the television
  // believes local time is. That failure is invisible on screen — the times
  // are simply wrong by a fixed offset — so the absence of this key has to be
  // an error at build time rather than a default applied at render time.
  if (typeof doc.timezone !== "string" || !isValidTimeZone(doc.timezone)) {
    errors.push(
      `${label}: "timezone" must be a valid IANA time zone name (e.g. "America/New_York")`
    );
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
    if (a.activation !== undefined && !isZonedDateTime(a.activation)) {
      errors.push(`${tag}: "activation" must be ${ZONED_HINT} (got ${JSON.stringify(a.activation)})`);
    }
    if (a.expiration !== undefined && !isZonedDateTime(a.expiration)) {
      errors.push(`${tag}: "expiration" must be ${ZONED_HINT} (got ${JSON.stringify(a.expiration)})`);
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

/*
 * content/events-time-overrides.json: hand-typed corrections that
 * sources/calendar copies verbatim into events.json, so the display parses
 * these exact strings. Shape is what loadTimeOverrides/applyTimeOverride read:
 * { overrides: { <event id>: { start?, end?, note? } } }.
 */
const EVENT_ID_RE = /-\d{4}-\d{2}-\d{2}(?:-\d+)?$/;

function validateTimeOverrides(doc, errors) {
  const label = "content/events-time-overrides.json";
  if (doc.version !== undefined && typeof doc.version !== "number") errors.push(`${label}: "version" must be a number`);
  if (!isPlainObject(doc.overrides)) {
    errors.push(`${label}: "overrides" must be an object keyed by event id`);
    return;
  }
  for (const [id, o] of Object.entries(doc.overrides)) {
    const tag = `${label} override "${id}"`;
    if (!EVENT_ID_RE.test(id)) {
      errors.push(`${tag}: key must be an event id as the calendar sync generates it (ending in -YYYY-MM-DD)`);
    }
    if (!isPlainObject(o)) {
      errors.push(`${tag}: must be an object with "start" and/or "end"`);
      continue;
    }
    if (o.start === undefined && o.end === undefined) errors.push(`${tag}: needs "start" and/or "end"`);
    if (o.start !== undefined && !isZonedDateTime(o.start)) errors.push(`${tag}: "start" must be ${ZONED_HINT}`);
    // null is meaningful to the loader: it clears the calendar's end time.
    if (o.end !== undefined && o.end !== null && !isZonedDateTime(o.end)) errors.push(`${tag}: "end" must be ${ZONED_HINT} or null`);
    if (isZonedDateTime(o.start) && isZonedDateTime(o.end) && Date.parse(o.end) < Date.parse(o.start)) {
      errors.push(`${tag}: "end" is before "start"`);
    }
    if (o.note !== undefined && typeof o.note !== "string") errors.push(`${tag}: "note" must be a string`);
  }
}

// `optional`: a missing file is fine (the reader treats it as empty); a
// present one must still parse and validate.
const KNOWN_FILES = [
  { relPath: "playlist.json", validate: validatePlaylist },
  { relPath: "settings.json", validate: validateSettings },
  { relPath: path.join("generated", "events.json"), validate: validateEvents },
  { relPath: path.join("announcements", "announcements.json"), validate: validateAnnouncements },
  { relPath: path.join("generated", "gallery.json"), validate: validateGallery },
  { relPath: path.join("generated", "curated-photos.json"), validate: validateCuratedPhotos },
  { relPath: "gallery-exclude.json", validate: validateGalleryExclude },
  { relPath: "events-exclude.json", validate: validateEventsExclude },
  { relPath: "events-time-overrides.json", validate: validateTimeOverrides, optional: true }
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
  for (const { relPath, validate, optional } of KNOWN_FILES) {
    const filePath = path.join(contentDir, relPath);
    let doc;
    try {
      doc = await readJson(filePath);
    } catch (err) {
      if (optional && err.code === "ENOENT") continue;
      // Forward slashes whatever the OS, to match every other message here --
      // admin/server.mjs picks out a file's errors by this prefix.
      errors.push(`content/${relPath.split(path.sep).join("/")}: ${err.message}`);
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
