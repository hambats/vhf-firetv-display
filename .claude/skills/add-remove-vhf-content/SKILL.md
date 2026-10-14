---
name: add-remove-vhf-content
description: Add or take down a specific item on the Fire TV display — an event ("the 5K might not be happening"), a gallery photo, a Drive photo or flyer, or a playlist slide — and publish. Use when the user says suppress, hide, remove, pull, take off, put back, restore, add, or "show this" about something on the TV. Not for bulk refreshes (use update-vhf-content) or generating new artwork (use generate-event-artwork).
---

# Add / Remove VHF Content

The PC project is the source of truth; the TV only sees what is published. Every change here
ends with `npm run publish` — nothing is live until it does. Never hand-edit `content/generated/`
(sync overwrites it).

## 1. Identify what the user means

Ambiguous words ("5K slides", "the flyers") — look before acting. Grep `content/playlist.json`,
`content/generated/events.json`, `content/settings.json`, and view the image if it is a flyer.
Say what you matched. If two readings are plausible and removal is cheap to reverse, pick the
likelier one, do it, and name the alternative in your report.

## 2. Pick the mechanism

| Target | Remove / suppress | Add / restore |
|---|---|---|
| **Calendar event** (one date or a whole series) | `content/events-exclude.json`: add to `excludeIds` (`"<event-id>": "why, who asked, date"`) for one occurrence, or `excludeTitleContains` for every occurrence. Event ids are in `content/generated/events.json`. | Delete the line. Real fix is the Google Calendar itself — tell the user if the entry is wrong there. |
| **Gallery photo** (the auto-pool from the website) | `content/gallery-exclude.json`: add `{id, reason}` | Delete the entry |
| **Drive photo / flyer** (Maddie's folder) | Delete it from the Drive folder; it leaves the display on the next sync. Or set the matching scene `"enabled": false` for a temporary pause. Never delete files under `content/artwork/drive/` — that is a mirror. | Add to the Drive folder (ask Maddie, agriculturalmanagervhf@gmail.com) |
| **Playlist slide** (mission, program, impact, a pool scene) | `"enabled": false` on its scene in `content/playlist.json` (prefer over deleting — reversible) | `"enabled": true`, or add a scene per `docs/CONTENT_SCHEMA.md` |
| **Registration QR** for an event | `content/settings.json` → `registration.overrides` (`"hide": true` for no code) | Remove the override |
| **Curated artwork** | Only `content/artwork/curated/` is published; move to `candidates/` to unpublish | Move into `curated/` and reference it from a scene |

Always leave a **reason** in exclude files (who asked, date, when to delete the line). Past
exclusions are the only record of why something is missing.

## 3. Apply, then verify the change took

```bash
npm run sync-sources      # only needed for event/gallery/Drive changes; rewrites content/generated/
npm run validate-content
```

Confirm in `content/generated/events.json` (or the relevant file) that the item is gone/present
— a grep count is enough. Preview with `npm run preview` only if the change is visual.

## 4. Publish

```bash
npm run publish           # validate → build → test → commit → push → poll version.json
```

`--dry-run` skips commit/push if the user wants to review first. Publishing is the project's
normal flow and is expected after a requested change; if the user only asked what *would*
change, stop at step 3.

## 5. Report

One short paragraph: what was removed/added, which file, that it is published (version from the
publish output), how to undo it (the exact line to delete), and any look-alike you did *not*
touch. If the user's reason was uncertainty ("might not be happening"), mention the line is
temporary and offer to remove it once they know.

## Guardrails

- The TV is shared and residential after hours — never add content that locks the screen or
  restricts it; this skill only changes what rotates.
- No identifiable guests or AI-generated people in photos (see memory: display photo preferences).
- Don't touch `app/` for content changes; no reinstall is ever needed.
