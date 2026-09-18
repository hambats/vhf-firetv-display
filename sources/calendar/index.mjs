#!/usr/bin/env node
/*
 * VHF public Google Calendar adapter (Phase 5). PC-side only — the Fire TV
 * never talks to this. Run via `node sources/calendar/index.mjs` (or
 * scripts/sync-sources.mjs), which writes content/generated/events.json.
 * That file is the only thing scene code (web/) ever reads; it never
 * fetches the calendar directly.
 *
 * What it does:
 *   1. Fetches the public ICS feed for the VHF calendar (the same calendar
 *      that feeds veteranshealingfarm.org/events — no API key needed, a
 *      public Google Calendar publishes a `.../public/basic.ics` URL).
 *   2. Expands every event — including recurring series (weekly workshops,
 *      volunteer shifts) — into concrete occurrences inside a rolling
 *      window (today .. today + windowDays).
 *   3. Drops anything matching content/events-exclude.json (hand-maintained,
 *      substring match against the title) — recurring internal volunteer
 *      shifts, farm-closed days, cancelled/private entries. Everything else
 *      is included, whether or not it has a registration link: a prior
 *      manual curation pass restricted this file to registration-gated
 *      events only, which is why open-studio/no-signup workshops (e.g. a
 *      Clay and Camaraderie session) silently never appeared on the
 *      display even while they were happening.
 *   4. Writes the result to content/generated/events.json.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ical from "node-ical";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const OUTPUT_PATH = path.join(ROOT, "content", "generated", "events.json");
const EXCLUDE_PATH = path.join(ROOT, "content", "events-exclude.json");
const SETTINGS_PATH = path.join(ROOT, "content", "settings.json");
const TIME_OVERRIDES_PATH = path.join(ROOT, "content", "events-time-overrides.json");

const DEFAULT_CALENDAR_ID = "vhf2023calendar@gmail.com";
const DEFAULT_WINDOW_DAYS = 120;

async function loadCalendarSettings() {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const settings = JSON.parse(raw);
    const c = settings.calendar || {};
    return {
      calendarId: c.calendarId || DEFAULT_CALENDAR_ID,
      windowDays: c.windowDays || DEFAULT_WINDOW_DAYS
    };
  } catch {
    return { calendarId: DEFAULT_CALENDAR_ID, windowDays: DEFAULT_WINDOW_DAYS };
  }
}

async function loadExcludeList() {
  try {
    const raw = await fs.readFile(EXCLUDE_PATH, "utf8");
    const doc = JSON.parse(raw);
    return Array.isArray(doc.excludeTitleContains) ? doc.excludeTitleContains : [];
  } catch {
    return [];
  }
}

// Hand-maintained corrections for events whose source calendar entry has a
// wrong time (confirmed against the farm's actual registration system).
// Keyed by the same id the sync generates, so a fix survives every re-sync
// until the underlying Google Calendar entry itself gets corrected — at
// which point the override becomes a no-op and should be deleted.
async function loadTimeOverrides() {
  try {
    const raw = await fs.readFile(TIME_OVERRIDES_PATH, "utf8");
    const doc = JSON.parse(raw);
    return doc.overrides && typeof doc.overrides === "object" ? doc.overrides : {};
  } catch {
    return {};
  }
}

function applyTimeOverride(event, overrides) {
  const o = overrides[event.id];
  if (!o) return event;
  return {
    ...event,
    start: o.start || event.start,
    end: o.end !== undefined ? o.end : event.end
  };
}

function isExcluded(title, excludeTerms) {
  const lower = (title || "").toLowerCase();
  return excludeTerms.some((term) => lower.includes(term.toLowerCase()));
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

function dateSlug(date) {
  return date.toISOString().slice(0, 10);
}

function firstUrl(text) {
  if (!text) return undefined;
  const match = text.match(/https?:\/\/[^\s"<>]+/);
  return match ? match[0] : undefined;
}

const HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": "\"",
  "&#39;": "'",
  "&nbsp;": " "
};

function stripHtml(text) {
  return String(text)
    // Every tag becomes a space, not empty — collapsing "<div>to</div><div>provide</div>"
    // to "" runs adjacent words together ("toprovide"); a space plus the later
    // whitespace collapse keeps them apart regardless of which tag it was.
    .replace(/<[^>]+>/g, " ")
    .replace(/&#\d+;|&[a-z]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] || m)
    // Literal "**bold**" markdown from a form field prints as raw asterisks
    // on screen — there's no renderer here to turn it into actual emphasis.
    .replace(/\*\*/g, "");
}

// A raw URL (frequently a bare `google.com/url?q=...regpack...` redirect) is
// useless on a television with no pointer — strip it rather than truncate
// into it.
function stripUrls(text) {
  return String(text).replace(/https?:\/\/\S+/g, " ");
}

// Sentence-level admin boilerplate that shows up verbatim in some calendar
// descriptions — written for whoever is filling out a registration form, not
// for someone watching an unattended display. Matched and removed whole
// (not just flagged) so it never reaches the screen; see the "Admin text
// leaking onto the public screen" review, 2026-09-18.
const ADMIN_PHRASE_PATTERNS = [
  // "All participants need to register through the regpack system and pay
  // the $1 system charge." (and minor wording variants of the same line)
  /all participants need to register[^.]*\.\s*/gi,
  /register(?:ing)? through the regpack system[^.]*\.?\s*/gi,
  // The shouted cancellation / no-show fee policy, asterisk-wrapped for bold
  // in the source form field.
  /\*\*\s*cancellations must be done[^*]*\*\*\s*/gi,
  // A note meant for the instructor processing sign-ups, not the viewer.
  /please provide me with[^.]*\.\s*/gi
];

