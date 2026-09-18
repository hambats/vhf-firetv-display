---
name: update-vhf-content
description: Refresh everything that changes over time — new gallery photos and the calendar of upcoming events/workshops — rebuild, validate, and redeploy the Fire TV display. Use when the user asks to "update content", "refresh everything", "sync the calendar/gallery", says a workshop or event isn't showing up, or mentions the display looking stale/out of date. Does NOT touch the hand-authored mission/program/impact fact slides in playlist.json — those change rarely and are edited by hand, not synced.
---

# Update VHF Content

Runs both content-source adapters — gallery and calendar — rebuilds the Netlify site,
validates, and redeploys. This is the "get everything current" skill, as opposed to
editing the static mission/program/history slides in `content/playlist.json`, which
don't come from an external source and should be hand-edited instead.

## What this actually does

1. **Gallery** (`sources/gallery/index.mjs`): re-scrapes the three yearly VHF gallery
   pages from scratch and rebuilds the recency-weighted 120-photo pool in
   `content/generated/gallery.json`. See `.claude/skills/refresh-vhf-photos/` for the
   full detail on how photo selection works — this skill just runs it as one step of
   a bigger sync.

2. **Calendar** (`sources/calendar/index.mjs`): fetches the public VHF Google Calendar's
   ICS feed (`vhf2023calendar@gmail.com`, no API key needed), expands every event
   — including recurring weekly workshops — into concrete occurrences within the next
   `calendar.windowDays` (120 by default, see `content/settings.json`), and writes
   `content/generated/events.json`. Anything matching `content/events-exclude.json`
   (closures, internal volunteer shifts, cancelled/private entries) is dropped;
   everything else is included whether or not it has a registration link. This is
   the fix for "a workshop exists on the calendar but never shows on the TV" — the
   old `events.json` was hand-typed and only ever included registration-gated events.

Each event gets its own `event-pool` scene in the playlist (see
`docs/CONTENT_SCHEMA.md`) — the display cycles through all currently-upcoming events
one at a time rather than a big list, so re-running this after new events go on the
calendar mostly means new individual event scenes start appearing in rotation.

## Steps

1. Run both adapters (or run them individually — see below):
   ```bash
   npm run sync-sources
   ```
   Read the output. `[gallery]` reports candidates/qualified/excluded counts.
   `[calendar]` reports how many VEVENT entries it parsed, how many upcoming
   occurrences it wrote, and how many matched `events-exclude.json` and were dropped.

2. If a workshop/event you expected still isn't showing, check *why* before assuming
   it's a bug:
   ```bash
   node -e "
   const d = require('./content/generated/events.json');
   console.log(d.events.map(e => e.start.slice(0,10) + '  ' + e.title).join('\n'));
   "
   ```
   Common reasons an event is missing:
   - It's further out than `calendar.windowDays` (120 days) — it'll appear once
     it's within the window on a later sync.
   - Its title matches a substring in `content/events-exclude.json` — check that
     file; if the match is too broad (e.g. it's excluding a real public event by
     accident), narrow the substring.
   - It isn't actually on the `vhf2023calendar@gmail.com` public calendar yet.

3. Rebuild and run the test suite (validates all content against
   `docs/CONTENT_SCHEMA.md`, including the new `events.json`/`gallery.json`):
   ```bash
   npm run build
   npm test
   ```
   If either fails, stop and investigate — do not deploy on a failed build/test.

4. Deploy:
   ```bash
   netlify deploy --prod
   ```

5. Tell the user: how many events are now upcoming and how many photos are in the
   pool, plus anything that looked off (a spike in excluded events might mean an
   exclude term is too broad; a flat/uniform gallery year spread might mean the
   photo adapter broke).

## Running just one adapter

- Gallery only: `node sources/gallery/index.mjs` (or use the
  `refresh-vhf-photos` skill, which wraps gallery-specific build/test/deploy).
- Calendar only: `node sources/calendar/index.mjs`.

## If an event needs to be excluded

Add a distinguishing substring from its title to `content/events-exclude.json`'s
`excludeTitleContains` array, then re-run `node sources/calendar/index.mjs` (or this
whole skill) so the exclusion takes effect immediately. This matches every
occurrence of a recurring series, not just one instance — that's usually what you
want for "this recurring internal shift shouldn't be public," but double-check the
substring isn't so broad it also matches an unrelated public event.

## Don't

- Don't hand-edit `content/generated/events.json` or `content/generated/gallery.json`
  — both are regenerated from scratch every run; edits there are lost.
- Don't hand-edit the mission/program/impact `information` slides in
  `content/playlist.json` as part of this skill — those are static facts about the
  nonprofit, not synced content. Leave them alone here.
- Don't skip the build/test step to save time — a schema violation must never reach
  the deployed site.
- Don't loosen `content/events-exclude.json` to "just show everything" without
  checking — some recurring calendar entries really are internal-only (board
  meetings, volunteer shifts) and cluttering the display with those defeats the
  point of switching off the hand-curated list.
