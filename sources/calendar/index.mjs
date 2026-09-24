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
 *   3. Drops anything matching content/events-exclude.json (hand-maintained):
 *      excludeTitleContains is a substring match against the title —
 *      recurring internal volunteer shifts, farm-closed days,
 *      cancelled/private entries — and excludeIds drops single occurrences
 *      by generated id, for one cancelled session of a series whose other
 *      sessions share its title and must stay. Everything else
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
import { normalizeDashes, normalizeSentenceSpacing, truncateText } from "./text.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const OUTPUT_PATH = path.join(ROOT, "content", "generated", "events.json");
const EXCLUDE_PATH = path.join(ROOT, "content", "events-exclude.json");
const SETTINGS_PATH = path.join(ROOT, "content", "settings.json");
const TIME_OVERRIDES_PATH = path.join(ROOT, "content", "events-time-overrides.json");

const DEFAULT_CALENDAR_ID = "vhf2023calendar@gmail.com";
const DEFAULT_WINDOW_DAYS = 120;

// Matches an event's title to a hand-curated photo set (see
// content/artwork/curated/<id>/, built by sources/curated-photos/index.mjs)
// so its scene shows an actual photo of that program instead of a random
// farm photo. Case-insensitive substring match, first pattern to hit wins.
// A program with no populated folder simply matches nothing and the scene
// falls back to the general gallery pool — this list can stay ahead of
// which folders are actually filled in.
const PROGRAM_KEYWORDS = [
  { programId: "program-pottery", patterns: ["pottery"] },
  { programId: "program-woodworking", patterns: ["woodworking"] },
  { programId: "program-soap-making", patterns: ["soap making", "soap pour"] },
  { programId: "program-chair-massage", patterns: ["chair massage"] },
  { programId: "program-acupuncture", patterns: ["acupuncture"] },
  // Sourdough sits ahead of kitchen-medicine deliberately: first pattern to
  // hit wins, and a loaf of bread is specific enough to deserve its own
  // photo rather than the general kitchen set's pasta and canning shots.
  { programId: "program-sourdough", patterns: ["sourdough"] },
  { programId: "program-kitchen-medicine", patterns: ["kitchen medicine", "pasta making", "meal prep", "canning"] },
  { programId: "program-fishing", patterns: ["trout", "fly casting", "fly tying", "fishing"] },
  { programId: "program-dog-training", patterns: ["dog training", "canine companions"] },
  { programId: "program-wellness-retreat", patterns: ["wellness retreat"] },
  { programId: "program-mushroom-cultivation", patterns: ["mushroom cultivation"] },
  { programId: "program-quail-hunt", patterns: ["quail hunt"] },
  { programId: "program-5k-fundraiser", patterns: ["5k", "fun run"] },
  { programId: "program-beekeeping", patterns: ["beekeeping"] },
  { programId: "program-herb-squad", patterns: ["herb squad", "medicinal herb"] },
  { programId: "program-agritherapy", patterns: ["agritherapy", "garden group"] },
  { programId: "program-hendersonville-womans-club", patterns: ["hendersonville women", "hendersonville woman"] },
  { programId: "program-equine-therapy", patterns: ["equine therapy", "horse sense"] },
  { programId: "program-sunset-yoga", patterns: ["sunset yoga"] },
  { programId: "program-art-therapy", patterns: ["art class", "art workshop", "acrylic pouring", "creative canvas", "botanical sketchbook", "mixed media"] },
  { programId: "program-blacksmithing", patterns: ["blacksmith"] }
];

// A recurring partner-org meeting's calendar description is usually just
// registration boilerplate (or blank) — not worth a screen on its own. This
// overrides the scraped description with the org's own tagline/blurb so it
// rides along on the event card every time that program's meeting comes up,
// rather than needing a standalone info slide in playlist.json per partner.
const PROGRAM_DESCRIPTION_OVERRIDES = {
  "program-hendersonville-womans-club": "Empower, Engage, Enrich. A century of empowering women and enriching Henderson County through philanthropic and community service."
};

function matchProgramId(title) {
  const lower = (title || "").toLowerCase();
  for (const { programId, patterns } of PROGRAM_KEYWORDS) {
    if (patterns.some((p) => lower.includes(p))) return programId;
  }
  return undefined;
}

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

