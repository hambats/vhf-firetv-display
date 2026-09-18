# VHF Fire TV Display — Build Tree

The planned shape of the project from here. Markers: `[x]` exists · `[~]` partial/stub ·
`[ ]` not written · `[–]` dormant, deliberately not being worked on.
(`app/` carried `[–]` until Sept 18, 2026; it is active again — see §5.)

Milestone numbers (M0–M5) refer to §1 below and to the milestone list in
[../CLAUDE.md](../CLAUDE.md). Nothing here changes the architecture rule: **the PC project is
the source of truth; the display is a runtime that must keep working with the PC switched off.**

> **Revision note (Sept 2026).** This replaces the original phase-ordered tree (Phases 1–7).
> §0 explains why. §6 carries forward everything the old tree recorded about what's already
> built — those decisions and curation workflows are still current.

## 0. What changed

Two things, and the second one is the bigger deal.

**The work went lopsided.** The original tree was ordered by feature phase (1 shell → 7 admin).
Actual progress: the web renderer, content schema, validation, JSON cache, gallery and calendar
adapters, and even the Phase-7 admin UI are all built, and the site is live at
`hambats.github.io/vhf-firetv-display`. The Fire TV app was still Phase 1 and had never been installed
on the television.

**The native app is out of scope.** The display will be shown on the Fire TV in the building
through some browser or off-the-shelf app, not through a custom Android build. `app/` is dormant —
kept, not deleted, not worked on.

> **Superseded (Sept 18, 2026).** Keeping it paid off: `app/` came back as a thin WebView shell
> around the same published site, which is what closed M0. The table below still holds — the
> behaviours listed under "Now has to be" stayed in `web/`; the shell only added the two rows the
> page could never own. See §5.

That is a legitimate call, and it is not a downgrade of the mission. But it relocates work rather
than deleting it. Everything the Kotlin side was going to do still has to happen, and now it has
to happen inside a web page:

| Appliance behaviour | Was going to be | Now has to be |
|---|---|---|
| Works with the network down | `ContentCache.kt` | **Service Worker** (`web/sw.js`) |
| Picks up new content | `VersionPoller.kt` | **version poll in `engine.js`** |
| Recovers from a crash/stall | `WatchdogService.kt` | **JS watchdog + periodic self-reload** |
| Comes back after power loss | `BootReceiver.kt` | **device config — and partly unsolvable** |
| Screen stays on | `FLAG_KEEP_SCREEN_ON` | **device config** (TV sleep/screensaver settings) |

The last two can't be fully solved from a web page. That's an honest limitation of this path, and
§5 states exactly what it costs.

**So this tree is ordered by what keeps the page alive unattended, and the two bottom rows of that
table become setup instructions and a runbook instead of code.**

---

## 1. Milestones

### M0 — On the screen

Device-side. No code in this repo except the doc.

- [ ] pick the browser/app on the Fire TV. What actually matters, in priority order:
      1. can be made **fullscreen with no chrome** (an address bar on a 24/7 display is the tell)
      2. **opens to a set homepage** — so recovery after a power cut is one button, not typing a URL
      3. doesn't nag (update prompts, cookie bars, "sign in" interstitials)
      4. recent enough Chromium to run a Service Worker
      5. bonus, if any option offers it: **auto-start on boot** — that alone gets most of the way
         to unattended, and is the single most valuable property to shop for (see §5)
- [ ] a shorter URL to type on a remote. `hambats.github.io/vhf-firetv-display` is painful on a D-pad;
      a Netlify custom domain or a short redirect makes first setup and recovery much easier
- [ ] turn off the TV's screensaver / sleep / auto-power-down, and note every setting changed
- [ ] `docs/DISPLAY_SETUP.md` [ ] — the whole device procedure, written for someone who is not you

**Ship gate:** the display is on the wall and running.

### M1 — The page survives being left alone *(the heart of this plan)*

The page has two gaps that only show up after it has been running a while — neither is visible in
a five-minute preview:

