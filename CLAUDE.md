# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# VHF Fire TV Digital Display

## Mission

Build a dedicated digital display for Veterans Healing Farm (VHF), shown on an existing Fire TV
television. The application turns that television into a completely unattended VHF digital
information display.

The display should:

* launch directly into the VHF presentation
* operate fullscreen
* rotate visual scenes automatically
* display VHF photographs
* display upcoming VHF events
* display custom artwork
* display announcements and information
* cache content locally
* continue operating if the network disappears
* automatically recover from errors
* require essentially zero interaction from VHF staff

The application is not a generic digital signage CMS.
It is a purpose-built VHF display appliance.

## Fundamental architecture

The most important architectural rule:

**The PC development project is the source of truth. The television is the deployed runtime.**

Claude Code runs on the developer's PC and may modify: display configuration, playlist, artwork,
content, scene definitions, application code. The television receives a published version and runs
it independently. The television must NOT depend on the developer's PC remaining online.

## Confirmed platform decisions

- **Device:** Fire TV Edition television — a TV with Fire TV built in (Fire OS 7, Android 9 /
  API 28-based).
- **Runtime:** the display is a **web page** — HTML/CSS/JS in `web/`, published as a static site
  and shown on the television by the `app/` shell (below). The page itself owns caching, content
  refresh, and crash recovery; the shell owns only what a page cannot do for itself.
- **Publish transport:** a GitHub Pages static site (`hambats.github.io/vhf-firetv-display`) is
  the PC → television publish endpoint. A push to the repo's `main` branch triggers a GitHub
  Actions workflow ([.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml)) that
  builds and republishes automatically — free, no deploy-credit limit. (Netlify was the original
  host; it was dropped 2026-09-18 after its free-tier deploy credits ran out mid-development. The
  Netlify project is left in place as a dormant fallback, not actively used.) The page polls a
  fixed URL for a version manifest and caches content locally. No credentials are ever embedded in
  anything the television loads.
- **The native Fire TV app (`app/`) is active again (Sept 2026).** It is a thin Kotlin WebView
  appliance shell that loads the published site fullscreen: it keeps the screen awake, hides all
  system chrome, blocks the remote from navigating away, retries after a network outage, and
  relaunches on boot where Fire OS permits. It owns *only* what a web page cannot do for itself —
  the scene engine, caching and content refresh stay in `web/`. Content changes never require a
  rebuild — only a change of publish endpoint does. Install steps:
  [docs/DISPLAY_SETUP.md](docs/DISPLAY_SETUP.md).
