# VHF Fire TV Display — Architecture

> **Revision note (Sept 2026) — the native app shell is dormant.**
> This document originally proposed a native Kotlin app wrapping a WebView. That app was built to
> Phase 1, never installed on the television, and is now **dormant by decision**: the display runs
> as a web page shown through a browser or off-the-shelf app on the Fire TV.
>
> Still accurate below: the target platform notes, the publish transport, and the conservative
> web-code compatibility constraint. **Superseded:** "App shell", "Storage / persistence",
> "Platform isolation", and "Phase 1 scope" — replaced by "Web runtime" immediately below.
> See [BUILD_TREE.md](BUILD_TREE.md) §0 and §5 for the decision and its honest costs.

## Web runtime *(current)*

- The display is **HTML/CSS/JS in `web/`**, published as a static site to Netlify and loaded on the
  television by a browser/app selected during device setup (see `DISPLAY_SETUP.md`).
- The page owns every behaviour the native shell was going to own, except two:

  | Behaviour | Mechanism |
  |---|---|
  | Offline operation | Service Worker (`web/sw.js`) — app shell, content JSON, and photos |
  | Content refresh | version poll in `engine.js` against `content/version.json` |
  | Crash/stall recovery | `window.onerror` + stall detector + periodic self-reload |
  | Comes back after power loss | **device configuration — not fully solvable from a page** |
  | Screen stays on | **device configuration** (TV sleep/screensaver settings) |

- The two device-configuration rows are the real cost of this path. They are recorded in
  [BUILD_TREE.md](BUILD_TREE.md) §5 and must be written into `DISPLAY_SETUP.md`, because nothing in
  this repository can enforce them and they are lost the first time the TV is factory reset.
- Gallery photos are cross-origin (Squarespace CDN) and cache as opaque `no-cors` responses: they
  render correctly, cannot be inspected, and cost more storage quota. The image cache is capped.
- The display talks to exactly two hosts: the Netlify `publishUrl` and the Squarespace CDN. Fonts
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

## Publish transport *(still accurate)*

- PC-side content (this repo's `content/` folder) is deployed to a **Netlify static site** (a JSON
  manifest plus asset files). No server code required — Netlify serves static files over HTTPS.
  HTTPS matters beyond privacy here: Service Workers and Cache Storage require a secure context, so
  the offline story depends on the display being loaded over `https://`.
- The display polls `<publishUrl>/content/version.json` on an interval (`syncIntervalMinutes` in
  `content/settings.json`) and on load.
- No credentials are embedded in anything the television loads — the Netlify site is a public
  read-only content endpoint. Gallery/calendar/Instagram access stays on the PC side, in the
  sync/authoring layer that publishes to Netlify.

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