- **`engine.js` loads content once at startup and then loops forever.** A page opened Monday is
  still showing Monday's events on Friday. With no native poller, nothing ever updates it.
- **There is no Service Worker, so `content-source.js` caching doesn't actually buy offline.**
  It caches the JSON, but if the browser is closed and reopened while the network is down,
  `index.html`, the CSS and the JS can't load at all and the page is blank. The cached JSON is
  unreachable behind a shell that never boots.

Fixing these is most of what's left.

- [ ] `web/sw.js` — cache the app shell (HTML/CSS/JS), the content JSON, **and the photos**.
      Gallery images are cross-origin (Squarespace CDN), so they cache as opaque `no-cors`
      responses: they render fine, they just can't be inspected and they cost more quota. Cap the
      image cache and evict oldest. **This closes the photo tradeoff recorded in §6 without any
      native code** — authoring still pastes gallery URLs, the display still runs with the network
      down.
- [ ] **self-host the fonts.** `index.html` pulls Epilogue and Work Sans from Google Fonts. Offline
      that silently falls back to system fonts and the display visibly stops looking like VHF.
- [ ] **version poll** — re-fetch `content/version.json` on `syncIntervalMinutes`; when it changes,
      reload at a scene boundary so the swap is invisible. The manifest already exists and already
      carries a timestamp; nothing new to publish.
- [~] **watchdog** — `window.onerror` and `unhandledrejection` handlers, a stall detector (no scene
      advance in 3× the expected duration), and a periodic full reload (every few hours, at a
      crossfade) to clear any slow leak. A `setTimeout` chain running for weeks is the part most
      likely to quietly drift or die.
      *Partly done (Sept 18).* `engine.js` now guarantees the loop stays armed: exactly one
      reschedule per tick, armed before anything that can throw, plus a backstop timer if the
      scene never resolves. That closes the case where one thrown scene ended the loop
      permanently — verified by fault injection against the pre-fix build, which froze on a
      single throw and stayed frozen after the fault was removed. **Still missing: the global
      error handlers, a stall detector that can see the loop dying some *other* way, and the
      periodic reload.** The loop can now only be stopped from outside itself, which is exactly
      what a stall detector is for.
- [ ] `web/js/diagnostics.js` — `?diag=1` overlay: uptime, last successful sync, content version,
      cache hit/miss, last error. The `#diag` element and the `?diag=1` switch already exist in
      `index.html` and `engine.js`; this makes them useful.
- [ ] **pin the display timezone.** `events.json` stores UTC; `scenes.js` formats with
      `getHours()`, i.e. whatever the television believes local time is. If the TV's timezone is
      wrong or resets, every event time on the display is wrong by a fixed offset and a
      late-evening event lands on the wrong day — with no visible symptom, because nobody checks
      a television's clock settings. Format through `toLocaleTimeString` with an explicit
      `America/New_York`, read from a new `timezone` key in `settings.json` rather than
      hardcoded. Fold the `Intl` timezone support check into the compat check below.
- [ ] **browser compat check** against whatever M0 picks — Service Worker, Cache Storage, ES5-vs-ES6
      in `scenes.js`, CSS custom properties. Silk on Fire OS 7 is an older Chromium than the dev
      machine. Cheap to check once, expensive to discover in week three.
- [x] **image preloading** (Sept 18 — not in the original plan, found in review). Scenes set
      `img.src` and went straight into the crossfade, so the fade revealed an empty frame while a
      2500px gallery photo downloaded, and a dead URL rendered as a blank rectangle for the full
      dwell every time the shuffle bag came back to it, with nothing logged. Scenes are now built
      and warmed off-DOM one dwell ahead and shown only once they can paint; failed images are
      hidden and their URLs struck from the rotation for the rest of the run. Measured: content
      images already loaded at the instant of paint went from 0/3 and 0/2 to 3/3 and 2/2.
      **Complementary to `sw.js`, not a substitute** — preloading warms an image seconds ahead
      within a session; the Service Worker is what survives a restart.

