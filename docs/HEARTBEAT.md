# Heartbeat: knowing the display is alive

The display pings a free [healthchecks.io](https://healthchecks.io) check every 10 minutes, but
only while it is genuinely working: it is the television (the bare site URL in the Fire TV
WebView, never a `?slide=` embed or someone's browser), the page is visible (not behind Netflix or
the launcher), scenes are advancing, and it is an open day inside `hours.open`. Silence anywhere
else is correct, so the check is scheduled to expect pings only then. Code: `startHeartbeat` in
`web/js/engine.js`. Shipped **off** (`heartbeat.url` is `""`).

## One-time setup

1. Sign up at healthchecks.io (free plan) and **Add Check**. Name it `VHF display`.
2. **Schedule** → choose **Cron**:
   - Cron expression: `*/10 10-15 * * 2-6` for open 10:00-16:00, Tuesday to Saturday.
     Hours field = first hour open to the last hour before closing; weekdays = every day *not*
     in `hours.closedWeekdays` (0 = Sunday). Change both if the farm's hours change.
   - Time zone: `America/New_York` (handles daylight saving).
   - Grace time: **30 minutes**.
3. **Integrations**: the email integration is on by default; add SMS/Signal/etc. if wanted.
4. Copy the check's ping URL (`https://hc-ping.com/<uuid>`) into `content/settings.json`, and set
   the same opening window there (the validator refuses a URL without it):
   ```json
   "hours": { "closedWeekdays": [0, 1], "open": { "from": "10:00", "to": "16:00" } },
   "heartbeat": { "url": "https://hc-ping.com/<uuid>", "intervalMinutes": 10 }
   ```
5. `npm run publish`. Within ~20 minutes of opening hours the check should turn green and each
   ping's body (click a ping in the log) shows what the TV reports. If none ever arrive while the
   display is visibly running, tell Claude: the user-agent test that recognises the TV
   (`isTelevision` in engine.js) is the first suspect.

The ping URL is public (it is in the published settings). Anyone could send fake "alive" pings
with it, but nobody can read anything through it. If it is abused, regenerate it in healthchecks.

## What a ping carries

A few hundred bytes of text: content version, uptime, error and failed-image counts, number of
upcoming events, the scene on screen, and the compatibility probe (Chromium version, user agent,
which modern JS/CSS/image features the WebView supports). Nothing personal.

## What an alert means

During opening hours on an open day, no ping for 30+ minutes after one was due. Any of: the TV is
off or in standby; another app or input is in front; the Wi-Fi or internet is down; the page has
frozen or stopped advancing scenes; the app crashed and did not come back. First step: run
`node scripts/check-display.mjs` over Tailscale (docs/REMOTE_ACCESS.md) to see which.

## What it cannot tell you

- Whether the picture looks right (a black photo, a broken layout, stale-but-running content).
  The ping body's content version and event count are the only hints.
- Anything on closed days or outside `hours.open`: nothing is expected then, by design.
- Why it went silent. Healthchecks only knows pings stopped.
- A failure that lasts less than the 30-minute grace.
- Whether healthchecks itself is down (rare; the free plan has no status guarantee).
