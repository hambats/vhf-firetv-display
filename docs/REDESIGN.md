# VHF Display — Ground-Up Redesign

**Status: proposal, not built.** The display described in [ARCHITECTURE.md](ARCHITECTURE.md) is the
one that is live and working. This file is what the project would look like if it were designed
today, knowing what eighteen months of running it has taught — and, more usefully, knowing what the
television actually is rather than what we assumed it was.

Nothing here argues the current system was built wrong. Most of it was built right and is kept
below. The changes are concentrated where reality turned out to differ from the assumptions.

---

## 1. The device, measured

Every number here was read off the television on 2026-09-21 over Tailscale, not inferred.

| | |
|---|---|
| Device | Toshiba AFTTI43, Fire OS 7.7.1.6 |
| Android | 9 (API 28) |
| **WebView** | **`com.amazon.webview.chromium` 138** |
| RAM | 1.66 GB total; display app resident ≈ 44 MB |
| Storage | 11 GB `/data`, 6.6 GB free |
| Panel | 1920×1080 |
| Uptime at time of reading | 1 day 19:53 |
| Access | Tailscale, always-on VPN, `adb connect 100.69.183.1:5555` |

### 1.1 The WebView finding, and why it matters most

The repo states in two places that `web/` is **ES5-only** "for the same Fire OS 7 WebView reason."
That inference — old OS, therefore old engine — is wrong. Amazon ships and updates its WebView
independently of the Fire OS release. The television is running **Chromium 138**.

This is the single most consequential fact in this document, because the ES5 rule is load-bearing
for several others: it is why there is no build step, why there is no bundling or content hashing,
and therefore why a code change can take up to six hours to reach the panel (§2.2).

**Verify before relying on it.** The cost of being wrong is a blank television in a public building.
The check is a one-line feature probe rendered on-device, not a version string read from `adb`.

---

## 2. Failure modes, which are the actual design input

Design from what broke, not from a feature list. Each of these was observed, not imagined.

### 2.1 Nothing notices a dead display
`web/js/diagnostics.js` already records uptime, error count and last error. None of it leaves the
page. Tailscale made *fixing* a dead display cheap and did nothing for *knowing* it was dead. A
display that fails on a Friday evening is dark until a human walks past it. This is the largest
unaddressed risk in the project and has been for its entire life.

### 2.2 A new build is slow to land, and nobody can tell it hasn't
Three mechanisms compound:

1. `startVersionPoll` treats its first poll after any load as a baseline only
   (`if (known === null) { known = manifest.version; return; }`), so a page that loads *already
   stale* never reloads on that poll.
2. The next poll is up to `syncIntervalMinutes` (20) later.
3. A content-version reload only guarantees *content*. The Service Worker serves the cached shell
   while fetching the new build behind it, so a CSS or JS change can need a further reload —
   worst case the 6-hour `PERIODIC_RELOAD_MS`.

Observed directly: after a publish, the television kept rendering the previous layout, and two app
restarts did not shift it.

### 2.3 The photo cache sits on a quota cliff
Photos are hot-linked from the Squarespace CDN, so they cache as **opaque** cross-origin responses.
Browsers charge opaque entries against the storage quota at a heavily padded size, not their real
one. `MAX_IMAGES` is capped at 60 against a 120-photo pool for exactly this reason, and the comment
in `web/sw.js` is explicit that a quota error would take the *shell* cache down with it — which is
what makes the display bootable offline at all. So the cap is a safety margin protecting the most
important property the display has, and it is tuned by guesswork rather than measurement.

Compounding it: the display fetches 2500px originals for a 1920px panel.

### 2.4 Content freshness depends on somebody's laptop
The calendar and gallery sync runs on the developer's PC. A scheduled task now exists, but it only
fires while that machine is awake with the app open. The architecture rule says the television must
keep working with the PC switched off — it does, but it slowly goes *stale*, which is a quieter
version of the same failure.