**Ship gate:** pull the router. Close the browser. Reopen it. The display still plays, photos
included. Leave it a week; it's showing this week's events.

### M2 — Repeatable publish

Hand-running `netlify deploy --prod` is the one step still living in a human's memory.
[SCHEDULED_CONTENT_UPDATE.md](SCHEDULED_CONTENT_UPDATE.md) and the two project skills encode the
sequence; this makes it atomic.

- [ ] `scripts/publish.mjs` — validate → build → test → deploy → re-fetch `/content/version.json`
      and assert the version advanced
- [ ] `tests/publish.test.mjs` — invalid content never reaches `dist/`
- [ ] `tests/engine.test.mjs` — a throwing scene is skipped and the loop advances (still unwritten
      from the old Phase 2, and it matters more now that nothing native restarts the page)
- [ ] `npm run publish`; skills and the scheduled task call it instead of a step list
- [ ] **stop publishing the curation files.** `build-site.mjs` copies all of `content/` into
      `dist/`, so `gallery-exclude.json` and `events-exclude.json` land on the public site —
      including the free-text `reason` recording why each photo was pulled from rotation. The
      display reads neither. Copy only the files the viewer actually fetches.
- [ ] `scripts/lint-content.mjs` — **a display-appropriateness linter, distinct from the schema
      validator.** `validate-content.mjs` answers "is this well-formed?"; nothing answers "is this
      fit to put on a television?" Run it as a warning inside `publish.mjs`. Rules worth having,
      each drawn from something currently live on the display: literal markdown emphasis (`**`)
      surviving into rendered text; ALL-CAPS runs over ~20 characters; a description that is
      entirely administrative boilerplate; a description truncated mid-word; the farm's own
      postal address in a `location`; an enabled announcement slot with an empty announcement
      pool; a photo pool below some floor.

### M3 — Proof it lasts, and a runbook

- [ ] 72-hour unattended run on the actual TV, `?diag=1` on for the first day
- [ ] `docs/RUNBOOK.md` [ ] — written *from what actually broke*, for VHF staff: display is blank,
      display is stale, display is showing an error, power came back and the screen is on the home
      screen. One short recovery procedure each.
- [ ] `docs/RELIABILITY.md` [ ] — failure modes and which mechanism handles each, including the
      ones nothing handles

### M4 — Content that maintains itself

- [ ] **quiet hours** (still TODO from the old Phase 3) — with no native app, this becomes a black
      scene on a schedule rather than a panel power-down. Worth doing anyway: it cuts burn-in risk
      and stops an empty building glowing all night.
- [ ] **burn-in review** — a fixed logo or header in the same pixels 24/7 on an LCD for months is a
      real risk. Check `scene.css` for anything that never moves, and nudge static chrome.
- [ ] decide Instagram: current Meta terms may make it not worth doing. **Write the decision down
      and close it out** rather than leaving `sources/instagram/` an empty directory.
- [ ] **quiet hours need an input the repo does not have yet:** the farm's open hours. Add an
      `hours` block to `settings.json` when starting this, so M4 is a rendering change rather
      than a data-modelling exercise done under time pressure.
- [ ] **trim event `location`.** Every synced event carries "Veterans Healing Farm, 138 Kimzey
      Rd, Mills River, NC 28759, USA", rendered on a screen standing at that address.
      `cleanLocation` should drop the farm's own address and keep only a sub-location
      ("Greenhouse", "Pavilion"), falling back to omitting the line.
- [ ] **strip markdown emphasis in `cleanText`.** `stripHtml` removes tags and entities but
      nothing removes `**`/`__`, so a calendar entry's emphasis renders as literal asterisks on
      the wall. Unlike the wording itself, this one cannot be fixed by the calendar authors.
      *(The wording — descriptions that lead with cancellation-fee boilerplate — was raised in
      the Sept 18 review and deliberately left alone: the calendar authors will fix it at source.
      Only the code artefact is tracked here.)*
