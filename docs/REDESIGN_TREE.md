# VHF Display — Redesign Build Tree

Companion to [REDESIGN.md](REDESIGN.md), which argues the *why*. This file is the *shape*: what the
tree looks like when it is done, what each step adds, changes and deletes, and how you know a step
actually landed.

**Status: proposal, not built.** The live display is the one in [BUILD_TREE.md](BUILD_TREE.md).

Markers, matching BUILD_TREE.md's convention plus two:
`[x]` exists today, unchanged · `[~]` exists, changes · `[+]` new · `[–]` deleted

Step numbers `R1`–`R6` are the migration order from [REDESIGN.md](REDESIGN.md) §6.

---

## 1. Target tree

```
web/                                  the display itself
  index.html                     [~]  references hashed bundle names          R4
  src/                           [+]  modern JS; built, not shipped raw       R4
    engine.js                    [~]  moved from web/js/; logic unchanged     R4
    scenes.js                    [~]  moved; renderers unchanged              R4
    content-source.js            [~]  moved                                   R4
    diagnostics.js               [~]  moved; gains built-version readout      R4
    scale-to-fit.js              [~]  moved                                   R4
    compat.js                    [~]  shims out, capability PROBE stays       R4
    heartbeat.js                 [+]  posts to the Worker                     R1
  css/
    theme.css                    [x]
    scene.css                    [x]
    fonts.css                    [x]
  fonts/*.woff2                  [x]  self-hosted; offline must not break type
  img/register-qr*.svg           [x]
  sw.js                          [~]  hashed shell; same-origin photo cache   R2,R4

content/
  playlist.json                  [x]  hand-authored
  settings.json                  [~]  gains heartbeat endpoint + interval     R1
  announcements/announcements.json [x]
  gallery-exclude.json           [~]  keys move to content hash               R2
  gallery-focus.json             [~]  keys move to content hash               R2
  events-exclude.json            [x]
  events-time-overrides.json     [x]
  artwork/
    brand/                       [x]
    curated/<set>/               [x]  + captions.json, focus.json per set
    candidates/                  [x]  never published
  photos/                        [+]  MIRRORED originals, <sha>.webp          R2
  generated/
    gallery.json                 [~]  src points at content/photos/           R2
    events.json                  [x]
    curated-photos.json          [x]
    version.json                 [~]  gains build id for version-vs-build     R6

sources/                              PC/CI-side adapters; never on the device
  gallery/index.mjs              [~]  emits content hashes, not CDN urls      R2
  calendar/index.mjs             [x]
  calendar/text.mjs              [x]
  curated-photos/index.mjs       [x]

scripts/
  build-site.mjs                 [~]  content hashing of js/css               R4
  mirror-photos.mjs              [+]  fetch, resize, re-encode, hash          R2
  publish.mjs                    [~]  verify step reads built id, not clock   R6
  validate-content.mjs           [~]  schema for photos/ + heartbeat config   R1,R2
  sync-sources.mjs               [x]
  generate-qr.mjs                [x]
  lint-content.mjs               [x]
  detect-photo-focus.py          [x]  stays hand-run. Never wired to sync.
  generate-app-icons.py          [x]

worker/                          [+]  liveness; Cloudflare free tier          R1
  index.js                       [+]  POST /beat, GET /health, cron alert
  wrangler.toml                  [+]

app/                                  Fire TV shell, still thin
  src/main/java/.../DisplayActivity.kt [~] WebChromeClient + reload watchdog   R5
  src/main/java/.../BootReceiver.kt    [x]
  src/main/assets/offline.html         [x]  the real fallback card
  src/main/assets/web/                 [–]  DELETE: drifting second copy       R5
  src/main/res/**                      [x]

.github/workflows/
  deploy-pages.yml               [x]
  sync-content.yml               [+]  scheduled sync, replaces the PC task    R3

tests/
  engine.test.mjs                [x]
  scenes/*                       [+]  renderers become testable once bundled  R4
  sw.test.mjs                    [~]  hashed-shell + same-origin photo cases  R2,R4
  content-schema.test.mjs        [~]
  calendar-text.test.mjs         [x]
  publish.test.mjs               [x]
  qr.test.mjs                    [x]
  lint-content.test.mjs          [x]
  mirror-photos.test.mjs         [+]  hash stability, resize, re-encode       R2
  heartbeat.test.mjs             [+]  payload shape, failure is non-fatal     R1
  helpers/build-fixture.mjs      [x]
  soak/long-run.md               [x]

admin/                           [x]  unchanged; still 127.0.0.1, still no auth
docs/                            [x]
```

---

## 2. Work breakdown

### R1 — Heartbeat *(no change to the page engine)*

**Owns:** `worker/`, `web/src/heartbeat.js`, `content/settings.json`

- `[+]` Worker: `POST /beat` writes `{version, uptime, errorCount, lastError, currentScene,
  upcomingEventCount, ts}` to KV; `GET /health` returns last-seen and staleness; cron compares
  last-seen against a threshold and alerts.
- `[+]` Page: post every N minutes, reusing the counters `diagnostics.js` already keeps.
- `[~]` `settings.json`: endpoint URL and interval. No secret — the endpoint accepts only this
  shape and stores nothing personal.
- `[~]` `validate-content.mjs`: reject a malformed heartbeat block.

**A failed beat must never affect the display.** Wrap it; count it; carry on. The display's job is
to keep showing VHF, not to keep telemetry.

**Ship gate:** unplug the television's network; within the threshold, an alert arrives at a place a
human actually looks. Plug it back in; `/health` goes green without a restart.

---

### R2 — Photo mirror

