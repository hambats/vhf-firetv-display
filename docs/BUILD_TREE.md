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

### M0 — On the screen  *(done — Sept 18, 2026)*

Closed by the `app/` WebView shell rather than by choosing a browser, which is why the shopping
list below reads as struck through rather than ticked: the shell *is* the fullscreen,
homepage-pinned, nag-free, auto-starting browser these criteria were describing. §5 records what
that bought and what it cost. Kept for the record:

- [x] ~~pick the browser/app on the Fire TV~~ — `app/` instead. What actually matters, in priority order:
      1. can be made **fullscreen with no chrome** (an address bar on a 24/7 display is the tell)
      2. **opens to a set homepage** — so recovery after a power cut is one button, not typing a URL
      3. doesn't nag (update prompts, cookie bars, "sign in" interstitials)
      4. recent enough Chromium to run a Service Worker
      5. bonus, if any option offers it: **auto-start on boot** — that alone gets most of the way
         to unattended, and is the single most valuable property to shop for (see §5)
- [x] ~~a shorter URL to type on a remote~~ — moot: the URL is baked into the shell
      (`display_url` in `app/src/main/res/values/strings.xml`), so nobody types it on a D-pad.
- [x] turn off the TV's screensaver / sleep / auto-power-down, and note every setting changed
- [x] `docs/DISPLAY_SETUP.md` — the whole device procedure, written for someone who is not you

**Ship gate:** the display is on the wall and running.

### M1 — The page survives being left alone  *(code complete Sept 18, 2026; ship gate pending)*

The two gaps this milestone existed to close, both of which only showed up after the page had
been running a while, and neither of which is visible in a five-minute preview:

- **`engine.js` loaded content once at startup and then looped forever.** A page opened Monday was
  still showing Monday's events on Friday. With no native poller, nothing ever updated it.
- **There was no Service Worker, so `content-source.js` caching didn't actually buy offline.**
  It cached the JSON, but if the browser was closed and reopened while the network was down,
  `index.html`, the CSS and the JS couldn't load at all and the page was blank. The cached JSON
  was unreachable behind a shell that never booted.

Both are now closed, along with three failures found while closing them: fonts loaded from a
third-party host, event times formatted in the television's own idea of local time, and no way to
tell a dead loop from a quiet one. **What is not done is the ship gate** — everything below was
verified on a desktop browser and in tests; none of it has run for a week on the actual television,
which is the only thing that can close this milestone. See M3.

- [x] `web/sw.js` — caches the app shell (HTML/CSS/JS/fonts) and the images. **Not** the content
      JSON: `content-source.js` already owns that policy, and version.json must never be served
      stale or the display could never learn it is out of date, so the worker passes
      `content/*.json` straight through. **This closes the photo tradeoff recorded in §6 without
      any native code** — authoring still pastes gallery URLs, the display still runs with the
      network down.

      Two image caches, not one, and the reason is a bug that was nearly shipped: the brand mark
      and the curated artwork are local and appear on almost every scene, while the gallery photos
      are cross-origin, opaque and effectively unbounded. Sharing one oldest-first cache between
      them meant the logo — cached first, therefore evicted first — would be thrown away to keep a
      photo shown once an hour. Local artwork now has its own unbounded cache; only the remote
      pool is capped.

      The cap is 60, far below the 120-photo pool, because opaque cross-origin responses are
      charged against the storage quota at a heavily padded size rather than their real one, and a
      quota error takes the *shell* cache down with it. That padding, plus serving 2500px files to
      a 1920px panel, is the live argument for the publish-time photo mirror in §1a.

      The precache list is generated by `build-site.mjs` rather than hand-written, and the cache
      name is build-stamped: a hand-maintained precache list goes stale silently, and a cache-first
      worker with a fixed cache name is a display that can never be updated again.