- [ ] **drop `registrationUrl` from `events.json`.** Generated, never rendered, and identical
      across every event (a generic regpack builder link), so it carries no information even if
      something did render it. Remove it, or replace it with something a pointer-less display can
      actually use.
- [ ] **rebalance the loop.** 31 enabled items, 5m42s per cycle, **15 `information` text slides
      against 9 `photo-pool`**. Roughly half the airtime is a reader-mode text card on a screen
      most people walk past, while the photos — the thing that reads at a glance, and the thing
      VHF has 120 of — get less. Belongs to the design track as much as to this one.
- [ ] exclude-list curation is ongoing, not a one-time cleanup — see §6.
- [ ] **`gallery-exclude.json` is keyed on a lossy id.** `idFromUrl` truncates to 60 characters,
      so an exclusion is fragile against a Squarespace filename change — a photo removed from
      rotation for a good reason can silently come back. Key on the full URL.

### M5 — Admin reaches the display

- [ ] a publish button that calls `publish.mjs`
- [ ] display status. Without a native app the honest version is modest: show the live
      `version.json` and when it was published, so staff can tell whether the TV *should* be current.
      A real heartbeat would need the page to POST somewhere, which needs a server that isn't
      Netlify static — probably not worth it. Say so in the doc rather than leaving it as a TODO.
- [ ] auth before `admin/` ever leaves 127.0.0.1 — or a written decision that it never does
- [ ] **`Origin`/`Host` check on the admin API, independent of that decision.** Binding to
      127.0.0.1 stops the network reaching it; it does not stop a web page open in a browser on
      the same machine from firing a cross-origin POST at `/api/deploy`, which runs
      `netlify deploy --prod`. The browser blocks reading the response; the deploy still happens.
      DNS-rebinding reaches it too. Four lines, and worth having before the auth discussion.
- [ ] **tighten the static-file guard.** `serveStatic` checks `filePath.startsWith(__dirname)`,
      which also passes for a sibling directory whose name merely starts with `admin`. Use
      `path.relative` and reject `..` or absolute results.

---

## 1a. Two recorded decisions worth re-opening

Both are already decided in this document. Neither is being changed unilaterally — they are
flagged because the reasoning rests on a premise that looks shakier on a second read, and a
decision is cheaper to revisit now than after M3.

**1. `scripts/fetch-photos.mjs`, dropped on the grounds that "sw.js makes a PC-side photo mirror
pointless."** The Service Worker does cache the photos, so the offline claim holds. But a mirror
buys four things it does not:

- Cross-origin images cache as **opaque** responses: they cannot be inspected, a failure cannot be
  told from a success, and they are charged against quota at a padded size rather than their real
  one.
- It does nothing for a **cold start**. The first run after a cache eviction still depends on the
  Squarespace CDN being reachable at render time.
- It does not protect against **the URL dying**. A mirror turns "the gallery object was deleted"
  into a build-time error on the PC instead of a skipped scene on the wall.
- Photos are fetched at `?format=2500w` and shown on a 1920px panel. Resizing once at publish time
  cuts the bytes several-fold, permanently, for every device.

It also collapses the "display talks to exactly two hosts" invariant in §3 down to one. Cost is
roughly 40 lines in the build, plus disk. **Decision needed: keep it dropped, or reinstate it as
an M2 item.**

**2. "A real heartbeat would need a server that isn't Netlify static — probably not worth it."**
The premise is not quite right: Netlify Functions run on the same free plan already hosting the
site, so a page POSTing a timestamp every few minutes needs no new infrastructure and no new host.
The reason to want one is this project's own logic: the display is built so that nobody has to
look at it, which also means **nobody will notice when it dies.** A heartbeat plus a scheduled
check turns "the TV has been frozen since Tuesday" from something a visitor eventually mentions
into something known within the hour — and it is what makes the M3 soak measurable rather than
anecdotal. **Decision needed: keep the version-display-only plan, or add a heartbeat to M3.**