- **The television is reachable from anywhere (Sept 19).** It runs Tailscale with always-on VPN, so
  `adb connect 100.69.183.1:5555` works off-site — installs, screenshots, logcat. This is *access,
  not awareness*: nothing yet notices a dead display. See
  [docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full rationale.

## Commands

Requires Node 18+ and npm; the Android toolchain below is only needed for `app/` changes.

```bash
npm run preview         # validate content, build dist/, serve at localhost:8080 (add ?diag=1 for the diagnostics overlay)
npm test                # node --test tests/*.test.mjs
node --test tests/engine.test.mjs   # run a single test file
npm run validate-content
npm run sync-sources    # re-scrape gallery + re-fetch calendar into content/generated/ (never hand-edit that dir)
npm run admin           # local content editor at http://127.0.0.1:8787, no auth — do not expose beyond localhost
npm run publish         # the ONLY supported publish path: validate → build → test → commit → push → poll version.json until live
npm run publish -- --dry-run       # everything except commit/push
npm run publish -- --verify-only   # just check the currently live version
```

Building the Fire TV shell (`app/`, rarely needed — see [docs/BUILD_TREE.md](docs/BUILD_TREE.md) §5):

```bash
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleDebug
```

APK lands at `app/build/outputs/apk/debug/app-debug.apk`. Needs Android SDK Platform 34 + JDK 17+;
the Gradle wrapper is at the repo root, not inside `app/`. There is no linter for JS or Kotlin in
this repo — `scripts/lint-content.mjs` is a content-appropriateness advisory check (always exits 0),
not a code style tool.

## Code architecture

- **`web/`** — the display itself, loaded by both the browser preview and the `app/` WebView. Load
  order in `index.html`: `diagnostics.js` → `compat.js` → `scenes.js` → `scale-to-fit.js` →
  `content-source.js` → `engine.js`, then the Service Worker registers.
  - `js/engine.js` — the playlist scheduler: crossfades, preloads one dwell ahead, quiet-hours /
    black-screen logic, a stall watchdog, a 6-hour periodic reload, and content-version polling.
  - `js/scenes.js` — pure render functions, one per scene type (photo, photo-pool, event,
    information, announcement...); tracks and skips images that fail to load. Written in ES5
    because it is also bundled unmodified into the `app/` WebView shell.
  - `js/content-source.js` — the single cache-vs-network policy for content JSON (network-first,
    cache-fallback); feeds the `?diag=1` overlay counters.
  - `sw.js` — Service Worker; owns the app-shell and image caches only (a capped cache for remote
    gallery photos, an uncapped one for local artwork) — content JSON caching is
    `content-source.js`'s job, not the SW's. `BUILD`/`SHELL` constants are rewritten by
    `build-site.mjs` at publish time. Also ES5-only for the same Fire OS 7 WebView reason.
  - `js/compat.js`, `scale-to-fit.js`, `diagnostics.js` — browser-compat shims, 16:9 scale-to-fit
    for arbitrary screen sizes, and the `?diag=1` overlay.
  - Fonts are self-hosted under `css/`/`fonts/` — no external font CDN, since offline must not
    break rendering.
- **`scripts/`** (Node ESM, `.mjs`) — `build-site.mjs` (validates then copies `web/` + the
  publishable subset of `content/`, per the `PUBLISHED_CONTENT` allowlist, into `dist/`;
  `validate-content.mjs` (schema validator against [docs/CONTENT_SCHEMA.md](docs/CONTENT_SCHEMA.md),
  exports `validateContentDir`, reused by build, admin, and tests); `sync-sources.mjs` (PC-side
  gallery/calendar adapters, writes only to `content/generated/`); `publish.mjs` (the single publish
  transport — see Commands above); `generate-qr.mjs` (registration QR SVGs from
  `content/settings.json`); `detect-photo-focus.py` and `generate-app-icons.py` (one-off Python
  helpers, not part of the normal build).
- **`content/`** — the source of truth for what the display shows. `playlist.json` and
  `settings.json` are hand-authored; `generated/*.json` (gallery, events, curated-photos) is
  machine-written by `sync-sources.mjs` and never hand-edited; `gallery-exclude.json`,
  `gallery-focus.json`, `events-exclude.json`, `events-time-overrides.json` are PC-side curation
  notes that stay off the published site; `artwork/curated/` vs `artwork/candidates/` — only
  `curated/` gets published.
- **`admin/`** — `server.mjs`, a small dependency-free Node HTTP server bound to `127.0.0.1:8787`
  only, no auth. Reads/writes `content/*.json` through the same `validateContentDir` the build uses,
  so a rejected write restores the previous file rather than producing a broken deploy.
- **`app/`** — Kotlin/Android WebView shell. Two source files only: `DisplayActivity.kt`
  (fullscreen WebView, screen-on, immersive chrome, remote/back-key lockout) and `BootReceiver.kt`
  (relaunch on `BOOT_COMPLETED`). `app/src/main/assets/web/` is a **bundled offline copy** of
  `web/` used as a fallback — it does not update itself and can drift from the live site; treat the
  root `web/` as the one to edit.
- **`tests/`** — `node --test`, no external test framework. Each `*.test.mjs` file has a
  `Run with: node --test tests/<file>.test.mjs` header comment. `helpers/build-fixture.mjs` builds
  a throwaway fixture tree so build/publish tests can corrupt content without touching the real
  `content/`. `engine.js`/`sw.js` have no exports or build step — tests load them into a Node `vm`
  context with a hand-rolled fake clock and faked `fetch`/timers, not real ones.

## Do NOT

* build a generic digital signage SaaS
* introduce a database without a concrete need (versioned JSON files are the content format)
* require YouTube Live, a 24/7 PC, or a Raspberry Pi
* require anyone to *operate* a browser — opening the display once is setup; VHF staff must never
  have to drive it, type a URL, or refresh it as part of normal use
* make VHF staff manually update events
* scrape websites, the calendar, or Instagram directly from the television (PC-side
  sync/authoring layer only)
* hardcode event information or credentials
* require a reinstall or device reconfiguration for a content-only change
* move scene, content, caching or refresh logic into `app/` — the shell stays thin
* over-engineer multi-display support in version 1

## Milestones

Ordered by risk — what keeps an unattended page alive — not by feature layer. Full detail,
including ship gates, in [docs/BUILD_TREE.md](docs/BUILD_TREE.md).

0. **On the screen** — *done (Sept 18–19).* The `app/` WebView shell is the answer: fullscreen,
   no chrome, screen never sleeps, points at GitHub Pages. v1.1.0 is installed on the television.
   `docs/DISPLAY_SETUP.md` covers sideloading and the television's own sleep/screensaver settings.
1. **Survives being left alone** — Service Worker (app shell + JSON + photos), self-hosted fonts,
   version polling so content actually refreshes, error/stall watchdog, diagnostics overlay,
   browser compatibility check. *This is the heart of the plan; two real gaps live here.*
2. **Repeatable publish** — *done (Sept 20).* `scripts/publish.mjs`: validate → build → test →
   commit → push → verify, ending by polling the live version manifest until it advances, because
   a push only *starts* a GitHub Pages deploy. Covered by `tests/publish.test.mjs`.
3. **Proof it lasts** — 72-hour unattended run, then `RUNBOOK.md` and `RELIABILITY.md` written
   from what actually broke.
4. **Content that maintains itself** — quiet hours, burn-in review, the Instagram decision,
   ongoing exclude-list curation.
5. **Administration** — publish button and version display in `admin/`; auth before it ever
   leaves 127.0.0.1.

How the display **looks** is a separate track: [docs/DESIGN_REVIEW.md](docs/DESIGN_REVIEW.md) is
the critique, [docs/DESIGN_PLAN.md](docs/DESIGN_PLAN.md) is the plan (D0–D5). It runs in parallel
with the milestones above and shares almost no files. **D0 is live on the public display and should
ship regardless of what else is happening.**

Already built and current: the scene engine and all scene types, the content schema and its
validator, JSON cache fallback, the gallery and calendar adapters, the local admin editor, the live
GitHub Pages site, the `app/` shell installed on the television, off-site access to that television
([docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md)), registration QR codes with per-event overrides,
face-aware photo cropping, and the portrait fill treatment.

**Start at the "State of play" section at the top of [docs/BUILD_TREE.md](docs/BUILD_TREE.md)** —
it carries what was tried, what is blocked and why, which is the part that saves time. §6 lists
what exists.

## Guiding principle

The VHF digital display is an appliance. The person standing in front of the television should
never need to know what Fire OS is, where the content comes from, how the calendar or gallery
works, how Claude Code works, or how the application is deployed. They should simply see a
polished, continuously running Veterans Healing Farm display. Turn on the television and walk away.
