# M3 soak procedure — 72-hour unattended run

Referenced by `docs/BUILD_TREE.md` §1 (M3) and §2 (file tree). This is a checklist for a human
to run against the physical Fire TV — it cannot be automated, because the thing under test is
unattended behavior over real wall-clock time. It produces the raw material for
`docs/RUNBOOK.md` and `docs/RELIABILITY.md`, which get written *after* this runs, from whatever
actually happens here. Do not write those two docs from this checklist in advance.

Cross-reference [`docs/DISPLAY_SETUP.md`](../../docs/DISPLAY_SETUP.md) for every device-specific
step (sideloading, ADB, TV sleep settings). This document does not repeat those steps.

---

## 0. Before starting

- [ ] Publish current content: `npm run publish` from the PC, and confirm it reports the live
      `content/version.json` advanced (that's what `publish.mjs` verifies at the end of its run).
- [ ] Confirm the app installed on the TV is pointed at the live `publishUrl`
      (`display_url` in `app/src/main/res/values/strings.xml` — check the built APK matches
      the checked-in value, not a stale sideload). If in doubt, rebuild and reinstall per
      `DISPLAY_SETUP.md` Step 2.
- [ ] Confirm TV sleep/screensaver settings are off (`DISPLAY_SETUP.md` Step 3). A soak that
      fails because the screen slept is not a display bug — recheck before blaming the app.
- [ ] Note the exact events/announcements currently live, so "is it showing current content"
      has a concrete answer for the next 3 days (write down 2–3 titles + dates you expect to
      see on screen).
- [ ] Record the starting `content/version.json` value and timestamp.

### Turning on `?diag=1` for day one

**The URL is hardcoded** (`display_url` in `strings.xml`) and the shell does not pass through
window-managed query params or accept remote input to modify the URL — there is no way to
append `?diag=1` to a running install without changing that string. To run day one with
diagnostics visible:

1. Temporarily edit `display_url` in `app/src/main/res/values/strings.xml` to append
   `?diag=1` (e.g. `https://hambats.github.io/vhf-firetv-display/?diag=1`).
2. `./gradlew :app:assembleRelease`, then `adb install -r` the result per `DISPLAY_SETUP.md`
   Step 2. This is a temporary build for the soak only — do not check in the `?diag=1` URL.
3. After ~24 hours of observation (step 2 below), revert `strings.xml`, rebuild, and
   reinstall to run the remaining ~48 hours without the overlay, matching how the display
   actually runs in production (the overlay is a debugging aid, not the shipped state).
4. Note the exact times of both installs in your log (§3) — they are themselves brief
   interruptions and should not be mistaken for a spontaneous restart.

If ADB access to the TV is inconvenient for two extra installs, an acceptable alternative is
running the full 72 hours with `?diag=1` on throughout, and noting in the log that the overlay
was left visible for the whole run rather than just day one — but note this as a deviation.

---

## 1. Daily / periodic check cadence

Check **at least once a day**, ideally morning and evening for the first day (when `?diag=1`
is on and cheap to read). Each check, record in the log (§3):

- [ ] **Current content** — does the on-screen event/announcement match what you'd expect
      given today's date and the events noted in §0? (Photos rotating is not evidence of
      this — check an `event`/`event-pool`/`announcement` scene specifically.)
- [ ] **Scenes advancing** — watch for at least one full scene transition (don't just glance
      once). A display frozen on one scene for the entire observation window is a stall.
- [ ] **Visible errors** — anything resembling `renderError` text, a blank/black frame outside
      quiet hours, a broken image rectangle, or garbled layout.
- [ ] **Uptime counter** (`?diag=1` only) — should climb continuously. A reset to near-zero
      between two checks means a reload happened; note whether it lines up with a periodic
      6-hour reload, a version bump, or something unexplained.
- [ ] **Error count** (`?diag=1` only) — should stay flat between checks. Any increase: note
      the new `err` value and whatever `last error` shows.
- [ ] **Cache hit/miss and failed-image counts** (`?diag=1` only) — a growing miss or failed
      count with no corresponding network outage is worth flagging even if nothing is visibly
      wrong yet.

---

## 2. Failure scenarios to actively induce

Passive observation only proves the display didn't crash on its own; it doesn't exercise the
specific mechanisms M1/M2 claim to have built. Induce each of these at least once during the
72 hours, spaced out so recovery from one doesn't mask a problem with the next.