### 2.5 The event pool drains silently
The sync window and the render-time filter are each correct. Together, with no sync, the event list
simply runs out: measured 2026-09-20, 39 events then, 17 after thirty days, 2 after sixty, **none
after ninety**. At zero, every event scene throws, the engine skips it exactly as designed, and the
display becomes a photo-and-facts loop with no error and no visible fault.

### 2.6 Curation is keyed to things that can vanish
Crop overrides, exclusions and captions key on scraped gallery ids and CDN URLs. A photo re-uploaded
by VHF is a new id, and its reviewed crop is silently orphaned.

### 2.7 Two copies of the app
`app/src/main/assets/web/` is a bundled mirror of `web/` that does not update itself and is
documented as drifting. Two sources of truth for the same page.

---

## 3. Principles

1. **The television survives everything being off but its own power and network.** Unchanged, and
   still the rule everything else answers to.
2. **Every silent failure becomes a loud one.** A display that is wrong should be visibly wrong or
   should say so somewhere a human will see.
3. **Freshness must not depend on any individual's computer.**
4. **Anything the display needs is served from the display's own origin.**
5. **Curation is human work and must survive regeneration.**
6. **The shell owns only what a page cannot do for itself.** Unchanged.

---

## 4. The design

### Layer 0 — Device shell (Kotlin, still thin)

Keeps: fullscreen, wake lock, immersive chrome, remote/back lockout, boot relaunch, network retry.

Adds:
- **A `WebChromeClient` override**, so page console output reaches `logcat`. This is small and
  unblocks publish-loop verification, which is currently recorded as blocked precisely because
  Amazon's WebView drops console output without it. It converts "did the television get the new
  build?" from unanswerable into one `adb logcat` line.
- **A liveness watchdog in the shell.** The page stamps a timestamp; if it stops advancing, the
  shell reloads the WebView. The page already watchdogs its own scene loop; this catches the case
  where the page itself is gone.

Drops: `app/src/main/assets/web/`. Replaced by a single small static offline card baked into the
APK — a "display is starting" panel, not a second copy of the application. The Service Worker is
the real offline story; the mirror only adds drift.

### Layer 1 — The page (built, modern, content-hashed)

Given Chromium 138, drop the ES5 rule and add a minimal build (esbuild or equivalent): one JS
bundle, one CSS file, **content-hashed filenames**.

Hashing is the point, not the tidiness. With hashed assets there is no such thing as a stale shell:
a new build references new filenames, so §2.2's "Service Worker serves the old code" class of
problem stops existing rather than being worked around.

Keeps, deliberately, because they are the reason the display is reliable:
- preload-one-dwell-ahead, and skip a scene whose images failed
- shuffle bags so a pool cycles before repeating
- the stall watchdog, the periodic reload, quiet hours, the burn-in drift
- `?diag=1`

### Layer 2 — Content served from our own origin

**Mirror the photos at publish time.** Fetch from Squarespace during the build, resize to the panel
(1920px long edge, plus a 960px variant), re-encode to WebP, write to `content/photos/<sha>.webp`,
publish alongside the site.

What that fixes, in order of importance:
- Same-origin responses are **not opaque**, so the cache is accounted at real size. The 60-photo cap
  and the quota cliff under it both go away.
- ~5–10× fewer bytes to a 1920px panel.
- A photo deleted from Squarespace stops being able to blank a scene.
- **Curation keys become content hashes** — stable across re-uploads and re-scrapes, fixing §2.6.

Budget check: 120 photos at ~250 KB ≈ 30 MB. The device has 6.6 GB free.

This is the decision parked in `BUILD_TREE` §1a.1, with a reference implementation preserved at tag
`archive/photo-mirror-experiment`. Adopt it.

### Layer 3 — The pipeline moves to CI

Run the sync on **GitHub Actions on a schedule**, which already runs the deploy. Both sources are
public; no credentials are needed anywhere.

This removes §2.4 entirely — freshness stops depending on a laptop being awake.