- [x] **self-host the fonts.** `index.html` pulled Epilogue and Work Sans from Google Fonts;
      offline that silently fell back to system fonts and the display visibly stopped looking like
      VHF — a failure nobody would report as an outage. Both are now in `web/fonts/` as the
      variable-font woff2 files (one file per family per subset, spanning the whole weight axis),
      declared in `web/css/fonts.css`. Both faces are SIL Open Font License. This is also what
      makes the two-hosts invariant in §3 true rather than aspirational.
- [x] **version poll** — `engine.js` re-fetches `content/version.json` on `syncIntervalMinutes`
      and reloads at a scene boundary when it changes, so the swap is invisible. Verified end to
      end against a running display: bumping the manifest logged `reload queued (content version
      N); will apply at the next scene boundary`, then the reload, and the page came back on the
      new version with uptime reset.

      One honest limit: content is re-read on reload, but changed *code* can take a second reload,
      because the Service Worker serves the shell from cache while fetching the new build behind
      it. That is the right trade for a display — booting instantly from cache matters more than
      picking up a CSS change on the first try.
- [x] **watchdog** — now all three layers.
      *(Sept 18, first pass.)* `engine.js` guarantees the loop stays armed: exactly one reschedule
      per tick, armed before anything that can throw, plus a backstop timer if the scene never
      resolves. That closed the case where one thrown scene ended the loop permanently — verified
      by fault injection against the pre-fix build, which froze on a single throw and stayed frozen
      after the fault was removed.
      *(Sept 18, second pass.)* Global `error` and `unhandledrejection` handlers in
      `diagnostics.js`, installed before any other script loads so nothing can throw ahead of them.
      A stall detector outside the loop watching the one number that proves the display is alive —
      when a scene last changed — which reloads the page if nothing has advanced in several times
      the current dwell. And a periodic reload every six hours at a scene boundary: nothing is
      known to leak, which is exactly why it is there.
      **The limit worth writing down:** this catches a dead loop in a live page. A WebView that has
      crashed outright takes the timer with it, and that case belongs to the native shell's own
      watchdog (§5). Both layers are needed; neither covers the other.
- [x] `web/js/diagnostics.js` — `?diag=1` overlay: uptime, content version, last sync, Service
      Worker state, cache hit/miss, failed images, error count, current scene, last error. Without
      the switch it still records everything and simply draws nothing, because an error legible to
      a viewer is a bug (§3); the recording is what the stall detector and anyone reading the
      console actually use. Uptime is the number that earns its place: it is how you tell a display
      that has been quietly restarting all night from one that has genuinely been up since Friday.
- [x] **pin the display timezone.** `scenes.js` formatted with `getHours()`/`getDay()` — whatever
      the television believed local time was. It now formats through `toLocaleTimeString` /
      `toLocaleDateString` with an explicit zone read from `timezone` in `settings.json`, handed
      over by the engine before the first scene renders, and the `Intl` support check is in
      `compat.js`.

      `timezone` is **required** by `validate-content.mjs`, not defaulted. The whole point is that
      the absence of a zone is invisible on screen: the times are simply wrong by a fixed offset.
      A default applied at render time would have recreated the bug quietly, so the absence is a
      build error instead.

      Measured on the real events: a 9:30 PM Wednesday event renders as "Wed, Sep 23 9:30 PM"
      pinned, and would have rendered as "Thu, Sep 24 1:30 AM" — the wrong day — on a television
      whose clock had reset to UTC.
- [x] **browser compat check** — `web/js/compat.js` checks Promise, fetch, Service Worker, Cache
      Storage, CSS custom properties, `object-fit` and `Intl` time-zone support at startup, records
      the result for the overlay and logs anything missing. It never blocks: refusing to start
      would replace a degraded display with no display at all. Every one of these degrades
      *silently* when absent, which is the only reason the check is worth having.
      **Still owed on the device:** running it once on the actual Fire OS 7 WebView. Everything
      here has only been seen passing on a desktop Chromium.
