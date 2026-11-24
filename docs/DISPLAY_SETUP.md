# Putting the display on the television

One-time setup. After this, the television shows the VHF display whenever it is on, and
nobody has to touch it again. Content changes are published from the PC and appear on the
television on their own — **changing content never requires reinstalling this app.**

## What gets installed

`VHF Display` — an app whose entire job is to show
`https://hambats.github.io/vhf-firetv-display/` fullscreen, forever.

It is not a browser. There is no address bar and no menu, and the page cannot navigate away
from the display. It keeps the screen awake while it is in front, and it puts itself back
together after a network outage or a crash.

The television is shared with residents after hours, so the app is built to stay out of
their way: it never brings itself to the front (the one exception is a boot with the TV
already on, below), never switches the panel on, and leaves HOME, volume, mute, power and
media keys to the television.

Since 1.3.0 the app contains no Bluetooth or mesh code; the optional Meshtastic bridge is a
separate APK (see [MESH_BRIDGE.md](MESH_BRIDGE.md)).

On the Fire TV home row it appears as the VHF seal on a dark green tile with the farm's
name beside it. Both the tile and the app icon are generated from
`content/artwork/brand/vhf-logo.webp` — the same logo file the display itself uses. If the
logo ever changes, regenerate them with `python scripts/generate-app-icons.py` and rebuild;
they are checked in, so a normal build does not need Python.

Build it from this project with:

```bash
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew :app:testReleaseUnitTest :app:assembleRelease
```

The APK lands at `app/build/outputs/apk/release/app-release.apk` (keep a copy in `release/`
as `vhf-display-<version>.apk`). It is about 6.7 MB since 1.3.0: with minSdk 28 the build
stores the code uncompressed so Android can map it directly, which makes the file bigger but
not the installed app.

The release build is signed with the PC's `~/.android/debug.keystore`. **Every build must be
signed with that same key**, or Android refuses to install it over the existing app and it
has to be uninstalled first. Back that file up.

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
adb install -r release/vhf-display-1.3.0.apk
```

`-r` reinstalls over an existing copy without losing anything. When it prints `Success`:

```bash
adb disconnect
```

### Upgrading an installed copy (for example 1.2.1 to 1.3.0)

The same command, from anywhere on the tailnet (see [REMOTE_ACCESS.md](REMOTE_ACCESS.md)).
Same app id and same signing key, so it replaces the old version in place; nothing needs to
be uninstalled. Installing stops the running app. **It does not start it again**, and it never
switches the screen on: the display comes back the next time someone opens VHF Display, or
at the next boot with the television on. So upgrade during opening hours, when the display
was what was on screen, and then reopen it: on site from the app row, or remotely with
`adb shell am start -n org.veteranshealingfarm.display/.DisplayActivity`. That command
brings the display to the front, so never run it while a resident might be using the TV.

Check what is installed:

```bash
adb shell dumpsys package org.veteranshealingfarm.display | grep versionName
```

**Upgrading to 1.3.0 removes the Meshtastic bridge**, which 1.2.x carried inside this app. It
stays off until the separate mesh APK is installed and configured; see
[MESH_BRIDGE.md](MESH_BRIDGE.md).

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

When the television boots (after a power cut, an update, or a restart), the app starts the
display **only if the television is actually on** at that moment: the screen is lit and the
set is awake. If it boots into standby, for example when power comes back at night, the
app does nothing and the panel stays dark; the display appears when someone next turns the
TV on and opens VHF Display. The app never switches the screen on by itself.

Even with the TV on, Fire OS does not guarantee the boot start for sideloaded apps, and the
Fire TV home screen sometimes wins the race. If the television comes up on the Fire TV home
screen instead of the display, open **VHF Display** from the app row. That is the whole
recovery procedure.

Leaving the television on is the more reliable setup, and what the display is designed for.

## The remote

| Key | What it does while the display is in front |
|---|---|
| **HOME** | Goes to the Fire TV home screen, as always. The display keeps running behind it. |
| **BACK**, short press | Nothing. A stray press cannot close the display. |
| **BACK**, held for about a second | Steps the display aside: it moves behind whatever was open before (normally the home screen). It does not close and does not come back by itself. |
| Volume, mute, power, play/pause and other media keys, input | Handled by the television as usual. |
| D-pad, select, menu | Nothing (nothing on the display is interactive). |

To leave the app, press **HOME** or hold **BACK**. To bring the display back, open
**VHF Display** from the app row. (Before 1.3.0, holding BACK did not work and a short BACK
woke the page from closed-day black; neither is true any more.)

## If the display is not showing

| What is on screen | What it means | What to do |
|---|---|---|
| "Reconnecting" on a dark green background | The television has no network yet | Nothing — it retries on its own, at most once a minute |
| A frozen image | Rare; the watchdog should have caught it | Press HOME, then reopen VHF Display |
| The Fire TV home screen | The television rebooted, or someone pressed HOME or held BACK | Open VHF Display from the app row |
| The display is old content | The PC has not published yet | Publish from the PC; the page picks it up on its own |

## Looking inside the running page (no rebuild)

Since 1.3.0 the app allows remote WebView inspection. It is reachable only through adb, so it
opens nothing that adb access does not already give. With adb connected to the TV
(REMOTE_ACCESS.md):

```bash
adb shell pidof org.veteranshealingfarm.display
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid from above>
```

Then open `chrome://inspect` in Chrome on the PC (or `http://localhost:9222/json` for the
raw list) and click *inspect* under the VHF page: console, network, Service Worker and
storage, live. The pid changes whenever the app restarts, so redo the forward then.

**Diagnostics overlay without a rebuild:** in that DevTools console, run
`location.search = '?diag=1'`. The page's own reloads keep it; it goes away the next time the
app itself loads the site from scratch (a network retry, a renderer rebuild, or the app
restarting). `location.search = ''` turns it off. Only do this while the display, not a
resident's programme, is on screen.

App logs: `adb logcat -s VhfDisplay VhfRenderer`.

## Changing where the display points

The URL lives in one place: `display_url` in
`app/src/main/res/values/strings.xml`. Changing it requires a rebuild and a reinstall, which
is why it is the only thing in the app that ever needs one. Raise `versionCode` in
`app/build.gradle.kts` with every APK you install, or `adb install -r` refuses it.