---

## 2. Tree

```
VHF_TV/
├── CLAUDE.md                            [x]  mission, milestones, guardrails
├── README.md                            [x]
├── package.json                         [x]  build, preview, validate-content, sync-sources, test, admin
├── netlify.toml                         [x]  build command + cache headers
│
├── docs/
│   ├── ARCHITECTURE.md                  [x]
│   ├── BUILD_TREE.md                    [x]  this file
│   ├── CONTENT_SCHEMA.md                [x]  playlist/settings/events/announcements contract
│   ├── SCHEDULED_CONTENT_UPDATE.md      [x]  task description for the recurring content refresh
│   ├── DESIGN_REVIEW.md                 [x]  design/content critique of the live display
│   ├── DESIGN_PLAN.md                   [x]  the design work track (D0–D5), parallel to M0–M5
│   ├── DISPLAY_SETUP.md                 [ ]  M0  browser choice, fullscreen, TV settings, recovery
│   ├── PUBLISHING.md                    [ ]  M2
│   ├── SOURCES.md                       [ ]  M4  adapter contract + the Instagram decision
│   ├── RELIABILITY.md                   [ ]  M3  failure modes → what handles each, what doesn't
│   └── RUNBOOK.md                       [ ]  M3  written *after* the soak, not before
│
├── content/                             <- source of truth, hand-edited or generated
│   ├── settings.json                    [x]  syncIntervalMinutes, publishUrl, gallery + calendar
│   │                                         config; `timezone` (M1) and `hours` for quiet
│   │                                         hours (M4) both still missing
│   ├── playlist.json                    [x]  ordered scene list; photo `src` is a direct gallery
│   │                                         URL by decision (§6)
│   ├── announcements/announcements.json [x]  dated entries with activation + expiry
│   ├── artwork/                         [x]  custom artwork (local files, not remote URLs)
│   ├── gallery-exclude.json             [x]  hand-maintained ids dropped from the photo pool
│   ├── events-exclude.json              [x]  hand-maintained title substrings dropped from sync
│   └── generated/                       <- written by sources/, never hand-edited
│       ├── events.json                  [x]  from the public Google Calendar ICS feed
│       ├── gallery.json                 [x]  120-photo recency-weighted pool
│       └── instagram.json               [ ]  M4
│
├── web/                                 <- the product now, not a preview of one
│   ├── index.html                       [x]  M1: register sw.js, self-hosted font links
│   ├── sw.js                            [ ]  M1  shell + JSON + image caching — the offline story
│   ├── fonts/                           [ ]  M1  self-hosted Epilogue + Work Sans
│   ├── css/
│   │   ├── scene.css                    [x]  stage, layers, crossfade, shared scene chrome, photo
│   │   │                                     wash behind program/workshop scenes (§6)
│   │   └── theme.css                    [x]  VHF colours/type as CSS custom properties
│   └── js/
│       ├── engine.js                    [x]  loop-liveness guarantee + image preloading done;
│       │                                     M1 still owes version poll, global error handlers,
│       │                                     stall detector, periodic reload
│       ├── scenes.js                    [x]  all renderers in one file — split only if it hurts (§4)
│       ├── content-source.js            [x]  network-first/cache-fallback for content JSON.
│       │                                     M1: hand the image policy to sw.js; the header comment
│       │                                     still points at ContentCache.kt and needs updating
│       ├── scale-to-fit.js              [x]  1080p design space -> any panel
│       └── diagnostics.js               [ ]  M1
│
├── scripts/
│   ├── build-site.mjs                   [x]  validate content/, copy web/+content/ -> dist/
│   │                                         M1: sw.js needs a build-stamped cache version
│   ├── validate-content.mjs             [x]  schema validation, used by build-site + tests
│   ├── sync-sources.mjs                 [x]  runs the gallery and calendar adapters
│   ├── publish.mjs                      [ ]  M2
│   ├── fetch-photos.mjs                 [?]  dropped, re-opened for decision — see §1a
│   └── lint-content.mjs                 [ ]  M2  display-appropriateness rules, not schema
│
├── sources/                             <- PC-side only; the display never talks to these
│   ├── gallery/index.mjs                [x]  scrape -> size filter -> exclude list -> gallery.json
│   ├── calendar/index.mjs               [x]  public ICS -> expand recurrence -> exclude -> events.json
│   └── instagram/                       [~]  empty directory — resolve in M4
│
├── dist/                                [x]  build output, git-ignored
│   └── content/version.json             [x]  manifest the display polls (M1)
│
├── tests/
│   ├── content-schema.test.mjs          [x]  every content file matches its schema
│   ├── engine.test.mjs                  [ ]  M2
│   ├── publish.test.mjs                 [ ]  M2
│   └── soak/long-run.md                 [ ]  M3
│
├── admin/                               [x]  local-only (127.0.0.1) playlist/weights/exclude/
│   │                                         announcement editor; every write revalidates via
│   │                                         validate-content.mjs and rolls back on failure
│   ├── server.mjs                       [x]  node:http, no deps
│   ├── index.html                       [x]
│   └── app.js                           [x]  + publish button & version display (M5)
│
└── app/                                 [–]  DORMANT — Kotlin shell, builds clean, never installed.
                                              Not deleted: if unattended power-cut recovery ever
                                              becomes the blocking complaint, this is the answer,
                                              and it can be sideloaded from the Netlify site with
                                              the TV remote — no ADB, no PC. See §5.
```