- [x] **image preloading** (Sept 18 — not in the original plan, found in review). Scenes set
      `img.src` and went straight into the crossfade, so the fade revealed an empty frame while a
      2500px gallery photo downloaded, and a dead URL rendered as a blank rectangle for the full
      dwell every time the shuffle bag came back to it, with nothing logged. Scenes are now built
      and warmed off-DOM one dwell ahead and shown only once they can paint; failed images are
      hidden and their URLs struck from the rotation for the rest of the run. Measured: content
      images already loaded at the instant of paint went from 0/3 and 0/2 to 3/3 and 2/2.
      **Complementary to `sw.js`, not a substitute** — preloading warms an image seconds ahead
      within a session; the Service Worker is what survives a restart.

**Ship gate — not yet met.** Pull the router. Close the browser. Reopen it. The display still
plays, photos included. Leave it a week; it's showing this week's events.

What has been verified so far, and how, so the gap is honest:

- The offline-restart path is covered by `tests/sw.test.mjs`, which runs the worker's fetch handler
  directly with a `fetch` that fails the way a dead network fails, and asserts a navigation is
  answered from the cached shell. Mutation-checked: disabling the navigate branch fails that test.
  This exists because the browser preview *cannot* be taken offline — stopping the dev server makes
  the pane refuse the navigation before the page is ever reached — and by the time this fails on a
  television it is a blank screen in an empty building.
- The version poll, the fonts, the compat check and the overlay were verified in a live browser.
- **Nothing has been verified on the Fire TV, and nothing has run for a week.** That is M3.

### M2 — Repeatable publish  *(core landed Sept 18, 2026)*

Hand-running a deploy command was the one step still living in a human's memory — and that memory
went stale the moment the publish endpoint moved to GitHub Pages, leaving both skills and the admin
button pointed at a host that no longer serves the display. Nothing would have reported it: the
sync would succeed, the deploy would succeed, and the television would stay stale. That is the
failure this milestone exists to prevent, and it is why `publish.mjs` is now the *single place the
transport lives* — skills, the scheduled task and the admin button call it instead of naming a
host, and the sequence ends by checking the live site rather than trusting the command.
[SCHEDULED_CONTENT_UPDATE.md](SCHEDULED_CONTENT_UPDATE.md) and the two project skills encode the
sequence; this makes it atomic.

- [x] `scripts/publish.mjs` — validate → build → test → commit → push → re-fetch
      `/content/version.json` and assert the version advanced. The verify step is the point: a push
      only *starts* a publish now that Actions runs the deploy, so a green push proves nothing.
      Untracked files the build would not publish are reported and left uncommitted rather than
      swept into a content commit.
- [x] `tests/publish.test.mjs` — invalid content never reaches `dist/`; the published set contains
      every `content/*.json` the engine fetches (read out of `engine.js`, so adding a fetch without
      adding it to `PUBLISHED_CONTENT` fails the suite instead of 404ing on the wall); the curation
      files are absent.
- [x] `tests/engine.test.mjs` — a throwing scene is skipped and the loop advances. Loads the real
      `engine.js` into a `vm` context (same technique as `sw.test.mjs`) with a fake DOM, fake
      `VhfScenes`/`VhfContentSource`/`VhfDiagnostics`, and a hand-rolled fake clock the test fires
      one timer at a time, so the assertions don't wait on a real clock. Proves both halves: the
      scene that throws is never shown, and the scene after it in rotation is — plus, after every
      tick, exactly one scene-advance timer is pending on top of the three long-lived ones
      (watchdog interval, version-poll interval, periodic-reload timeout), so a leaked or doubled
      reschedule would fail the test too.
- [x] `npm run publish`; both skills, `SCHEDULED_CONTENT_UPDATE.md` and the admin deploy handler
      call it instead of a step list
- [x] **stop publishing the curation files.** `build-site.mjs` copied all of `content/` into
      `dist/`, so `gallery-exclude.json` and `events-exclude.json` landed on the public site —
      including the free-text `reason` recording why each photo was pulled from rotation. It now
      copies an explicit allowlist (`PUBLISHED_CONTENT`), which also keeps the AI artwork
      candidates in `content/artwork/candidates/` off the public URL and out of the payload.
