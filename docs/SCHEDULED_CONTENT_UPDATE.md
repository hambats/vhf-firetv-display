# VHF Fire TV Display — Scheduled Content Update

A self-contained task description for a recurring scheduled agent (e.g. Cowork). Paste this
whole file in as the task's instructions.

## Project

`D:\VHF_TV` — Veterans Healing Farm's Fire TV digital display. A GitHub Pages static site
(`hambats.github.io/vhf-firetv-display`) that the Fire TV app polls for content. The PC project
(this repo) is the source of truth; nothing here requires the developer's PC to stay online
after a deploy.

## What to do, every run

1. `cd D:\VHF_TV`
2. Run both content-source adapters:
   ```bash
   npm run sync-sources
   ```
   This re-scrapes the VHF gallery pages (`sources/gallery/index.mjs`) and re-fetches the
   public VHF Google Calendar (`sources/calendar/index.mjs`), rewriting
   `content/generated/gallery.json` and `content/generated/events.json`.
3. Publish:
   ```bash
   npm run publish
   ```
   One command, and the only supported way to publish. It re-validates every file under
   `content/` against `docs/CONTENT_SCHEMA.md`, rebuilds, runs the tests, commits the
   changed content, pushes to `main`, and then polls the live site until the published
   version actually advances.

   **If it fails at any step, stop.** Report the failure (see "What to report" below).
   A failed validate/build/test never pushes, so the previously published site stays
   live and correct.

   The last line is the proof: `published version NNN`. A push only *starts* a
   publish — GitHub Actions runs the deploy — so a successful push on its own does not
   mean the display was updated. If the script reports that the version did not advance
   before the timeout, check the repo's Actions tab and re-check with
   `npm run publish -- --verify-only`.

Equivalently, all of this is wrapped in the project's own `update-vhf-content` Claude Code
skill (`.claude/skills/update-vhf-content/SKILL.md`) if running inside Claude Code — invoke
that skill instead of re-deriving the steps.

## What NOT to touch

- Don't hand-edit `content/generated/gallery.json` or `content/generated/events.json` —
  both are overwritten from scratch every run.
- Don't touch the hand-authored `information` slides in `content/playlist.json` (mission,
  program descriptions, history, impact numbers). Those are static facts about the
  nonprofit, not synced content, and change only when a human deliberately updates them.
- Don't touch `content/announcements/announcements.json` — announcements are authored by
  VHF staff, not synced.
- Don't loosen `content/gallery-exclude.json` or `content/events-exclude.json`. Entries
  there were added because something needed to be excluded (a photo needing context an
  unattended TV can't provide, or a calendar entry that's genuinely internal — a board
  meeting, a volunteer-only shift, a farm-closed day). If a run seems to be excluding
  something that shouldn't be, report it — don't just remove the exclusion yourself.

## What to report back after each run

- How many events are now upcoming (`content/generated/events.json`), and how many were
  excluded by `content/events-exclude.json` (from the `[calendar]` log line).
- How many photos are in the gallery pool and their year spread (from the `[gallery]` log
  output) — flag it if the spread looks flat/uniform instead of skewed toward recent years,
  that usually means the recency weighting or a gallery page URL broke.
- Whether the deploy succeeded, and the live URL.
- Anything that failed validation, with the exact error text from `npm test`.

## If something looks wrong

- **A workshop/event still isn't showing up**: check whether it's further out than the
  120-day sync window (`calendar.windowDays` in `content/settings.json`), or whether its
  title happens to match a substring in `content/events-exclude.json`. Report which one —
  don't silently widen the window or narrow the exclude list without flagging it.
- **A photo shouldn't be in rotation** (needs context an unattended TV can't provide, wrong
  content, etc.): note the photo's `id` from `content/generated/gallery.json` and report it
  rather than editing `content/gallery-exclude.json` directly, unless explicitly asked to
  make that call autonomously.
- **Build or test failure**: report the exact error. `npm run publish` refuses to push on a
  failed validate/build/test, so the previously published site stays live automatically —
  don't work around it.

## Suggested cadence

Weekly is reasonable — the gallery and calendar don't change fast enough to need daily
syncs, and a weekly cadence keeps the diff small enough to spot-check in the report above.