**Owns:** `scripts/mirror-photos.mjs`, `content/photos/`, `sources/gallery/index.mjs`, `web/sw.js`

- `[+]` Fetch each qualifying photo at build time, resize to 1920px long edge (plus 960px), encode
  WebP, write `content/photos/<sha256-12>.webp`.
- `[~]` `gallery.json` `src` becomes the local path; `id` becomes the content hash.
- `[~]` **Migrate curation keys.** `gallery-focus.json` and `gallery-exclude.json` currently key on
  scrape ids. One-time map old id → new hash, and keep the old id as `legacyId` so the mapping is
  auditable rather than a leap of faith. This is the step that makes 86 focus entries and 9
  exclusions survive a re-upload.
- `[~]` `sw.js`: photos are same-origin now, so drop the opaque-response handling and **raise or
  remove `MAX_IMAGES`** — the cap existed only because opaque entries are charged at a padded size.

**Ship gate:** the display boots and runs a full loop with the network disconnected from cold, and
`MAX_IMAGES` no longer needs to be a guess — cache usage is measurable in `?diag=1`.

---

### R3 — Sync on CI

**Owns:** `.github/workflows/sync-content.yml`

- `[+]` Scheduled workflow: run the adapters, run `mirror-photos`, validate, commit only if the
  diff is non-empty, and let `deploy-pages.yml` publish.
- `[–]` Retire the PC scheduled task once two CI runs have succeeded unattended.
- `[~]` Reword the `CLAUDE.md` rule from "PC-side sync/authoring layer only" to **"build-side, never
  device-side"** — see REDESIGN.md §4 Layer 3. Amend the rule; do not silently break it.

**Ship gate:** a week passes with the developer's PC switched off and the calendar still current.

> Determinism is a prerequisite and is already done (commit `f2a9a15`): the adapters now produce
> byte-identical output from unchanged sources, so "commit only if non-empty" is a real test rather
> than one that fires every run.

---

### R4 — Build step, hashed assets, retire ES5

**Owns:** `web/src/`, `scripts/build-site.mjs`, `web/index.html`, `web/sw.js`

- `[+]` esbuild: one JS bundle, one CSS file, content-hashed names.
- `[~]` Move `web/js/*` to `web/src/`. **Logic unchanged in this step** — this is a packaging
  change, and mixing a rewrite into it would make a regression impossible to attribute.
- `[~]` `compat.js`: the shims are moot under Chromium 138; the **capability probe stays**, because
  it is what tells us a future device is different.
- `[~]` `sw.js`: hashed filenames mean a new build cannot be served stale.

**Gate before starting:** a feature probe rendered *on the television* confirms the engine. The
`adb` version string is evidence, not proof, and a blank display in a public building is the cost of
being wrong.

**Ship gate:** publish a visible CSS change and see it on the panel inside one poll interval, with
no second reload and no app restart.

---

### R5 — Shell

**Owns:** `app/src/main/java/.../DisplayActivity.kt`, `app/src/main/assets/`

- `[~]` `WebChromeClient` override so page console reaches `logcat`. This is what unblocks
  publish-loop verification, currently recorded as blocked for exactly this reason.
- `[~]` Reload watchdog: the page stamps a timestamp; if it stops advancing, reload the WebView.
- `[–]` **Delete `app/src/main/assets/web/`.** It is a partial, drifting copy of the app
  (`index.html` + one stylesheet). `offline.html` is the real fallback and stays.

**Ship gate:** `adb logcat` shows the page's version line after a publish, and killing the page
process gets it back without human intervention.

---

### R6 — Honest freshness and honest failure

**Owns:** `web/src/engine.js`, `content/generated/version.json`, `scripts/publish.mjs`

- `[~]` Compare the polled version against the **version baked into the build**, not the first
  polled value, so a page that loads already-stale reloads immediately.
- `[+]` Famine card: at zero upcoming events, show a designed card and report it in the heartbeat,
  instead of silently skipping every event scene.
- `[~]` `publish.mjs` verifies against the built id.

**Ship gate:** set the event window to zero in a fixture; the display shows the card and the
heartbeat reports `upcomingEventCount: 0`.

---

## 3. What gets deleted

| Path | Why it is safe |
|---|---|
| `app/src/main/assets/web/` | A two-file partial copy that never updates itself. `offline.html` remains the genuine fallback, and the Service Worker is the real offline story. |
| `MAX_IMAGES` cap (as a guess) | Only existed because opaque cross-origin entries are charged at a padded size. Same-origin photos make it measurable. |
| ES5 constraint | Rests on an inference the device disproves — but delete it only after an on-device probe. |
| PC scheduled sync task | Superseded by R3, and only after two unattended CI runs. |

---

## 4. Warts the tree surfaced

Small, real, unrelated to the redesign — worth fixing whenever the files are next touched:

- **`scripts/__pycache__/detect-photo-focus.cpython-311.pyc` is tracked.** Compiled Python bytecode
  committed to the repo. Should be git-ignored and removed.
- **`.gitkeep` files persist in populated directories** — `scripts/`, `sources/gallery/`,
  `sources/calendar/`, `tests/`. Harmless, now meaningless.
- **`netlify.toml` still sits at the repo root** while `netlify-retired/` holds the retirement plan
  that cannot be deployed. The root file implies a live host that is not live.

---

## 5. Untouched, on purpose

`admin/` (still localhost-only, still no auth — that is M5's problem, not this tree's), the content
schema, `detect-photo-focus.py`'s hand-run status, the curated-artwork convention, quiet hours,
burn-in drift, and every defensive guard in the engine. The redesign changes how code is packaged,
where photos come from and where the pipeline runs. It does not change what the display *does*,
because that part works.
