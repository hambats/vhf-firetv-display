# Putting the display on the television

One-time setup. After this, the television shows the VHF display whenever it is on, and
nobody has to touch it again. Content changes are published from the PC and appear on the
television on their own — **changing content never requires reinstalling this app.**

## What gets installed

`VHF Display` — an app whose entire job is to show
`https://hambats.github.io/vhf-firetv-display/` fullscreen, forever.

It is not a browser. There is no address bar, no menu, and the remote cannot navigate away
from the display. It keeps the screen awake, and it puts itself back together after a
network outage or a crash.

On the Fire TV home row it appears as the VHF seal on a dark green tile with the farm's
name beside it. Both the tile and the app icon are generated from
`content/artwork/brand/vhf-logo.webp` — the same logo file the display itself uses. If the
logo ever changes, regenerate them with `python scripts/generate-app-icons.py` and rebuild;
they are checked in, so a normal build does not need Python.

Build it from this project with:

```bash
./gradlew :app:assembleRelease
```

The APK lands at `app/build/outputs/apk/release/app-release.apk` (a copy is kept in
`release/`). It is about 3 MB.

## Step 1 — allow sideloading on the television

On the Fire TV: **Settings → My Fire TV → Developer Options**

- **ADB debugging** → On
- **Apps from Unknown Sources** → On

If *Developer Options* is not in the menu, open **Settings → My Fire TV → About**, highlight
*Fire TV* and press Select seven times. It appears after that.

While you are in Settings, note the television's IP address:
**Settings → My Fire TV → About → Network**.

## Step 2 — install the app

From the PC, on the same network as the television:

```bash
adb connect TV_IP_ADDRESS:5555
```

The television shows an "Allow USB debugging?" prompt the first time. Accept it, tick
*Always allow*, then:

```bash
adb install -r release/vhf-display-1.0.0.apk
```

`-r` reinstalls over an existing copy without losing anything. When it prints `Success`:

```bash
adb disconnect
```

## Step 3 — stop the television going to sleep

The app holds the screen on while it is in front, but Fire OS has its own timers that can
still take the screen down. Turn them off:

- **Settings → Display & Sounds → Display → Screen Saver**
  - *Start Delay* → **Never**
- **Settings → Preferences → Sleep Timer**
  - → **Never**

Both matter. The screen saver is the one that usually bites.

## Step 4 — launch it, and leave it

The app appears on the Fire TV home row as **VHF Display**. Open it once. Move it to the
front of the app row so it is easy to find if it is ever needed again.

That is the end of setup.

## Turning the television off and on

The app tries to relaunch itself when the television boots, but Fire OS does not guarantee
this for sideloaded apps and the Fire TV home screen sometimes wins the race. If the
television comes up on the Fire TV home screen instead of the display, open **VHF Display**
from the app row. That is the whole recovery procedure.

Leaving the television on is the more reliable setup, and what the display is designed for.

## If the display is not showing

| What is on screen | What it means | What to do |
|---|---|---|
| "Reconnecting" on a dark green background | The television has no network yet | Nothing — it retries on its own, at most once a minute |
| A frozen image | Rare; the watchdog should have caught it | Hold BACK to exit, reopen VHF Display |
| The Fire TV home screen | The television rebooted | Open VHF Display from the app row |
| The display is old content | The PC has not published yet | Publish from the PC; the page picks it up on its own |

To exit the app deliberately, **press and hold BACK**. A short press does nothing — that is
on purpose, so a stray remote press cannot take the display down.

## Changing where the display points

The URL lives in one place: `display_url` in
`app/src/main/res/values/strings.xml`. Changing it requires a rebuild and a reinstall, which
is why it is the only thing in the app that ever needs one.