### 2.1 Network outage and recovery
- [ ] Pull power/network to the router (or otherwise cut the TV's connectivity) for at least
      5 minutes.
- [ ] While offline: confirm the display keeps playing from cache — scenes still advance,
      cached photos still show, no blank screen.
- [ ] Restore the network. Confirm the display resumes normal operation (version poll
      succeeds again) without any manual action.
- [ ] Record how long after network restoration the display visibly recovered (poll interval
      is `syncIntervalMinutes` = 20 minutes in `content/settings.json`, so recovery of the
      *poll* should be at most one interval — recovery of *connectivity itself*, e.g. image
      loads, should be near-immediate).

### 2.2 App/TV restart while offline
- [ ] With the network still down (or immediately after cutting it), force-close the app (or
      power-cycle the TV) and reopen/relaunch it.
- [ ] Confirm it does **not** go blank or get stuck on a "Reconnecting" screen forever — the
      Service Worker should serve the cached shell so the display still shows cached content
      even though the app just cold-started with no network.
- [ ] Restore the network afterward and confirm normal operation resumes.

### 2.3 Content update mid-run
- [ ] With the display running normally (network up), make a real content change on the PC
      (e.g. add/edit an announcement or event) and run `npm run publish`.
- [ ] Confirm `publish.mjs` reports the version advanced.
- [ ] Without touching the TV, wait up to `syncIntervalMinutes` (20 min) plus one scene
      boundary, and confirm the new content appears on screen with no manual restart.
- [ ] Record the publish timestamp and the timestamp you first observed the new content on
      screen; the gap should be well under 20 minutes plus one scene dwell.

### 2.4 Periodic 6-hour reload
- [ ] Let the display run through at least one (ideally several) of the periodic 6-hour
      reload points uninterrupted.
- [ ] Confirm the reload is unnoticeable — no visible flash of a broken/blank layout, no
      stuck loading state, no error.
- [ ] Confirm the uptime counter (`?diag=1`, day one) resets at that point rather than
      continuing to climb, and that the reset time lines up with roughly 6 hours since the
      last reset/start — this is the evidence the reload actually fired on schedule rather
      than the display having crashed and restarted for some other reason.

---

## 3. What to record

Keep a single running log (plain text or spreadsheet, whatever's convenient) with one row per
check or induced test. Minimum fields:

| Field | Notes |
|---|---|
| Timestamp | Exact, not "morning" |
| Check type | Routine check / 2.1 network / 2.2 offline restart / 2.3 content update / 2.4 reload / other |
| `?diag=1` overlay contents (day one only) | Copy the full line: uptime, version, last sync, sw state, cache h/m, failed images, error count, current scene, last error |
| What was observed | Plain description — what was on screen, did it match expectation |
| Anything broken | If yes: exact symptom, how long it lasted, whether/how it self-recovered, whether manual intervention was needed |
| Recovery time | For induced failures — time from inducing the failure to visible recovery |

Be specific and literal rather than summarizing as "fine" — the point of this log is to be raw
material for `docs/RUNBOOK.md` (recovery steps for VHF staff) and `docs/RELIABILITY.md`
(failure modes and which mechanism handles each, including gaps), both written after the soak
from what this log actually contains, not from memory of "it mostly worked."

---

## 4. Exit criteria

**Pass** — all of the following true at the end of 72 hours:

- The display is still running and showing content that matches what's actually current
  (i.e., it picked up whatever was published during the run, not stale content from the
  start).
- §2.1 (network outage) was induced at least once: the display kept playing cached content
  offline and resumed normal operation on its own after the network returned.
- §2.2 (offline app/TV restart) was induced at least once: the display did not go blank; it
  came back showing cached content without a manual reinstall or config change.
- §2.3 (content update) was induced at least once: the published change appeared on screen
  within `syncIntervalMinutes` plus one scene boundary, with no manual restart.
- §2.4 (periodic reload) was observed at least once: no visible glitch, and the uptime
  counter behavior confirms the reload happened on the expected ~6-hour cadence.
- No unexplained visible error text or persistently blank/frozen screen at any daily check
  outside quiet hours.

This matches the M1 ship-gate language directly: pulling the router and closing/reopening the
browser (app) still leaves the display playing, photos included, and a week (or the 72-hour
window here) later it's still showing current content.

**Fail** — any of the following, and it goes back to code before M3 can close:

- The display required manual intervention (restart, reinstall, config change) to recover
  from a network outage, an offline app restart, or a periodic reload.
- A content update did not appear within the expected window without a manual restart.
- The display went blank, froze on one scene, or showed visible error text for longer than
  one check interval without self-recovering.
- Any induced scenario in §2 could not be completed as described (e.g. the network cut had
  no observable effect either way, which itself means the offline path wasn't actually
  exercised and needs to be retried before the soak can be called complete).

If it fails, capture the failure in the log (§3) with as much detail as possible — that
failure record is exactly what `docs/RELIABILITY.md` needs, whether or not it's what anyone
hoped to find.