- [x] `scripts/lint-content.mjs` — **a display-appropriateness linter, distinct from the schema
      validator.** `validate-content.mjs` answers "is this well-formed?"; this answers "is this
      fit to put on a television?" Runs as a non-blocking warning step inside `publish.mjs`
      (exits 0 always). Implements: literal markdown emphasis (`**`/`__`) surviving into rendered
      text; ALL-CAPS runs over ~20 characters (short acronyms like "VHF"/"5K" excluded);
      registration/admin boilerplate descriptions with nothing else in the field; descriptions
      truncated mid-word; the farm's own postal address in a `location`; an enabled announcement
      slot with an empty announcement pool; a gallery pool below a floor of 20. Covered by
      `tests/lint-content.test.mjs` (13 cases, positive + negative per rule).

### M3 — Proof it lasts, and a runbook

- [ ] 72-hour unattended run on the actual TV, `?diag=1` on for the first day — procedure to
      run: [`tests/soak/long-run.md`](../tests/soak/long-run.md)
- [ ] `docs/RUNBOOK.md` [ ] — written *from what actually broke*, for VHF staff: display is blank,
      display is stale, display is showing an error, power came back and the screen is on the home
      screen. One short recovery procedure each.
- [ ] `docs/RELIABILITY.md` [ ] — failure modes and which mechanism handles each, including the
      ones nothing handles

### M4 — Content that maintains itself

- [x] **quiet hours** — `web/js/engine.js` (`isQuietHours`/`VhfQuietHours`) shows a black
      `scene--blank` frame instead of the playlist on days listed in `settings.json`
      `hours.closedWeekdays` (currently Sunday/Monday). A short BACK press on the remote
      (`app/.../DisplayActivity.kt` `onKeyUp`) calls `VhfQuietHours.wake()` to show normal
      content for 10 minutes so staff can confirm the display is alive without waiting for the
      next open day. Farm hours vary seasonally (dawn–dusk) so only the closed *days* are
      encoded, not a fixed daily clock window.
- [x] **burn-in review** — a fixed logo or header in the same pixels 24/7 on an LCD for months is a
      real risk. Check `scene.css` for anything that never moves, and nudge static chrome. Found
      two static, fixed-position, opaque marks: `.scene__brand` (112px corner logo, on nearly
      every scene) and `.scene__lockup` (280px centered logo, on the Welcome + announcement
      scenes only) — both now drift a few px over a 240s `translate()`-only `@keyframes` cycle
      (`vhf-pixel-shift` / `vhf-pixel-shift-lockup`), imperceptible but enough to avoid lighting
      the exact same pixels for months. Left alone as already low-risk: `.scene__wash` (16%
      opacity, random photo per scene, not fixed content), `.scene__fade` gradients (soft edges,
      no hard boundary, varies by scene family/anchor), and `.diag` (55% opacity, 16px text,
      diagnostics-only, not shown in normal operation).
- [x] **decide Instagram.** Decision: don't build it — scraping violates Meta's ToS and the
      sanctioned Graph API needs a Business/Creator account plus ongoing App Review, a maintenance
      burden this project's zero-credential, zero-review architecture is built to avoid, for a
      photo carousel the gallery adapter already provides. `sources/instagram/` (empty) removed.
      See [docs/SOURCES.md](SOURCES.md).
- [x] **trim event `location`.** Every synced event carries "Veterans Healing Farm, 138 Kimzey
      Rd, Mills River, NC 28759, USA", rendered on a screen standing at that address.
      `cleanLocation` (`sources/calendar/index.mjs`) drops the farm's own address and keeps only a
      sub-location ("Greenhouse", "Pavilion"), falling back to omitting the line.
- [x] **strip markdown emphasis in `cleanText`.** `stripHtml` removes tags and entities but
      nothing removes `**`/`__`, so a calendar entry's emphasis renders as literal asterisks on
      the wall. Unlike the wording itself, this one cannot be fixed by the calendar authors.
      *(The wording — descriptions that lead with cancellation-fee boilerplate — was raised in
      the Sept 18 review and deliberately left alone: the calendar authors will fix it at source.
      Only the code artefact is tracked here.)*