> **This deliberately amends a stated rule.** `CLAUDE.md` says scraping is "PC-side sync/authoring
> layer only". The intent of that rule is *the television must never scrape* — it must not depend on
> Squarespace or Google being reachable from the building, and must carry no credentials. CI honours
> that intent completely. The rule should be reworded from "PC-side" to "build-side, never
> device-side" rather than silently broken.

Publish semantics are unchanged and worth keeping exactly: validate → build → test → deploy →
**verify the live version actually advanced**.

### Layer 4 — Awareness

A small Cloudflare Worker (free tier), two routes:

- `POST /beat` — the display sends `{version, uptime, errorCount, lastError, currentScene,
  upcomingEventCount}` every few minutes; the Worker records last-seen in KV.
- **Cron trigger** — if last-seen is older than a threshold, send an alert.

Plus `GET /health` returning a plain status, so "is the display alive?" is answerable from a phone
without tooling.

No secrets on the device; the payload is operational telemetry about a public display, not personal
data. This turns §2.1 from the project's biggest unaddressed risk into a solved problem, and it is
the one item here that is worth doing even if nothing else in this document is.

`upcomingEventCount` in the payload is what makes §2.5 loud: the famine becomes a number someone can
alert on, months before it reaches zero.

### Layer 5 — Freshness and honest failure on the page

- **Compare the polled version against the version baked into the build**, not against the first
  polled value. A page that loads stale then knows it immediately instead of waiting a full poll.
- **Make event famine visible.** At zero upcoming events the display shows a deliberate, designed
  card rather than silently skipping every event scene — and reports it in the heartbeat.
- Keep `?diag=1`, and add the built version to it.

---

## 5. What I would not do

- **No CMS, no database.** Versioned JSON files in git are the right format: auditable, diffable,
  revertable, and they survive the tooling that produced them.
- **No framework.** The page is a slideshow. The engine is a few hundred lines of carefully
  defensive code whose comments explain *why* each guard exists. Rewriting that in React buys
  nothing and discards the hard-won parts.
- **No multi-display support.** One television, one building.
- **No server-side rendering.** A static site is exactly the right shape for something that must
  keep working when the network goes away.
- **No auto-wiring of `detect-photo-focus.py` into the sync.** The docs are right: a detector that
  is right 95% of the time still puts a beheaded photo on a public wall, and nobody is watching when
  it does. It stays hand-run and eye-reviewed.

---

## 6. Migration order

Risk-first, same philosophy as the existing build tree. Every step is independently shippable and
independently valuable, which matters because the current display is live and working.

| # | Step | Fixes | Notes |
|---|---|---|---|
| 1 | Heartbeat Worker + `POST /beat` | §2.1, §2.5 | No page rewrite. Highest value, lowest risk. |
| 2 | Photo mirror at publish time | §2.3, §2.6 | Unlocks the cache cap; reference implementation exists. |
| 3 | Sync on GitHub Actions | §2.4 | Removes the laptop dependency. |
| 4 | Hashed build; retire the ES5 rule | §2.2 | **Probe Chromium 138 on-device first.** |
| 5 | Shell: `WebChromeClient`, drop the asset mirror | §2.7 | Unblocks publish verification. |
| 6 | Famine card, version-vs-build comparison | §2.2, §2.5 | Small, once 4 lands. |

Steps 1–3 need no change to `web/` at all. Step 4 is the only one that touches the engine, and it is
deliberately last.

---

## 7. Open questions

- **Does Chromium 138 hold up on-device?** Everything in step 4 rests on it.
- **What is the alert channel?** Email, a phone push, a webhook into something VHF already watches.
  An alert nobody receives is the same as no alert.
- **Who is on call?** The heartbeat answers "is it dead"; it does not answer "who walks over". That
  is an organisational question, and the technical work is wasted without an answer.
- **The load average read 57 on a 4-core TV** while the display sat idle. Android inflates this with
  uninterruptible sleep, so it may be an artifact — but it is unexplained, and worth a look before
  assuming the device has headroom for anything heavier.
