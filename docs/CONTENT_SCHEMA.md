# VHF Content Schema

The contract for every hand-edited or generated file under `content/`. Enforced by
[`scripts/validate-content.mjs`](../scripts/validate-content.mjs), which
`scripts/build-site.mjs` runs before every build — a file that doesn't match this
schema fails the build and the previous deploy stays live.

All date/time fields are ISO 8601 with an explicit UTC offset (e.g.
`2026-09-23T10:00:00-04:00`), matching what the Google Calendar API and the rest of
this project already use.

## `content/playlist.json`

```jsonc
{
  "version": 1,           // integer, required
  "playlist": [            // array, required (may be empty)
    {
      "id": "string",       // required, unique within the file
      "type": "photo | photo-pool | event | event-pool | events | information | announcement | custom",
      "duration": 10,       // seconds, positive number, required
      "enabled": true,      // boolean, required
      "content": { }        // required object; shape depends on `type` (below)
    }
  ]
}
```

`content` by scene type:

| type            | required fields                | notes |
|------------------|--------------------------------|-------|
| `information`    | `title`                        | `eyebrow`, `body` optional |
| `announcement`   | `announcementId` OR `title`    | looked up from `content/announcements/announcements.json` by id, or inline |
| `photo`          | `src`                          | `fit` (`cover`\|`contain`, default `cover`), `focus` (CSS `object-position`, default `center 35%`) |
| `photo-pool`     | —                               | picks a random photo from `content/generated/gallery.json` each time it comes up in rotation |
| `custom`         | `src`                          | full 16:9 artwork, no overlay |
| `event`          | `eventId` OR `title`+`start`   | looked up from `content/generated/events.json` by id, or inline |
| `event-pool`     | —                               | picks one upcoming event (full detail, same layout as `event`) each time it comes up in rotation, cycling through all of them before repeating — put a few of these in the playlist instead of one big list so each event gets its own screen |
| `events`         | —                               | `limit` optional (default 5), `offset` optional (default 0), `eyebrow` optional; renders a list of the next N upcoming from `events.json` starting after `offset` — kept for admin/manual use, the playlist itself now prefers `event-pool` |

## `content/settings.json`

```jsonc
{
  "version": 1,
  "syncIntervalMinutes": 20,   // positive number, required
  "publishUrl": "https://...", // required, must be a valid absolute URL
  "gallery": {                 // optional; read by sources/gallery/index.mjs, editable via admin/
    "maxPhotos": 120,          // optional, positive number, default 120
    "minDimension": 1200,      // optional, positive number, default 1200
    "recencyDecay": 35,        // optional, positive number, default 35 (smaller = more recency bias)
    "mirror": {                // optional; read by scripts/fetch-photos.mjs
      "frameWidth": 1920,      // optional, positive number, default 1920
      "frameHeight": 1080,     // optional, positive number, default 1080
      "maxZoom": 1.12,         // optional, must match the Ken Burns keyframes in web/css/scene.css
      "quality": 80            // optional, WebP quality, default 80
    }
  },
  "calendar": {                 // optional; read by sources/calendar/index.mjs
    "calendarId": "...@gmail.com", // optional, default "vhf2023calendar@gmail.com"
    "windowDays": 120,            // optional, positive number, default 120
    "venue": {                    // optional; the address the display itself stands at,
      "name": "string",           //   stripped from every synced event `location`
      "address": "string"
    }
  }
}
```

## `content/generated/events.json`

Written by [`sources/calendar/index.mjs`](../sources/calendar/index.mjs), which fetches the public
VHF Google Calendar's ICS feed, expands recurring series into concrete occurrences within a rolling
window (`calendar.windowDays` in settings, default 120 days), and drops anything matching
`content/events-exclude.json`. Re-run it any time to pick up newly-added or newly-scheduled events;
it overwrites this file.

```jsonc
{
  "version": 1,
  "events": [
    {
      "id": "string",           // required, unique
      "title": "string",        // required
      "start": "ISO 8601",      // required
      "end": "ISO 8601",        // optional, must be >= start if present
      "location": "string",     // optional; sub-location only (see below)
      "description": "string"   // optional
    }
  ]
}
```

`location` carries only a *sub-location* — "Greenhouse", "Pavilion". The adapter strips the
farm's own name and postal address (`calendar.venue` in `settings.json`), because the display
stands at that address and printing it back says nothing; an on-site event with no sub-location
omits the field entirely. Off-site locations are passed through untouched — an event at Mills
River Park still has to say where it is.

