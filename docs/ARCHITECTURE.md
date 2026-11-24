# VHF Fire TV Display — Architecture

> **Correction (Nov 23, 2026) — the native app shell is active, and the host is GitHub Pages.**
> The Kotlin WebView shell in `app/` (v1.2.1) is installed on the television and is how the
> display is shown. It is a *thin* shell: fullscreen, screen-on, remote/back-key lockout, offline
> card and retry, renderer-crash rebuild, relaunch on boot. Scenes, caching and refresh stay in
> `web/`. The site is published to **GitHub Pages** by `.github/workflows/deploy-pages.yml`;
> Netlify was dropped on Sept 18, 2026 and is a dormant fallback only. An earlier note here called
> the shell "dormant" and the host Netlify; both are out of date.
>
> **Superseded below:** "App shell", "Storage / persistence", "Platform isolation", and "Phase 1
> scope" describe the original, heavier native-app plan (local asset bundle, native sync), not the
> thin shell that shipped. See [BUILD_TREE.md](BUILD_TREE.md) §5.

## Web runtime *(current)*

- The display is **HTML/CSS/JS in `web/`**, published as a static site to GitHub Pages and loaded on
  the television by the `app/` WebView shell (see `DISPLAY_SETUP.md`).
- The page owns every display behaviour; the shell owns only what a page cannot do:

  | Behaviour | Mechanism |
  |---|---|
  | Offline operation | Service Worker (`web/sw.js`) — app shell and photos; content JSON is network-first with cache fallback in `web/js/content-source.js` (the SW passes it through) |
  | Content refresh | version poll in `engine.js` against `content/version.json` |
  | Crash/stall recovery | `window.onerror` + stall detector + periodic self-reload |
  | Comes back after power loss | `app/` `BootReceiver` relaunch (Fire OS does not guarantee it; observed working) |
  | Screen stays on | `app/` keeps the screen on, plus the TV's own sleep/screensaver settings |

- The last two rows still depend partly on device configuration. They are recorded in
  [BUILD_TREE.md](BUILD_TREE.md) §5 and must be written into `DISPLAY_SETUP.md`, because nothing in
  this repository can enforce them and they are lost the first time the TV is factory reset.
- Gallery photos are cross-origin (Squarespace CDN) and cache as opaque `no-cors` responses: they
  render correctly, cannot be inspected, and cost more storage quota. The image cache is capped.
- The display talks to exactly two hosts: the GitHub Pages `publishUrl` and the Squarespace CDN. Fonts
  are self-hosted so an offline display still looks like VHF.

## Target platform *(still accurate)*

- **Device:** Fire TV Edition television — a real TV with Fire TV built directly into it (not a
  separate Fire TV Cube/Stick box, not an Apple TV).
- **OS:** Fire OS 7 (Android 9-based), Amazon Fire TV — **not** Vega OS.
- Confirm the exact OS version on the actual unit (Settings → My Fire TV → About). It now matters
  for a different reason than originally written: it determines which browsers are available and
  how old the embedded Chromium is, which decides whether the Service Worker and Cache Storage APIs
  the offline story depends on are actually present.

### Compatibility approach

The exact Fire TV Edition model/OS version wasn't available to check at build time, and doesn't
block development. Scene HTML/CSS/JS is written conservatively (no bleeding-edge JS syntax, no CSS
features younger than ~2018) so it renders correctly on older embedded WebView and browser versions.
**This constraint now applies to `web/` itself** — originally it applied only to the copy bundled
inside the APK. Verify it against whatever browser is chosen on the device (BUILD_TREE.md, M1).

## Publish transport *(corrected Nov 23, 2026)*

- PC-side content (this repo's `content/` folder) is deployed to a **GitHub Pages static site** (a
  JSON manifest plus asset files) on every push to `main`. No server code required.
  HTTPS matters beyond privacy here: Service Workers and Cache Storage require a secure context, so
  the offline story depends on the display being loaded over `https://`.
- The display polls `<publishUrl>/content/version.json` on an interval (`syncIntervalMinutes` in
  `content/settings.json`) and on load.
- No credentials are embedded in anything the television loads — the Pages site is a public
  read-only content endpoint. Gallery/calendar/Drive access stays on the build side (the PC or the
  daily CI sync), in the sync/authoring layer that publishes to Pages.

---

## Superseded sections *(kept for context; do not build to these)*

The following described the native app. They are retained because reviving `app/` would start from
them — see [BUILD_TREE.md](BUILD_TREE.md) §5.

### App shell *(superseded)*

- Native Android (Kotlin) app whose entire UI is a single full-screen `WebView`, loading local
  HTML/CSS/JS from `file:///android_asset/web/` plus locally-cached content from app-private
  storage written by the sync layer.
- Native responsibilities were deliberately thin — only what a WebView cannot do: Leanback launch
  intent; fullscreen, keep-screen-on, hide system bars; WebView crash/reload watchdog; content sync
  scheduling; serving cached content via a `WebViewAssetLoader`-style file mapping.

### Storage / persistence *(superseded)*

- `getFilesDir()/content/current/` — last-known-good validated content.
- `getFilesDir()/content/previous/` — prior validated version, kept as a rollback target.
- `getFilesDir()/content/incoming/` — scratch area for a download in progress, promoted to
  `current/` only after validation passes.
- Chosen over `SharedPreferences`/a database because content is a set of versioned files, not
  relational records. **The versioned-files principle still holds** and is why the Service Worker
  caches whole published files rather than parsed records.

### Platform isolation *(superseded)*

- Fire-TV-specific code was to live behind a small interface so a future device/OS target wouldn't
  require touching scene/render code. **The underlying goal survives and is now stronger:** all
  rendering logic is platform-agnostic web code with no native layer at all, so the display runs on
  anything with a sufficiently recent browser.

### Phase 1 scope *(superseded — completed, then shelved)*

Minimal Android app: launches, fullscreen, immersive, keeps screen on, loads one static bundled
HTML scene from assets. Code-complete, builds cleanly with `assembleDebug`, never installed on the
television.

## `admin/` has no authentication — by design, not oversight

`admin/server.mjs` binds to `127.0.0.1` only and has no login, no session, no shared-secret token.
That is a deliberate decision (`docs/BUILD_TREE.md` M5), not an unfinished feature, and it depends
entirely on one rule holding:

**`admin/` must only ever be run by the developer, on the developer's own machine — never on a
machine VHF staff can log into or reach, and never bound to any network interface other than
`127.0.0.1`.**

Why this is safe under that rule, and only under that rule: a server on `127.0.0.1` with no auth
is reachable by anything else running on the same machine as the same or another local user. The
only realistic way to hit it remotely is a malicious web page open in a browser on that same
machine (a cross-origin `fetch`/DNS-rebinding attack), and `isTrustedOrigin()` in `admin/server.mjs`
already closes that door by rejecting any request whose `Host`/`Origin` doesn't match this server.
What that check does **not** and cannot defend against is a second local user, a compromised shared
machine, or anyone else who already has a shell or a browser tab on the box running `admin/` — for
those, the only real fix is authentication, and none is built.

If this ever changes — if VHF staff, a shared office PC, or anything other than the developer's own
machine needs to run `admin/`, or if it's ever bound to `0.0.0.0` or a LAN address — this decision
no longer holds and `admin/` needs real auth (a shared-secret token is the minimum bar; see the
option considered and rejected in `docs/BUILD_TREE.md` M5) before that happens, not after.
