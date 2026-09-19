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
| `photo-pool`     | —                               | picks a random photo from `content/generated/gallery.json` (or a curated set, via `content.source`) each time it comes up in rotation; a photo entry there may carry its own `focus` (object-position override), `zoom` (<1 eases a too-tight cover crop, e.g. `0.9`), or `pan` (`{ x, y }` CSS translate override for the Ken Burns drift direction — default drifts up-left; positive `y` drifts down, e.g. `{ y: "2.5%" }`, toward a subject sitting low in frame) |
| `custom`         | `src`                          | full 16:9 artwork, no overlay |
| `event`          | `eventId` OR `title`+`start`   | looked up from `content/generated/events.json` by id, or inline |
| `event-pool`     | —                               | picks one upcoming event (full detail, same layout as `event`) each time it comes up in rotation, cycling through all of them before repeating — put a few of these in the playlist instead of one big list so each event gets its own screen |
| `events`         | —                               | `limit` optional (default 5), `offset` optional (default 0), `eyebrow` optional; renders a list of the next N upcoming from `events.json` starting after `offset` — kept for admin/manual use, the playlist itself now prefers `event-pool` |

## `content/settings.json`

```jsonc
{
  "version": 1,
  "syncIntervalMinutes": 20,   // positive number, required — how often the display re-checks
                               //   content/version.json and reloads if it changed
  "timezone": "America/New_York", // required, valid IANA zone name
  "publishUrl": "https://...", // required, must be a valid absolute URL
  "gallery": {                 // optional; read by sources/gallery/index.mjs, editable via admin/
    "maxPhotos": 120,          // optional, positive number, default 120
    "minDimension": 1200,      // optional, positive number, default 1200
    "recencyDecay": 35         // optional, positive number, default 35 (smaller = more recency bias)
  },
  "calendar": {                 // optional; read by sources/calendar/index.mjs
    "calendarId": "...@gmail.com", // optional, default "vhf2023calendar@gmail.com"
    "windowDays": 120             // optional, positive number, default 120
  }
}
```

**`timezone` is required, not defaulted.** `events.json` stores UTC, and the display formats every
event time through this zone rather than the television's own clock setting. A wrong or reset TV
time zone would otherwise shift every event by a fixed offset and push a late-evening event onto
the wrong day — with nothing on screen looking wrong. A default applied at render time would
recreate that silently, so its absence is a build error instead.

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
      "location": "string",     // optional
      "description": "string"   // optional
    }
  ]
}
```

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
      "src": "https://...",  // required, absolute URL (direct link to the gallery CDN)
      "width": 2500,         // required, positive number, actual source pixel width
      "height": 1875,        // required, positive number, actual source pixel height
      "sourcePage": "https://...veteranshealingfarm.org/gallery-2025", // which gallery it came from
      "takenAt": "ISO 8601",  // best-effort: parsed from the filename if it looks like a camera
                              // timestamp (YYYYMMDD_HHMMSS), else Jan 1 of the gallery's year
      "dateSource": "filename | gallery-page-fallback"
    }
  ]
}
```

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