- [x] **drop `registrationUrl` from `events.json`.** Generated, never rendered, and identical
      across every event (a generic regpack builder link), so it carries no information even if
      something did render it. Remove it, or replace it with something a pointer-less display can
      actually use.
- [x] **rebalance the loop.** Was 15 `information` (152s, 42% of loop) vs. 11 `photo-pool` (128s,
      35%) out of 362s total. Now 13 `information` (118s, 31%) vs. 15 `photo-pool` (176s, 47%) out
      of 376s — photo-pool leads on both item count and time-share. Changes: added 4 new
      `photo-pool` entries (`photo-pool-10..13`, count:2 each); merged `nonprofit-status` into
      `free-programs` (same fact, one slide) and dropped `produce-partners` (a list of partner-org
      names that reads as noise at a glance, lowest value of the info slides); shortened 7 program/
      impact-stat slides from 10s to 8s (`program-agritherapy`, `program-herb-squad`,
      `program-beekeeping`, `program-workshops`, `resource-fair`, `memorial-wall`,
      `our-impact-2025`) since those are supporting detail, not core identity. Left untouched at
      10-12s: welcome, mission, history, get-involved, and the crisis line — these carry
      information nothing else on the display supplies.
- [ ] exclude-list curation is ongoing, not a one-time cleanup — see §6.
- [x] **`gallery-exclude.json` is keyed on a lossy id — fixed.** `idFromUrl` no longer truncates
      to 60 characters (it still keys on the URL's filename segment, not the whole URL, since
      that's the meaningful unique part of a Squarespace CDN URL — but it's no longer capped, so a
      long filename can no longer collide with another id's shared 60-char prefix). Both existing
      `gallery-exclude.json` entries (`20260506-110209`, `20260210-181436`) were already well under
      60 characters, so they were never actually truncated — the fix is a no-op for them and no
      migration was needed. Re-ran `node sources/gallery/index.mjs`: both ids are still absent from
      the regenerated `content/generated/gallery.json`, and `npm test` (12/12) still passes.

### M5 — Admin reaches the display

- [x] a publish button that calls `publish.mjs`. `/api/deploy` runs `scripts/publish.mjs` rather
      than naming a host, and `admin/app.js` wires a click handler to it that writes the result to
      `#deploy-output` — both sides are done.
- [x] display status. Built the cheapest option from §1a, not a heartbeat: `admin/server.mjs`
      adds `GET /api/status` (gated by the same `isTrustedOrigin` Host/Origin check as the other
      admin endpoints), which fetches the *live* published site's `content/version.json` (from
      `content/settings.json`'s `publishUrl`) server-side, so no GitHub Pages CORS question, plus
      the local `dist/content/version.json` for comparison. `admin/index.html`/`app.js` render both
      in a status bar under the header, refreshed on page load and again after a deploy completes.
      An unreachable live site shows a clear "couldn't reach the published site" message rather
      than crashing or going blank — verified by pointing `publishUrl` at a nonexistent host and
      confirming the error state, then restoring it. This is version-on-load, not a live heartbeat:
      a real heartbeat still needs a backend GitHub Pages can't provide and remains a separate,
      undone decision — see §1a.
- [x] **Written decision: no auth, because `admin/` never leaves 127.0.0.1.** Evidence checked
      before deciding: `package.json`'s `admin` script is just `node admin/server.mjs` — no host
      flag, no deploy target, nothing implying it's ever run anywhere but a developer's own machine.
      `admin/server.mjs`'s own header comment calls it "a small, local, dev-only tool, not a hosted
      admin product," brought forward early "at the user's explicit request." Nowhere in
      `docs/ARCHITECTURE.md`, `docs/DISPLAY_SETUP.md`, or this file is VHF staff described as running
      `admin/` — staff's only documented interaction with the display is *watching* the TV; every
      authoring/publish action is the developer's. This matches `CLAUDE.md`'s own architecture:
      "the PC development project is the source of truth... Claude Code runs on the developer's PC,"
      i.e. developer-only tooling stays developer-only. The one realistic attack surface for a
      127.0.0.1-bound server run only by its developer is a malicious page open in the same browser
      (or DNS rebinding) firing a cross-origin request — and that's exactly what the `isTrustedOrigin()`
      Host/Origin check above already closes. A second local user or a compromised shared machine is
      not a real threat model here because `admin/` is never run on a shared or staff-accessible
      machine — see the explicit rule now written into `docs/ARCHITECTURE.md`. No shared-secret token
      or login system was added; that would be engineering for a threat model this tool is never
      exposed to.
- [x] **`Origin`/`Host` check on the admin API, independent of that decision.** Binding to
      127.0.0.1 stops the network reaching it; it does not stop a web page open in a browser on
      the same machine from firing a cross-origin POST at `/api/deploy`, which now runs
      `publish.mjs` — a commit and a push to `main`. The browser blocks reading the response; the
      publish still happens. DNS-rebinding reaches it too. Note this got *sharper*, not softer,
      when the transport moved: the old hazard was an unwanted deploy of the current content, the
      new one writes to the repository. Four lines, and worth having before the auth discussion.
      **Done:** `isTrustedOrigin()` in `admin/server.mjs` rejects any request (every method, not
      just POST) whose `Host` header isn't exactly `127.0.0.1:8787` or `localhost:8787`, and, when
      an `Origin` header is present, requires it to resolve to the same host — 403 otherwise.
      Verified locally: same-origin GET/POST from `http://127.0.0.1:8787/` succeed; `curl -H
      "Host: evil.com"` and `curl -H "Origin: http://evil.com"` against `/api/deploy` both get 403.
- [x] **tighten the static-file guard.** `serveStatic` checks `filePath.startsWith(__dirname)`,
      which also passes for a sibling directory whose name merely starts with `admin`. Use
      `path.relative` and reject `..` or absolute results.
      **Done:** `isPathInsideDir()` in `admin/server.mjs` computes `path.relative(__dirname,
      filePath)` and rejects (403) whenever the result is empty, starts with `..`, or is absolute
      (the Windows cross-drive case). Verified locally: `/`, `/app.js`, `/index.html` still serve
      normally; a `..%2f..%2f`-encoded traversal request gets 403; a plain `%2e%2e/` request is
      already collapsed by the URL parser's own dot-segment removal before reaching this code, so
      it 404s harmlessly rather than escaping `admin/`.

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

**2. "A real heartbeat would need a server that isn't static — probably not worth it."**
*Reasoning revised Sept 18, after the host move.* This was re-opened on the grounds that Netlify
Functions run on the same free plan already hosting the site, so a heartbeat needed no new
infrastructure. **That escape hatch closed when publishing moved to GitHub Pages**, which serves
static files and nothing else. The original premise is therefore correct again — but only about
the *cost*, not about whether it is wanted.

The reason to want one is this project's own logic: the display is built so that nobody has to
look at it, which also means **nobody will notice when it dies.** A heartbeat plus a scheduled
check turns "the TV has been frozen since Tuesday" from something a visitor eventually mentions
into something known within the hour — and it is what makes the M3 soak measurable rather than
anecdotal.

So the decision is now a real trade, not a free win. The options, cheapest first:

- **Nothing.** Publish the version and its timestamp in `admin/`, and accept that a dead display is
  found by a human walking past it.
- **Push, don't POST.** The shell (`app/`) can already see the page; a native heartbeat from the
  television to any endpoint avoids needing the *site's* host to run code.
- **A third host for one endpoint** — a function on some free tier that does nothing but record a
  timestamp. It breaks the two-hosts invariant in §3 and adds a dependency to guard.

**Decision needed before M3, because the soak is the first thing that would use it.**

---

## 2. Tree

```
VHF_TV/
├── CLAUDE.md                            [x]  mission, milestones, guardrails
├── README.md                            [x]
├── package.json                         [x]  build, preview, validate-content, sync-sources, test, admin
├── netlify.toml                         [-]  dormant Netlify fallback; the live publish path is
│                                              .github/workflows/deploy-pages.yml
│
├── docs/
│   ├── ARCHITECTURE.md                  [x]
│   ├── BUILD_TREE.md                    [x]  this file
│   ├── CONTENT_SCHEMA.md                [x]  playlist/settings/events/announcements contract
│   ├── SCHEDULED_CONTENT_UPDATE.md      [x]  task description for the recurring content refresh
│   ├── DESIGN_REVIEW.md                 [x]  design/content critique of the live display
│   ├── DESIGN_PLAN.md                   [x]  the design work track (D0–D5), parallel to M0–M5
│   ├── DISPLAY_SETUP.md                 [x]  sideloading, fullscreen, TV settings, recovery
│   ├── PUBLISHING.md                    [-]  dropped — README's "Publish" section and the header
│   │                                         of publish.mjs say it once, in the two places
│   │                                         someone publishing actually looks
│   ├── SOURCES.md                       [x]  adapter contract + the Instagram decision (M4)
│   ├── RELIABILITY.md                   [ ]  M3  failure modes → what handles each, what doesn't
│   └── RUNBOOK.md                       [ ]  M3  written *after* the soak, not before
│
├── content/                             <- source of truth, hand-edited or generated
│   ├── settings.json                    [x]  syncIntervalMinutes, publishUrl, timezone, gallery +
│   │                                         calendar config; `hours.closedWeekdays` drives
│   │                                         quiet hours (M4)
│   ├── playlist.json                    [x]  ordered scene list; photo `src` is a direct gallery
│   │                                         URL by decision (§6)
│   ├── announcements/announcements.json [x]  dated entries with activation + expiry
│   ├── artwork/                         [x]  custom artwork (local files, not remote URLs)
│   ├── gallery-exclude.json             [x]  hand-maintained ids dropped from the photo pool
│   ├── events-exclude.json              [x]  hand-maintained title substrings dropped from sync
│   ├── artwork/candidates/               [x]  AI-generated stand-in photos awaiting curation into
│   │                                          artwork/, one subfolder per program; excluded from
│   │                                          the publish allowlist (M2)
│   └── generated/                       <- written by sources/, never hand-edited
│       ├── events.json                  [x]  from the public Google Calendar ICS feed
│       └── gallery.json                 [x]  120-photo recency-weighted pool
│
├── web/                                 <- the product now, not a preview of one
│   ├── index.html                       [x]  registers sw.js, loads self-hosted fonts
│   ├── sw.js                            [x]  shell + image caching — the offline story. Content
│   │                                         JSON passes through to content-source.js.
│   ├── fonts/                           [x]  self-hosted Epilogue + Work Sans (OFL, variable)
│   ├── css/
│   │   ├── scene.css                    [x]  stage, layers, crossfade, shared scene chrome, photo
│   │   │                                     wash behind program/workshop scenes (§6)
│   │   └── theme.css                    [x]  VHF colours/type as CSS custom properties
│   └── js/
│       ├── engine.js                    [x]  loop liveness, image preloading, version poll,
│       │                                     stall detector, periodic reload
│       ├── scenes.js                    [x]  all renderers in one file — split only if it hurts (§4)
│       ├── content-source.js            [x]  network-first/cache-fallback for content JSON; the
│       │                                     single decision point for content, images excluded
│       ├── scale-to-fit.js              [x]  1080p design space -> any panel
│       ├── compat.js                    [x]  startup capability check; never blocks
│       └── diagnostics.js               [x]  ?diag=1 overlay + the global error handlers
│
├── scripts/
│   ├── build-site.mjs                   [x]  validate content/, copy web/ + the PUBLISHED_CONTENT
│   │                                         subset of content/ -> dist/, stamp sw.js with the
│   │                                         build version and a generated precache list
│   ├── validate-content.mjs             [x]  schema validation, used by build-site + tests
│   ├── sync-sources.mjs                 [x]  runs the gallery and calendar adapters
│   ├── publish.mjs                      [x]  the only supported publish path; owns the transport
│   ├── fetch-photos.mjs                 [?]  dropped, re-opened for decision — see §1a
│   └── lint-content.mjs                 [ ]  M2  display-appropriateness rules, not schema
│
├── sources/                             <- PC-side only; the display never talks to these
│   ├── gallery/index.mjs                [x]  scrape -> size filter -> exclude list -> gallery.json
│   └── calendar/index.mjs               [x]  public ICS -> expand recurrence -> exclude -> events.json
│
├── dist/                                [x]  build output, git-ignored
│   └── content/version.json             [x]  manifest the display polls (M1)
│
├── tests/
│   ├── helpers/build-fixture.mjs        [x]  throwaway repo copy for VHF_BUILD_ROOT builds
│   ├── content-schema.test.mjs          [x]  every content file matches its schema
│   ├── sw.test.mjs                      [x]  the offline-restart guarantee, run against the
│   │                                         stamped sw.js a real build produces
│   ├── engine.test.mjs                  [x]  a throwing scene is skipped and the loop advances,
│   │                                         run against the real engine.js via a vm context
│   ├── publish.test.mjs                 [x]  bad content never reaches dist/; published set
│   │                                         matches what engine.js fetches
│   └── soak/long-run.md                 [x]  M3
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
                                              and it can be sideloaded from the published site
                                              with the TV remote — no ADB, no PC. See §5.
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

- **The display talks to exactly two hosts:** the `publishUrl` (GitHub Pages) and the Squarespace
  CDN the gallery photos live on. Nothing else, ever — no analytics, no third-party fonts after M1.
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
  **Re-opened for decision (Sept 18) — see §1a.** The "Netlify Functions make this free" argument
  that re-opened it died with the move to GitHub Pages, which serves static files only. Still
  wanted, no longer free.
- **Multi-display, CMS features** — unchanged, still out of scope per CLAUDE.md.
- **An Instagram source adapter** — decided against (M4, Sept 2026): scraping violates Meta's ToS,
  and the sanctioned Graph API needs a Business/Creator account and ongoing App Review, a
  maintenance burden out of proportion to a photo feature the gallery adapter already covers.
  `sources/instagram/` (empty) removed. See [docs/SOURCES.md](SOURCES.md).

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
   appstore, with the APK published alongside the content — worth doing if the television
   is ever reinstalled by someone without a laptop. *Update (Sept 19): ADB is no longer farm-only.
   The television runs Tailscale with always-on VPN, so installs and diagnostics work from
   anywhere — see [REMOTE_ACCESS.md](REMOTE_ACCESS.md). The same test confirmed `BootReceiver`
   recovering the display after a power cut, twice; the "no guarantee" above stands as a caveat,
   not as an expectation of failure.*
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
and deploys. `.claude/skills/generate-event-artwork/` generates an AI stand-in photo (Stable
Diffusion / ComfyUI, Juggernaut XL) into `content/artwork/candidates/<program>/` for a program or
event with no real farm photo yet, and wires the result into the curated-photo pipeline once
approved. [SCHEDULED_CONTENT_UPDATE.md](SCHEDULED_CONTENT_UPDATE.md) is the same sequence written
as a standalone task description for a recurring scheduled agent.

**Fire TV shell (active).** `app/` is a fullscreen WebView pointed at the published site,
with a LEANBACK launcher intent, keep-screen-on, immersive-sticky chrome suppression, same-host
navigation lock, backoff retry with a local "Reconnecting" card, a stall watchdog, and a boot
receiver. `./gradlew :app:assembleRelease` produces a signed ~2.6 MB APK. Its launcher icon and Fire TV
home-row banner are generated from the brand logo by `scripts/generate-app-icons.py` and checked
in, so the Gradle build has no Python dependency. The bundled
`assets/web/` scene from Phase 1 is now dead weight and can go whenever someone is in there.
See §5 and `DISPLAY_SETUP.md`.