// excludeIds is keyed by generated id (same keys as events-time-overrides.json)
// with the reason as the value, so the note travels with the entry. Like a time
// override, an entry for a date that has passed is a no-op and can be deleted.
async function loadExcludeList() {
  try {
    const raw = await fs.readFile(EXCLUDE_PATH, "utf8");
    const doc = JSON.parse(raw);
    return {
      terms: Array.isArray(doc.excludeTitleContains) ? doc.excludeTitleContains : [],
      ids: doc.excludeIds && typeof doc.excludeIds === "object" ? doc.excludeIds : {}
    };
  } catch {
    return { terms: [], ids: {} };
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
    .replace(/&#\d+;|&[a-z]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] || m);
}

// Calendar descriptions are typed into a form field, and people type markdown
// there out of habit. Nothing downstream renders it — the scene prints the
// string as-is, so "**Bring a jacket**" arrives on the wall with its asterisks
// showing. Unwrap the emphasis and keep the words.
//
// The single-character forms (*italic*, _italic_) are matched conservatively:
// the opening marker must follow a space or start-of-line and the closing one
// must precede a space, punctuation or end-of-line, so an underscore inside a
// token (regpack's "url_vars=...") can never open a run.
function stripMarkdown(text) {
  return String(text)
    // [label](https://...) -> label. Runs before stripUrls() so the link text
    // survives instead of leaving an orphaned "[label]( )".
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1")
    // ATX headings and list bullets at the start of a line.
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "")
    // Paired emphasis, longest markers first so "***x***" fully unwraps.
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, "$1")
    .replace(/___([^_\n]+)___/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    // Strikethrough is the one marker whose content must go too: "~~5pm~~ 6pm"
    // is a correction, and unwrapping it would put both times on the wall.
    .replace(/~~[^~\n]+~~/g, " ")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(^|\s)\*([^*\n]+)\*(?=$|[\s.,!?;:)])/g, "$1$2")
    .replace(/(^|\s)_([^_\n]+)_(?=$|[\s.,!?;:)])/g, "$1$2")
    // Unbalanced leftovers — emphasis someone opened and never closed, or the
    // "***" that survives when stripAdminBoilerplate() cuts a boilerplate line
    // out from between two markers. Every remaining asterisk goes: this prose
    // has no legitimate use for one, and a lone "*" on the wall is the exact
    // defect we're fixing. Underscores are left alone unless they were a
    // matched pair above, so "url_vars" and "a_b_c" survive intact.
    .replace(/\*/g, "")
    .replace(/__/g, "");
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

function cleanText(text, maxLen) {
  if (!text) return undefined;
  // Admin boilerplate runs first, while "**cancellations...**" still has its
  // asterisks to match on — stripHtml() below removes any that survive.
  // normalizeSentenceSpacing runs before the collapse so a missing space after a
  // full stop is repaired for the reader *and* left visible to truncateText,
  // which needs it to find the sentence boundary.
  const collapsed = normalizeDashes(
    normalizeSentenceSpacing(
      stripUrls(stripMarkdown(stripHtml(stripAdminBoilerplate(text))))
    )
  )
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length === 0) return undefined;
  return truncateText(collapsed, maxLen);
}

// The farm's own postal address, as Google Calendar stamps it onto every
// on-site event. Each entry is compared against one comma-separated segment of
// the location string, lowercased and stripped of punctuation.
const FARM_ADDRESS_SEGMENTS = [
  "veterans healing farm",
  "vhf",
  "138 kimzey rd",
  "138 kimzey road",
  "mills river",
  "nc 28759",
  "north carolina 28759",
  "28759",
  "usa",
  "us",
  "united states"
];

// Recognises the location as the farm itself, comma-separated or not. Only
// when this matches do we start deleting parts of the string — an off-site
// venue ("Mills River Park, 124 Town Center Dr, ...") keeps its full address,
// which a viewer standing here actually needs.
const FARM_SIGNATURE = /(veterans\s+healing\s+farm|138\s+kimzey)/i;

function normalizeSegment(segment) {
  return segment.toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}

// Every synced on-site event carries the farm's full postal address — which is
// the address the television is standing at. Printing it tells the viewer
// nothing and crowds out the one thing they might need: which part of the farm
// to walk to. So drop the farm's own address and keep only a sub-location
// ("Greenhouse", "Pavilion"); when nothing meaningful is left, return
// undefined so the scene omits the line entirely.
// A calendar author sometimes types a location as one flat lowercase run
// ("forest project woodworking 141 holland rd pisgah forest nc 28768")
// instead of a normally-capitalized address — same source, same program,
// inconsistent with its own other occurrences. Title-cases it only when the
// whole string has no uppercase letters at all, so an already-fine location
// ("141 Holland Rd, Pisgah Forest, NC 28768, USA") is never touched.
const LOWERCASE_CONNECTORS = new Set(["and", "at", "in", "of", "on", "the", "to", "with"]);
const UPPERCASE_WORDS = new Set(["nc", "usa"]);