### `content/events-exclude.json` (hand-maintained, not validated the same way)

A simple substring-match list the calendar adapter reads before writing `events.json` — recurring
internal shifts, closures, and cancelled/private entries are noise on a public-facing display even
though they're real calendar entries:

```jsonc
{
  "version": 1,
  "excludeTitleContains": [
    "FARM CLOSED",
    "Garden Group"
  ]
}
```

Any event whose title contains one of these strings (case-insensitive) is dropped, no matter how
many recurring occurrences it has. Spot something in rotation that shouldn't be public (an internal
meeting, a volunteer-only shift) — add a distinguishing substring here and re-run
`node sources/calendar/index.mjs`.

## `content/generated/gallery.json`

Written by [`sources/gallery/index.mjs`](../sources/gallery/index.mjs), which scrapes the public
VHF gallery pages and keeps only images at or above a minimum resolution (small social-media
re-posts get served as unusably small thumbnails by the CDN regardless of requested size, and are
filtered out). Re-run it any time to refresh the pool; it overwrites this file.

```jsonc
{
  "version": 1,
  "source": "vhf-gallery-scrape",
  "generatedAt": "ISO 8601",
  "photos": [
    {
      "id": "string",        // required, unique, derived from the source filename
      "src": "/content/photos/<id>.webp", // required; the local mirror after fetch-photos.mjs
                             //   has run, otherwise the gallery CDN URL
      "remoteSrc": "https://...", // present once mirrored: the gallery URL it came from
      "width": 2151,         // required, positive number, pixel width of whatever `src` points at
      "height": 1613,        // required, positive number, pixel height of the same
      "sourcePage": "https://...veteranshealingfarm.org/gallery-2025", // which gallery it came from
      "takenAt": "ISO 8601",  // best-effort: parsed from the filename if it looks like a camera
                              // timestamp (YYYYMMDD_HHMMSS), else Jan 1 of the gallery's year
      "dateSource": "filename | gallery-page-fallback"
    }
  ]
}
```

`src` and the photo files are written by [`scripts/fetch-photos.mjs`](../scripts/fetch-photos.mjs),
which runs after the adapter (`npm run sync-sources` does both). It downloads each photo once,
resizes it to what the display can actually show, and writes `content/photos/<id>.webp`. The
target is **not** the 1920x1080 panel: photos are drawn `object-fit: cover` and Ken Burns-zoomed to
`scale(1.12)`, so a full-bleed photo needs 2150 pixels across at peak zoom. Photos whose source is
already at or below that are re-encoded, never upscaled. `content/photos/` is git-ignored and
rebuilt from `remoteSrc`.

`takenAt` drives selection, not just display: the adapter samples which photos make the pool with a
strong recency bias (see `RECENCY_DECAY` in the adapter) rather than uniformly at random, so
re-running it after new gallery photos go up mostly rotates newer ones in instead of diluting them
one-in-several-hundred forever.

### `content/gallery-exclude.json` (hand-maintained, not validated the same way)

A simple list the gallery adapter reads before writing `gallery.json`:

```jsonc
{
  "version": 1,
  "excluded": [
    { "id": "photo-id", "reason": "why this shouldn't be in the auto-rotation" }
  ]
}
```

Spot a photo in the pool that needs context an unattended TV can't provide (or is otherwise a bad
fit) — add its `id` here and re-run `node sources/gallery/index.mjs`. It's excluded on every future
scrape, not just the next one.

## `content/announcements/announcements.json`

```jsonc
{
  "version": 1,
  "announcements": [
    {
      "id": "string",          // required, unique
      "title": "string",       // required
      "body": "string",        // optional
      "activation": "ISO 8601",  // optional; scene throws (is skipped) before this time
      "expiration": "ISO 8601"   // optional; scene throws (is skipped) after this time
    }
  ]
}
```

## Validation rules (what `validate-content.mjs` actually checks)

- The file is valid JSON.
- `version` is present and a number, on every file.
- Every array field documented above is present (even if empty) and is an array.
- Every item in `playlist` has `id`, `type` (one of the six known types), `duration`
  (positive number), `enabled` (boolean), and `content` (object).
- Every event/announcement/gallery photo has a unique `id` within its file.
- Any field documented above as an ISO date is parseable by `Date.parse`.
- `settings.json`'s `publishUrl` parses as a URL.

Anything not listed here (extra fields, future scene types) is left alone — the
validator checks the contract above, not the full shape of every object, so adding
a new optional field never requires touching the validator.
