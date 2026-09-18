#!/usr/bin/env node
/*
 * Display-appropriateness linter for content/. A different question from
 * scripts/validate-content.mjs's "is this well-formed JSON matching the
 * schema?" — this asks "is this fit to put on an unattended television?"
 *
 * Every rule here is grounded in something that actually reached the display
 * before a human noticed (see docs/BUILD_TREE.md M2's `lint-content.mjs`
 * bullet and M4 for the incidents). This is advisory only: it prints
 * warnings and always exits 0. It must never block a publish — that's what
 * validate-content.mjs is for. scripts/publish.mjs runs this early and
 * non-blockingly.
 *
 * Exported as a function (validateContentDir's pattern) so publish.mjs and
 * tests/lint-content.test.mjs can call it directly instead of shelling out.
 *
 * Usage: node scripts/lint-content.mjs [contentDir]
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Rule 1: literal markdown emphasis surviving into rendered text. There is no
// markdown renderer anywhere in web/ — the scene code prints strings as-is —
// so "**Bring a jacket**" arrives on the wall with its asterisks showing.
// sources/calendar/index.mjs's stripMarkdown() is supposed to catch this at
// sync time; a hit here means something slipped past it or was hand-typed
// directly into a JSON file (e.g. an announcement authored by hand).
const MARKDOWN_EMPHASIS_RE = /\*\*[^*\n]+\*\*|__[^_\n]+__/;

// Rule 2: ALL-CAPS runs longer than ~20 characters. Below that, short
// acronyms and initialisms (VHF, USA, 5K) are normal and not shouting; above
// it, it reads as shouting and is usually pasted verbatim from an email.
// Matches runs of uppercase letters, spaces, and basic punctuation so
// "PLEASE ARRIVE BY 9 AM SHARP" counts as one 26-character run.
const ALL_CAPS_RUN_RE = /[A-Z][A-Z0-9 '&.,!-]{19,}/;

function hasLongAllCapsRun(text) {
  const match = ALL_CAPS_RUN_RE.exec(text);
  if (!match) return false;
  // Require at least one more letter besides the first to rule out a match
  // that's mostly digits/punctuation with a single capital letter anchor.
  return /[A-Z].*[A-Z]/.test(match[0]);
}

// Rule 3: a description that is entirely administrative/registration
// boilerplate — nothing else in the field once the boilerplate is
// discounted. This is different from validate-content.mjs's ADMIN_PHRASE_RE,
// which fails the build if boilerplate appears *anywhere*; this rule instead
// flags the milder case where boilerplate is present but doesn't consume the
// whole field (already useful to a human reviewer, but not build-breaking).
const ADMIN_BOILERPLATE_PATTERNS = [
  /please register/i,
  /cancellation fee/i,
  /click here to sign up/i,
  /sign up (?:here|now|today)/i,
  /regpack/i,
  /registration (?:is )?required/i,
  /space(?:s)? (?:is|are) limited/i,
  /rsvp (?:by|required|to)/i
];

function isAllBoilerplate(text) {
  let stripped = text;
  for (const re of ADMIN_BOILERPLATE_PATTERNS) {
    stripped = stripped.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), " ");
  }
  stripped = stripped.replace(/[\s.,!;:()-]+/g, "").trim();
  // Boilerplate was actually present, and next to nothing else survives.
  return stripped.length < 8 && ADMIN_BOILERPLATE_PATTERNS.some((re) => re.test(text));
}

// Rule 4: a description truncated mid-word. Heuristic: it's suspicious if
// the field (a) doesn't end in terminal punctuation (. ! ? … or a closing
// quote/paren after one) AND (b) either its last "word" contains no vowel
// and is longer than 2 characters (looks like a word chopped before its
// ending), or the whole field is implausibly short for a description
// (under 15 characters) — both patterns a clean, hand-finished sentence
// should never exhibit.
const TERMINAL_PUNCT_RE = /[.!?…]['")\]]?\s*$/;
const MIN_PLAUSIBLE_LENGTH = 15;

// sources/calendar/index.mjs's cleanText() calls truncateText() with a fixed
// maxLen (120 for titles/locations, 240 for descriptions). truncateText()
// tries to cut at a sentence or word boundary, but when neither break falls
// far enough into the string it can fail open and land within a couple of
// characters of the raw limit — mid-word. A field landing right on one of
// those ceilings, with no terminal punctuation, is that failure mode.
const TRUNCATION_LENGTH_HINTS = [120, 240];
const TRUNCATION_HINT_TOLERANCE = 3;

function looksTruncated(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (TERMINAL_PUNCT_RE.test(trimmed)) return false;
  if (trimmed.length < MIN_PLAUSIBLE_LENGTH) return true;
  if (TRUNCATION_LENGTH_HINTS.some((n) => Math.abs(trimmed.length - n) <= TRUNCATION_HINT_TOLERANCE)) return true;
  const words = trimmed.split(/\s+/);
  const lastWord = words[words.length - 1].replace(/[^A-Za-z]/g, "");
  if (lastWord.length > 2 && !/[aeiouAEIOU]/.test(lastWord)) return true;
  return false;
}

// Rule 5: the farm's own postal address slipping into an event's `location`.
// The display is standing at 138 Kimzey Rd, Mills River, NC 28759 — printing
// that tells a viewer nothing. sources/calendar/index.mjs's cleanLocation()
// is supposed to strip every variant of this at sync time; a hit here means
// a wording came through that its own FARM_SIGNATURE matching missed.
//
// Deliberately narrow: only the farm's *name* or its *street address*
// ("138 Kimzey Rd/Road") identify the farm uniquely. A bare "Mills River, NC
// 28759" does not — genuine off-site venues (Mills River Park, for one, in
// the real events.json) share the same town and ZIP, and cleanLocation()
// itself only triggers on the same two signatures (see FARM_SIGNATURE in
// sources/calendar/index.mjs) for exactly this reason. Matching on the town/
// ZIP alone would flag legitimate off-site locations as false positives.
const FARM_ADDRESS_RE = /veterans\s+healing\s+farm|138\s+kimzey/i;

function mentionsFarmAddress(text) {
  return FARM_ADDRESS_RE.test(text);
}

// Rule 7: the gallery photo pool falling below a reasonable floor. Below
// this, photo-pool scenes (content/playlist.json requests up to ~4 at a
// time, several times per loop) start repeating within a single loop, which
// reads as a stuck or broken display rather than a large rotating gallery.
// 20 is chosen generously below the ~120 the gallery normally holds — it's a
// "something is badly wrong with the sync" floor, not a target.
const GALLERY_FLOOR = 20;

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function push(warnings, file, id, reason) {
  warnings.push({ file, id, reason });
}

function checkTextField(warnings, file, id, fieldName, text) {
  if (typeof text !== "string" || text.length === 0) return;
  if (MARKDOWN_EMPHASIS_RE.test(text)) {
    push(warnings, file, id, `"${fieldName}" contains literal markdown emphasis (**bold** / __underline__) that will render as literal asterisks/underscores on the TV`);
  }
  if (hasLongAllCapsRun(text)) {
    push(warnings, file, id, `"${fieldName}" contains an ALL-CAPS run longer than ~20 characters — reads as shouting`);
  }
}

async function lintPlaylist(contentDir, warnings) {
  const file = "content/playlist.json";
  let doc;
  try {
    doc = await readJson(path.join(contentDir, "playlist.json"));
  } catch (err) {
    push(warnings, file, "-", `could not read/parse: ${err.message}`);
    return;
  }
  if (!Array.isArray(doc.playlist)) return;

  let announcementSlotEnabled = false;
  for (const item of doc.playlist) {
    const id = item.id ?? "?";
    if (isPlainObject(item.content)) {
      for (const [key, value] of Object.entries(item.content)) {
        if (typeof value === "string") checkTextField(warnings, file, id, key, value);
      }
    }
    // Rule 6 setup: remember whether an announcement scene is enabled at all.
    if (item.type === "announcement" && item.enabled) {
      announcementSlotEnabled = true;
    }
  }

  return announcementSlotEnabled;
}

async function lintAnnouncements(contentDir, warnings, announcementSlotEnabled) {
  const file = "content/announcements/announcements.json";
  let doc;
  try {
    doc = await readJson(path.join(contentDir, "announcements", "announcements.json"));
  } catch (err) {
    push(warnings, file, "-", `could not read/parse: ${err.message}`);
    return;
  }
  const announcements = Array.isArray(doc.announcements) ? doc.announcements : [];

  for (const a of announcements) {
    const id = a.id ?? "?";
    checkTextField(warnings, file, id, "title", a.title);
    checkTextField(warnings, file, id, "body", a.body);
  }

  // Rule 6: an announcement scene is enabled in the playlist, but the pool
  // that feeds it is empty — nothing to show when that scene comes up.
  // (An expired/not-yet-active announcement still counts here — this is a
  // coarse "is the pool empty" check, not a live activation-window check.)
  if (announcementSlotEnabled && announcements.length === 0) {
    push(warnings, "content/playlist.json + " + file, "-", "an \"announcement\" scene is enabled in the playlist, but announcements.json has zero announcements — nothing to show when that scene comes up");
  }
}

async function lintEvents(contentDir, warnings) {
  const file = "content/generated/events.json";
  let doc;
  try {
    doc = await readJson(path.join(contentDir, "generated", "events.json"));
  } catch (err) {
    push(warnings, file, "-", `could not read/parse: ${err.message}`);
    return;
  }
  const events = Array.isArray(doc.events) ? doc.events : [];

  for (const evt of events) {
    const id = evt.id ?? "?";
    checkTextField(warnings, file, id, "title", evt.title);

    if (typeof evt.description === "string" && evt.description.length > 0) {
      checkTextField(warnings, file, id, "description", evt.description);
      if (isAllBoilerplate(evt.description)) {
        push(warnings, file, id, `"description" is entirely administrative/registration boilerplate with nothing else in the field: ${JSON.stringify(evt.description)}`);
      }
      if (looksTruncated(evt.description)) {
        push(warnings, file, id, `"description" looks truncated mid-word or implausibly short (no terminal punctuation): ${JSON.stringify(evt.description)}`);
      }
    }

    if (typeof evt.location === "string" && mentionsFarmAddress(evt.location)) {
      push(warnings, file, id, `"location" still contains the farm's own postal address (${JSON.stringify(evt.location)}) — cleanLocation() in sources/calendar/index.mjs should have stripped this; a matching variant slipped through`);
    }
  }
}

async function lintGallery(contentDir, warnings) {
  const file = "content/generated/gallery.json";
  let doc;
  try {
    doc = await readJson(path.join(contentDir, "generated", "gallery.json"));
  } catch (err) {
    push(warnings, file, "-", `could not read/parse: ${err.message}`);
    return;
  }
  const photos = Array.isArray(doc.photos) ? doc.photos : [];
  if (photos.length < GALLERY_FLOOR) {
    push(warnings, file, "-", `gallery pool has only ${photos.length} photo(s), below the floor of ${GALLERY_FLOOR} — photo-pool scenes will start repeating within a single loop`);
  }
}

export async function lintContentDir(contentDir) {
  const warnings = [];
  const announcementSlotEnabled = await lintPlaylist(contentDir, warnings);
  await lintAnnouncements(contentDir, warnings, announcementSlotEnabled);
  await lintEvents(contentDir, warnings);
  await lintGallery(contentDir, warnings);
  return warnings;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const contentDir = process.argv[2] || path.join(process.cwd(), "content");
  const warnings = await lintContentDir(contentDir);
  if (warnings.length === 0) {
    console.log("Content lint OK: no display-appropriateness warnings — " + contentDir);
  } else {
    console.log(`Content lint: ${warnings.length} warning(s) — advisory only, does not block a publish`);
    for (const w of warnings) {
      console.log(`  - [${w.file}] ${w.id}: ${w.reason}`);
    }
  }
  // Always exit 0 — this is advisory, never a build gate.
}