function titleCaseIfFlat(text) {
  if (!text || /[A-Z]/.test(text)) return text;
  return text.replace(/[a-z0-9']+/gi, (word, offset) => {
    var lower = word.toLowerCase();
    if (UPPERCASE_WORDS.has(lower)) return lower.toUpperCase();
    if (offset > 0 && LOWERCASE_CONNECTORS.has(lower)) return lower;
    if (/^\d+$/.test(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

function cleanLocation(loc) {
  if (!loc || loc === "undefined") return undefined;
  const cleaned = cleanText(loc, 120);
  if (!cleaned) return undefined;
  if (!FARM_SIGNATURE.test(cleaned)) return titleCaseIfFlat(cleaned);

  // Comma-separated form: keep the segments that aren't part of the address.
  let remainder = cleaned
    .split(",")
    .filter((segment) => {
      const norm = normalizeSegment(segment);
      return norm.length > 0 && !FARM_ADDRESS_SEGMENTS.includes(norm);
    })
    .join(", ")
    .trim();

  // Unpunctuated form ("Greenhouse Veterans Healing Farm 138 Kimzey Rd Mills
  // River NC 28759 USA") — no commas to split on, so cut the address out of
  // the run of words instead.
  if (FARM_SIGNATURE.test(remainder)) {
    remainder = remainder
      .replace(/veterans\s+healing\s+farm/gi, " ")
      .replace(/138\s+kimzey\s+(?:rd|road)\.?/gi, " ")
      .replace(/mills\s+river/gi, " ")
      .replace(/\b(?:nc|north\s+carolina)\b\.?\s*28759/gi, " ")
      .replace(/\b28759\b/g, " ")
      .replace(/\b(?:usa|united\s+states)\b\.?/gi, " ");
  }

  remainder = remainder
    .replace(/\s+/g, " ")
    .replace(/^[\s,.\-\u2013\u2014]+|[\s,.\-\u2013\u2014]+$/g, "")
    .trim();

  // A bare house number or a one-character scrap is noise, not a sub-location.
  if (remainder.length < 2 || /^\d+$/.test(remainder)) return undefined;
  return titleCaseIfFlat(remainder);
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
  const { terms: excludeTerms, ids: excludeIds } = await loadExcludeList();
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
      if (Object.prototype.hasOwnProperty.call(excludeIds, id)) {
        excludedCount++;
        continue;
      }

      // 280, not 240: a typical VHF description runs to ~250 characters, and at 240
      // the truncator was discarding a whole second sentence to save a handful of
      // characters (the Meal Prep workshop lost 140 of its 250). The scene has the
      // vertical room — verified on the panel — so the limit only needs to stop a
      // genuinely long description, not trim an ordinary one.
      let description = cleanText(occ.source.description, 280);
      if (description && description.toLowerCase().startsWith(String(title).toLowerCase())) {
        description = description.slice(title.length).replace(/^[\s.:—-]+/, "").trim() || undefined;
      }
      const programId = matchProgramId(title);
      if (PROGRAM_DESCRIPTION_OVERRIDES[programId]) {
        description = PROGRAM_DESCRIPTION_OVERRIDES[programId];
      }
      events.push(applyTimeOverride({
        id,
        title: cleanText(title, 120),
        start: occ.start.toISOString(),
        end: occ.end ? occ.end.toISOString() : undefined,
        location: cleanLocation(occ.source.location),
        description,
        programId
      }, timeOverrides));
    }
  }

  /*
   * Tie-broken on id, not just start. Several events legitimately share a
   * start time — the farm runs concurrent sessions, and the recurring-event
   * expansion above emits occurrences in whatever order their masters were
   * parsed. Array.prototype.sort is only guaranteed stable with respect to
   * the *input* order, and that input order is not itself stable between
   * runs, so equal-keyed events shuffled every sync: a re-sync with zero
   * actual changes still moved 8 of 39 events and rewrote the file.
   *
   * That matters because content/generated/ is diffed by a human (and by the
   * scheduled sync task) to decide whether a refresh is worth publishing.
   * Churn with no information in it is how a real change gets waved through.
   */
  events.sort((a, b) => {
    const byStart = new Date(a.start).getTime() - new Date(b.start).getTime();
    if (byStart !== 0) return byStart;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

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

  console.log(`[calendar] wrote ${events.length} upcoming events (excluded ${excludedCount} by title or id) -> ${path.relative(ROOT, OUTPUT_PATH)}`);
}

main().catch((err) => {
  console.error("[calendar] failed:", err);
  process.exitCode = 1;
});