---

## 3. Invariants

Carried forward:

- **`web/` never imports from `sources/` or `scripts/`.** The renderer only reads JSON from
  `content/` (locally) or the cache (on the display).
- **`content/generated/` is write-only for adapters and read-only for humans.** Hand edits belong
  in the files above it.
- **`dist/` is disposable.** Anything that cannot be rebuilt from `web/` + `content/` is a bug.
- **A content-only change touches `content/` and nothing else.**

New:

- **The display talks to exactly two hosts:** the Netlify `publishUrl` and the Squarespace CDN the
  gallery photos live on. Nothing else, ever — no analytics, no third-party fonts after M1.
- **A milestone ends with the television demonstrating a behaviour**, not with a file existing.
- **Any behaviour that depends on a TV setting must be written down in `DISPLAY_SETUP.md`**, because
  it can't be enforced from the repo and it will be lost the first time the device is reset.
- **The project is a git repository** (since 18 Sept 2026 — it was not, for its whole life before
  that). This is what makes "the PC project is the source of truth" true rather than aspirational,
  and it is what makes `sync-sources.mjs`'s closing instruction — *review the diff in
  `content/generated/` before publishing* — an instruction that can actually be followed. It
  matters most for the photo pool, which is randomly resampled on every sync.
- **An error must never be legible to a viewer.** A scene that cannot render is skipped silently;
  the technical detail goes to the console and the `?diag=1` overlay. `renderError` is now reached
  only when the whole playlist or the content load fails — the one case where something on screen
  beats a black rectangle. Before 18 Sept, an expired announcement would have put
  `Scene "announcements" (announcement) skipped: ...` on the wall every 5m42s from 9 Nov onward.

---

## 4. What this tree deliberately drops or defers

- **The whole `app/` tree** — *no longer dropped.* Revived Sept 18 as a thin appliance shell; see
  §5. What stays dropped is everything the old native plan put inside it: `ContentCache.kt`,
  `VersionPoller.kt`, `WatchdogService.kt` and the Kotlin scene engine. Those live in `web/`.
- **`fetch-photos.mjs`** — a PC-side photo mirror was only ever a workaround for the TV not being
  able to cache images. `sw.js` does it properly, on the device, for whatever the playlist
  currently references. **Re-opened for decision (Sept 18) — see §1a:** the offline claim holds,
  but opaque cross-origin caching, cold starts, dead URLs and serving 2500px images to a 1920px
  panel are four things a mirror addresses and `sw.js` does not.
