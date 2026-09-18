# Source adapters

A **source adapter** is a small PC-side script under `sources/` that pulls content from somewhere
outside this repo and writes it into `content/generated/*.json`. Adapters are how the project keeps
its promise that "VHF staff must never have to manually update events" (CLAUDE.md) without ever
having the television itself reach out to a third party.

## Where the boundary is

- **PC-side only.** Adapters run on the developer's machine (by hand, via `scripts/sync-sources.mjs`,
  or from a scheduled task/skill). The invariant in `docs/BUILD_TREE.md` §3 — "the display talks to
  exactly two hosts: `publishUrl` and the Squarespace CDN" — is enforced by never letting `web/`
  import from `sources/`, and by adapters existing at all: the fetch to the calendar/gallery/etc.
  happens once, on the PC, at sync time, not once per television per page load.
- **`web/` never imports from `sources/` or `scripts/`.** The renderer only reads JSON out of
  `content/` (locally, in dev) or the Cache Storage API (on the device). An adapter that scene code
  imported directly would smuggle a third host into the display's runtime.
- **`content/generated/` is write-only for adapters and read-only for humans.** Nothing under it is
  hand-edited; a human wanting to change what ends up there edits an exclude list or a setting
  upstream of the adapter and re-runs it. The generated files still have to satisfy the schemas in
  `docs/CONTENT_SCHEMA.md` — the validator doesn't care whether a file was hand-written or generated.

## The contract

Every adapter in this project follows the same shape, and a new one should too:

1. **Read one external source.** Something the farm owns outright (its own website, its own public
   Google Calendar) or that is genuinely public with no authentication — never a source that
   requires a secret to be embedded anywhere, since nothing the display loads may carry credentials.
2. **Filter for quality where that applies.** The gallery adapter drops undersized thumbnails; a
   future adapter for a different source would apply whatever equivalent quality gate makes sense
   for that source.
3. **Apply a hand-maintained exclude list from `content/`.** `content/gallery-exclude.json` and
   `content/events-exclude.json` are how a human keeps something out of rotation without touching
   code. A new adapter should read its own exclude file the same way rather than inventing a
   different curation mechanism.
4. **Write exactly one file to `content/generated/`.** One adapter, one output file, matching a
   schema documented in `docs/CONTENT_SCHEMA.md`.
5. **Be safely re-runnable.** Re-running an adapter should never require manual cleanup first —
   it fully regenerates its output file each time from the current state of its source and the
   current exclude list. Nothing accumulates across runs that a human has to prune by hand.

## The two adapters that exist

- **`sources/gallery/index.mjs`** — scrapes the farm's own public Squarespace gallery pages (no
  auth, the farm's own site), filters out sub-1200px thumbnails, applies
  `content/gallery-exclude.json`, and writes a recency-weighted 120-photo pool to
  `content/generated/gallery.json`. Full detail, including the recency-weighting rationale, is in
  `docs/BUILD_TREE.md` §6 ("Gallery adapter").
- **`sources/calendar/index.mjs`** — fetches the farm's own public Google Calendar ICS feed (no API
  key; a public calendar's `.../public/basic.ics` URL), expands recurring series, applies
  `content/events-exclude.json`, and writes `content/generated/events.json`. Full detail is in
  `docs/BUILD_TREE.md` §6 ("Calendar adapter").

Both read a source the farm fully controls or that is genuinely public with no login. That is the
bar the Instagram question failed.

## The Instagram decision

**Decision: don't build `sources/instagram/index.mjs`.** No adapter exists, `sources/instagram/`
has been removed, and none is planned unless the conditions below change.

**Why it fails the same bar the two working adapters clear:**

- **Scraping a public Instagram profile violates Meta's Terms of Service.** Meta's Platform Terms
  and Instagram's own Terms of Use prohibit automated data collection ("scraping") from the
  platform outside of the sanctioned APIs, regardless of whether the profile itself is public. This
  is the opposite of the gallery and calendar sources, which are scraped/fetched precisely because
  the farm owns the site and calendar and there is no ToS standing in the way.
- **The sanctioned alternative — the Instagram Graph API — is not a "read public posts" endpoint
  like the calendar's ICS feed.** It requires the account be converted to a Business or Creator
  account, a registered Meta developer app, and for any use beyond the developer's own test users,
  **App Review** — an ongoing approval process Meta can re-require after policy or API version
  changes. That is a standing maintenance burden (an app to keep registered, a review to keep
  passing, credentials to keep valid) fundamentally unlike the zero-maintenance, no-auth, no-secret
  pattern every other part of this display follows, and it is exactly the kind of thing CLAUDE.md's
  "require zero interaction from VHF staff" and "no credentials embedded in anything" rules are
  written to keep out.
- **It would buy little.** The display already has a photo carousel — the gallery adapter's
  recency-weighted `photo-pool` scenes — sourced from photos the farm already controls and already
  posts to its own website. An Instagram feed would be a second, harder-to-maintain path to
  substantially the same outcome (photos of farm activity on the display).

**Under what conditions this could be revisited:** if Meta ever ships a genuinely low-friction,
read-only mode for an owned public profile's own media that needs no ongoing app review and no
long-lived credential embedded anywhere sensitive — i.e. something that matches the calendar
adapter's "public URL, no key, no review process" shape — the trade would be worth re-running. As of
this writing (September 2026) no such mode exists; the Graph API's review and Business-account
requirements are a standing cost, not a one-time setup step.
