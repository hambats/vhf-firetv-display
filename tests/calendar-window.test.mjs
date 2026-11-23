/*
 * Which calendar occurrences a sync keeps. The display shows an event until it
 * ends; the sync used to drop it the moment it started, so a sync landing
 * mid-afternoon pulled that day's events off the wall while they were on.
 *
 * Uses node-ical on an inline ICS, so recurring series go through the same
 * rrule objects a real feed produces. No network.
 *
 * Run with: node --test tests/calendar-window.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import ical from "node-ical";

// The adapter syncs on import unless told not to.
process.env.VHF_NO_AUTORUN = "1";
const { expandEvent } = await import("../sources/calendar/index.mjs");

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:hunt@test",
  "DTSTART:20261114T133000Z",
  "DTEND:20261114T203000Z",
  "SUMMARY:Veterans Quail Hunt",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:studio@test",
  "DTSTART:20261107T150000Z",
  "DTEND:20261107T170000Z",
  "RRULE:FREQ=WEEKLY;COUNT=3",
  "SUMMARY:Open Pottery Studio",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:noend@test",
  "DTSTART:20261114T150000Z",
  "SUMMARY:Drop-off day",
  "END:VEVENT",
  "END:VCALENDAR",
  ""
].join("\r\n");

const events = Object.values(ical.sync.parseICS(ICS)).filter((e) => e.type === "VEVENT");
const byTitle = (title) => events.find((e) => e.summary === title);

function startsKept(title, nowIso) {
  const now = new Date(nowIso);
  const windowEnd = new Date(now.getTime() + 120 * 86400000);
  return expandEvent(byTitle(title), now, windowEnd).map((o) => o.start.toISOString());
}

test("a one-off event stays while it is running", () => {
  assert.deepEqual(startsKept("Veterans Quail Hunt", "2026-11-14T16:00:00Z"), ["2026-11-14T13:30:00.000Z"]);
});

test("a one-off event goes once it has ended", () => {
  assert.deepEqual(startsKept("Veterans Quail Hunt", "2026-11-14T21:00:00Z"), []);
});

test("a recurring occurrence that has started but not ended is still found", () => {
  assert.deepEqual(startsKept("Open Pottery Studio", "2026-11-14T16:00:00Z"), [
    "2026-11-14T15:00:00.000Z",
    "2026-11-21T15:00:00.000Z"
  ]);
});

test("a finished recurring occurrence is dropped, later ones kept", () => {
  assert.deepEqual(startsKept("Open Pottery Studio", "2026-11-14T17:30:00Z"), ["2026-11-21T15:00:00.000Z"]);
});

test("nothing changes before an event starts", () => {
  assert.deepEqual(startsKept("Open Pottery Studio", "2026-11-14T12:00:00Z"), [
    "2026-11-14T15:00:00.000Z",
    "2026-11-21T15:00:00.000Z"
  ]);
});

test("an event with no end is judged by its start, as before", () => {
  assert.deepEqual(startsKept("Drop-off day", "2026-11-14T14:00:00Z"), ["2026-11-14T15:00:00.000Z"]);
  assert.deepEqual(startsKept("Drop-off day", "2026-11-14T16:00:00Z"), []);
});