- **Splitting `scenes.js` into `web/js/scenes/*.js`** (old Phase 2, item 1). ~350 lines of renderers
  sharing a one-line `(item, data) -> Node | throw` contract, causing no problems. Splitting it now
  is churn on the one part of the system that already works. Do it when a single scene type earns
  its own file.
- **A real device heartbeat** — needs a backend the static-site architecture doesn't have.
  **Re-opened for decision (Sept 18) — see §1a:** that premise is wrong. Netlify Functions run on
  the plan already hosting this site, so a heartbeat needs no new backend and no new host.
- **Multi-display, CMS features** — unchanged, still out of scope per CLAUDE.md.

---

## 5. Decisions and honest costs

**The Fire TV app was revived, and it closed M0 (Sept 18).** The browser path was the plan; the
three costs recorded below are exactly why it was abandoned. `app/` now ships as a thin WebView
appliance shell pointed at `display_url` — not a return to the old Phase 1–7 native plan. The
division of labour is unchanged from §0: the shell owns what a page cannot do for itself, and
nothing else. **Do not migrate scene, content, caching or refresh logic into `app/`.**

What the shell buys, against the three costs that made the browser path uncomfortable:

1. **Power-cut recovery.** `BootReceiver` relaunches the display on `BOOT_COMPLETED`. Fire OS does
   not guarantee this broadcast reaches sideloaded apps and the launcher can win the race, so this
   is *better, not solved* — `DISPLAY_SETUP.md` keeps the one-press manual fallback. The honest
   statement of the mission goal is now "turn on the television and walk away, usually," not
   "never."
2. **Keeping the screen on.** `FLAG_KEEP_SCREEN_ON` covers the app; the Fire TV's own Screen Saver
   *Start Delay* and Sleep Timer still have to be set to Never, and `DISPLAY_SETUP.md` says so.
   Both layers are needed — the screen saver is the one that actually bites.
3. **Chrome and prompts.** Gone entirely. Immersive-sticky, re-asserted on every focus change, no
   address bar, no update banner, and `shouldOverrideUrlLoading` refuses any host that is not the
   display's. Short BACK presses are swallowed so a stray remote press cannot take the display down.

Costs the shell adds, so nobody rediscovers them:

4. **Installing it needs ADB once.** The no-PC alternative is the Downloader app from the Fire TV
   appstore, with the APK published alongside the content on Netlify — worth doing if the television
   is ever reinstalled by someone without a laptop.
5. **The APK is signed with the local debug key.** Deliberate: one sideloaded television, no store,
   and a release-key ceremony would only add a secret to guard. The consequence is that a rebuild
   from a different machine's debug keystore will not install over this one without an uninstall.
6. **A URL change is the only content-shaped change that needs a rebuild.** `display_url` in
   `app/src/main/res/values/strings.xml`. Everything else publishes.

---

## 6. What's already built *(carried forward — these decisions are still current)*

**Photos are direct links to the VHF gallery (Squarespace CDN), not local files.** An explicit
choice: simpler authoring (paste a gallery URL into `playlist.json`, no download/rename/resize step)
beats a locally-mirrored photo cache. The tradeoff it accepted was no offline fallback for photos,
because caching arbitrary `<img>` tags needs a Service Worker. **M1 builds that Service Worker, which
closes the tradeoff** — authoring keeps its simplicity and the display gets real offline resilience.

**Content schema and validation.** `docs/CONTENT_SCHEMA.md` is the contract;
`scripts/validate-content.mjs` enforces it and `build-site.mjs` calls it rather than only
`JSON.parse`. Verified it actually rejects bad content (wrong scene `type`, missing `publishUrl`)
and leaves `dist/` untouched.

**Announcements.** `announcement` scenes resolve by `announcementId` from
`content/announcements/announcements.json`, the same pattern as `event`/`events`. Activation and
expiry gating verified in-browser.

