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
  and shown on the television through a browser or off-the-shelf app chosen on the device.
  The page itself owns caching, content refresh, and crash recovery.
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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for full rationale.

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

0. **On the screen** — *done.* The `app/` WebView shell is the answer: fullscreen, no chrome,
   screen never sleeps, points at Netlify. `docs/DISPLAY_SETUP.md` covers sideloading and the
   television's own sleep/screensaver settings.
1. **Survives being left alone** — Service Worker (app shell + JSON + photos), self-hosted fonts,
   version polling so content actually refreshes, error/stall watchdog, diagnostics overlay,
   browser compatibility check. *This is the heart of the plan; two real gaps live here.*
2. **Repeatable publish** — `scripts/publish.mjs`: validate → build → test → deploy → verify.
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
validator, JSON cache fallback, the gallery and calendar adapters, the local admin editor, and the
live Netlify site. See [docs/BUILD_TREE.md](docs/BUILD_TREE.md) §6.

## Guiding principle

The VHF digital display is an appliance. The person standing in front of the television should
never need to know what Fire OS is, where the content comes from, how the calendar or gallery
works, how Claude Code works, or how the application is deployed. They should simply see a
polished, continuously running Veterans Healing Farm display. Turn on the television and walk away.