function stripAdminBoilerplate(text) {
  return ADMIN_PHRASE_PATTERNS.reduce((acc, re) => acc.replace(re, " "), String(text));
}

// Prefers cutting at a sentence boundary so the fragment reads as a complete
// thought; falls back to a word boundary so we never cut mid-word.
function truncateText(text, maxLen) {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen - 1);
  const sentenceBreak = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (sentenceBreak > maxLen * 0.4) return slice.slice(0, sentenceBreak + 1).trimEnd();
  const wordBreak = slice.lastIndexOf(" ");
  return (wordBreak > 0 ? slice.slice(0, wordBreak) : slice).trimEnd() + "…";
}

function cleanText(text, maxLen) {
  if (!text) return undefined;
  // Admin boilerplate runs first, while "**cancellations...**" still has its
  // asterisks to match on — stripHtml() below removes any that survive.
  const collapsed = stripUrls(stripHtml(stripAdminBoilerplate(text))).replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return truncateText(collapsed, maxLen);
}

function cleanLocation(loc) {
  if (!loc || loc === "undefined") return undefined;
  return cleanText(loc, 120);
}

// Expands a single VEVENT (master or non-recurring) into concrete
// occurrences within [windowStart, windowEnd]. Handles EXDATE and
// RECURRENCE-ID overrides (node-ical exposes the latter as `.recurrences`,
// keyed by the ISO date string of the original occurrence).
function expandEvent(evt, windowStart, windowEnd) {
  if (evt.status === "CANCELLED") return [];

  const durationMs = evt.end && evt.start ? evt.end.getTime() - evt.start.getTime() : 0;
  const occurrences = [];

  if (!evt.rrule) {
    if (evt.start >= windowStart && evt.start <= windowEnd) {
      occurrences.push({ start: evt.start, end: evt.end, source: evt });
    }
    return occurrences;
  }

  const exdateKeys = new Set(
    evt.exdate ? Object.keys(evt.exdate).map((k) => new Date(k).toDateString()) : []
  );
  const recurrenceOverrides = evt.recurrences || {};

  const dates = evt.rrule.between(windowStart, windowEnd, true);
  for (const start of dates) {
    if (exdateKeys.has(start.toDateString())) continue;

    var override = null;
    for (const key of Object.keys(recurrenceOverrides)) {
      if (new Date(key).toDateString() === start.toDateString()) {
        override = recurrenceOverrides[key];
        break;
      }
    }
    if (override) {
      if (override.status === "CANCELLED") continue;
      occurrences.push({ start: override.start, end: override.end, source: override });
    } else {
      occurrences.push({ start, end: new Date(start.getTime() + durationMs), source: evt });
    }
  }
  return occurrences;
}

async function main() {
  const { calendarId, windowDays } = await loadCalendarSettings();
  const excludeTerms = await loadExcludeList();
  const timeOverrides = await loadTimeOverrides();
  const icsUrl = `https://calendar.google.com/calendar/ical/${encodeURIComponent(calendarId)}/public/basic.ics`;

  console.log(`[calendar] fetching ${icsUrl}`);
  const raw = await ical.async.fromURL(icsUrl);
  const vevents = Object.values(raw).filter((e) => e.type === "VEVENT");
  console.log(`[calendar] parsed ${vevents.length} VEVENT entries (including recurring masters)`);

  const now = new Date();
  const windowEnd = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

  const seenIds = new Set();
  const events = [];
  let excludedCount = 0;

  for (const evt of vevents) {
    const occurrences = expandEvent(evt, now, windowEnd);
    for (const occ of occurrences) {
      const title = occ.source.summary || evt.summary;
      if (!title) continue;
      if (isExcluded(title, excludeTerms)) {
        excludedCount++;
        continue;
      }

      let id = `${slugify(title)}-${dateSlug(occ.start)}`;
      let suffix = 2;
      while (seenIds.has(id)) {
        id = `${slugify(title)}-${dateSlug(occ.start)}-${suffix}`;
        suffix++;
      }
      seenIds.add(id);

      let description = cleanText(occ.source.description, 240);
      if (description && description.toLowerCase().startsWith(String(title).toLowerCase())) {
        description = description.slice(title.length).replace(/^[\s.:—-]+/, "").trim() || undefined;
      }
      events.push(applyTimeOverride({
        id,
        title: cleanText(title, 120),
        start: occ.start.toISOString(),
        end: occ.end ? occ.end.toISOString() : undefined,
        location: cleanLocation(occ.source.location),
        description,
        registrationUrl: firstUrl(occ.source.description)
      }, timeOverrides));
    }
  }

  events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const output = {
    version: 3,
    source: "google-calendar-ics",
    calendarId,
    generatedAt: new Date().toISOString(),
    note: `Pulled from the public VHF Google Calendar ICS feed (sources/calendar/index.mjs), windowed to the next ${windowDays} days. Entries matching content/events-exclude.json (closures, internal volunteer shifts, cancelled/private items) are dropped; everything else is included regardless of whether it has a registration link.`,
    events
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");

  console.log(`[calendar] wrote ${events.length} upcoming events (excluded ${excludedCount} matched terms) -> ${path.relative(ROOT, OUTPUT_PATH)}`);
}

main().catch((err) => {
  console.error("[calendar] failed:", err);
  process.exitCode = 1;
});