**JSON cache fallback.** `web/js/content-source.js` is the single place that chooses cache vs
network for the content JSON (network-first, cache-fallback via the Cache Storage API), verified by
forcing a simulated fetch failure. See M1 for why this isn't yet sufficient on its own.

**Theme.** `web/css/theme.css` holds VHF colours and type as custom properties, matched to the live
site's real brand (cream/terracotta/navy/olive, Epilogue + Work Sans).

**Gallery adapter.** `sources/gallery/index.mjs` scrapes the three yearly gallery pages, keeps only
images ≥1200px on the long side (filtering out ~206×206 social re-post thumbnails Squarespace can't
serve larger), drops anything in `content/gallery-exclude.json`, and writes a 120-photo pool to
`content/generated/gallery.json` — **weighted heavily toward recently-added photos** (exponential
decay by rank, ranked by a best-effort `takenAt` parsed from camera-style filenames, falling back to
a per-gallery-year date) rather than sampled uniformly, so a re-run rotates newer photos in instead
of diluting them one-in-several-hundred forever. A `photo-pool` scene type picks a random pool photo
each time it comes up in rotation — that is what actually solved "I keep seeing the same 6 photos."
The same pool backs the faint (16% opacity) photo "wash" behind program/workshop scenes, matching
the site's own program-card treatment.

> **Curation workflow — ongoing, not a one-time cleanup.** If a photo in rotation needs context an
> unattended TV can't provide, add its id to `content/gallery-exclude.json` with a reason and re-run
> the adapter. This has come up twice already — two different flag-retirement ceremony photos
> (correct practice, alarming-looking without a caption), the second surfacing via the wash treatment
> on a completely different scene than the first. Expect spot-check-and-exclude as they're found;
> don't assume the list is complete after fixing one report.

**Calendar adapter.** `sources/calendar/index.mjs` fetches the VHF public Google Calendar's ICS feed
directly (`vhf2023calendar@gmail.com`, `.../public/basic.ics` — no API key needed for a public
calendar), parses VEVENTs with `node-ical`, expands recurring series (RRULE/EXDATE/RECURRENCE-ID
overrides) into concrete occurrences within a rolling window (`calendar.windowDays`, default 120),
and writes `content/generated/events.json`. An `event-pool` scene type (mirroring `photo-pool`) picks
one upcoming event per appearance, cycling through all of them. This replaced a hand-authored
`events.json` that had been manually restricted to registration-gated events only — which is why
real recurring workshops (a seasonal Clay and Camaraderie pottery series, for one) never appeared on
the display even while sitting on the calendar. The adapter now includes everything except what's
hand-excluded.

> **Curation workflow.** Recurring internal-only shifts (volunteer groups, board meetings),
> farm-closed days, and cancelled/private entries are dropped via `content/events-exclude.json`
> (substring match against the title) — see [CONTENT_SCHEMA.md](CONTENT_SCHEMA.md).

**Project skills.** `.claude/skills/refresh-vhf-photos/` wraps re-scrape → build → test → deploy for
photos alone; `.claude/skills/update-vhf-content/` runs both adapters together, then rebuilds, tests
and deploys. [SCHEDULED_CONTENT_UPDATE.md](SCHEDULED_CONTENT_UPDATE.md) is the same sequence written
as a standalone task description for a recurring scheduled agent.

**Fire TV shell (active).** `app/` is a fullscreen WebView pointed at the published Netlify site,
with a LEANBACK launcher intent, keep-screen-on, immersive-sticky chrome suppression, same-host
navigation lock, backoff retry with a local "Reconnecting" card, a stall watchdog, and a boot
receiver. `./gradlew :app:assembleRelease` produces a signed ~2.6 MB APK. Its launcher icon and Fire TV
home-row banner are generated from the brand logo by `scripts/generate-app-icons.py` and checked
in, so the Gradle build has no Python dependency. The bundled
`assets/web/` scene from Phase 1 is now dead weight and can go whenever someone is in there.
See §5 and `DISPLAY_SETUP.md`.
