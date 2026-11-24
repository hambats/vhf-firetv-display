# Mesh bridge (optional, off by default)

A separate APK, **VHF Mesh Bridge** (`org.veteranshealingfarm.meshbridge`, Gradle module
`mesh/`), carries a Meshtastic radio onto the tailnet. A node near the television, powered from
its USB port, is reached over BLE by `MeshBridgeService`, which exposes it on **TCP 4403** —
the standard Meshtastic network API — bound only to the Tailscale `tun` interface's 100.x
address and loopback (never to a LAN interface, even one in 100.64/10). To anything on the
tailnet, the television looks like a Wi-Fi Meshtastic node.

The bridge never touches the display. It is its own app with no activity, no launcher tile and
nothing that can appear on screen; it shares no code with the display and the display does not
depend on it. Inside it, a crashed bridge is torn down and restarted after a growing delay
(10 s doubling to 10 min). It starts on boot (a service only, whether or not the TV is on),
after `adb install -r` of the mesh APK, and whenever it is configured.

## Moving from display 1.2.x (read this first)

Display 1.2.0 and 1.2.1 carried the bridge **inside the display APK**, and on the television it
is enabled there today. **Installing display 1.3.0 removes it**: from then on there is no bridge
on the TV until this mesh APK is installed and configured again (sections 2–4). Things to know:

- Its settings do not carry over. They lived in the display app's private storage, and this is a
  different package. Re-enter the node address and PIN with the new `MESH_CONFIG` broadcast.
- The broadcast actions and the component changed from `org.veteranshealingfarm.display…` to
  `org.veteranshealingfarm.meshbridge…`. The old commands do nothing on 1.3.0.
- The BLE bond with the node is kept by Fire OS, not by the app, so the node normally does not
  need pairing again.
- Location permission must be granted again, to the new package (section 3).
- There is no default pairing PIN any more (1.2.x fell back to a built-in one). Without
  `--es pin`, the bridge does not answer a pairing request; it logs
  `pairing requested but no PIN is configured`, and Fire OS shows its own PIN prompt instead.
- MESH_BRIDGE.md used to say the RAK4631 was "not yet tested on the TV", while the 1.2.1 commit
  says the bridge restarted with its saved node. Confirm with
  `adb logcat -s VhfMesh` after setup which is true before relying on it.

All commands below run from a PC with ADB connected to the TV (see REMOTE_ACCESS.md). Every
result shows up in the log:

```bash
adb logcat -s VhfMesh
```

## 1. Prepare the node (once, over USB on the PC)

Intended node: RAK4631 WisBlock (not yet tested on the TV). **Fit the LoRa antenna before powering it.** Flash a current
2.x release from https://flasher.meshtastic.org (older firmware has a different BLE layout).
Then, with `COMx` being the node's port (not the bot's COM5/COM8):

```bash
meshtastic --port COMx --seturl "<your mesh channel URL>"
```

```bash
meshtastic --port COMx --set lora.region US --set device.role CLIENT --set bluetooth.enabled true --set bluetooth.mode FIXED_PIN --set bluetooth.fixed_pin <pairing PIN>
```

```bash
meshtastic --port COMx --set-owner "VHF TV Relay" --set-owner-short VHFT
```

Unpair any phone from it — a node takes one BLE client.

## 2. Install and place

Build and test it from the repo root (it is independent of the display app):

```bash
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew :mesh:testReleaseUnitTest :mesh:assembleRelease
```

```bash
adb install -r mesh/build/outputs/apk/release/mesh-release.apk
```

Like the display, it is signed with the PC's `~/.android/debug.keystore`; later builds must use
the same key to install over it. Raise `versionCode` in `mesh/build.gradle.kts` for each new
install. Installing or upgrading it never touches the display.

Power the node from the TV's USB port, on an extension so it sits at a window with the antenna
vertical. If the node goes dark when the TV is in standby, use a 5V wall adapter instead.

## 3. Let the TV scan (once)

Android 9 needs location permission for BLE scans:

```bash
adb shell pm grant org.veteranshealingfarm.meshbridge android.permission.ACCESS_COARSE_LOCATION
```

```bash
adb shell am broadcast --include-stopped-packages -a org.veteranshealingfarm.meshbridge.MESH_SCAN -n org.veteranshealingfarm.meshbridge/.MeshConfigReceiver
```

A freshly installed app with no activity is in Android's "stopped" state, and broadcasts skip
stopped apps unless `--include-stopped-packages` is given. Keep the flag on every command below;
it is harmless once the app has run. The first broadcast it receives also lets it receive
`BOOT_COMPLETED` from then on.

After ~8 s the log lists every Meshtastic node heard, strongest first, e.g.
`scan: VHFT_89ab  F1:23:45:67:89:AB  rssi=-58  [matches 'VHF']` (the advertised name comes from the
node's owner name; the flag marks names auto-pick would accept). Better than about -80 is a solid link;
use it to choose where the node sits. "No nodes heard" with one powered nearby usually means
Fire OS location is off.

## 4. Turn it on

Name the node explicitly (preferred — the address from the scan above):

```bash
adb shell am broadcast --include-stopped-packages -a org.veteranshealingfarm.meshbridge.MESH_CONFIG -n org.veteranshealingfarm.meshbridge/.MeshConfigReceiver --ez enabled true --es node F1:23:45:67:89:AB --es pin "<pairing PIN>"
```

`<pairing PIN>` is a placeholder: use the node's `bluetooth.fixed_pin` from section 1. Keep the
real PIN out of this repository (it is public) and out of any file that is committed; there is
no default in the code.

Or auto-pick: with no node set, the bridge takes the strongest node **whose advertised name
contains `VHF`** (case-insensitive) and remembers it. A louder node with any other name — a
neighbour's, a passer-by's — is never taken. Change the match with `--es match <text>`:

```bash
adb shell am broadcast --include-stopped-packages -a org.veteranshealingfarm.meshbridge.MESH_CONFIG -n org.veteranshealingfarm.meshbridge/.MeshConfigReceiver --ez enabled true --es pin "<pairing PIN>"
```

If nothing matching is heard it keeps looking with a backoff (5 s up to 60 s between 10 s scans),
and after 10 empty scans only once every 30 minutes, so a missing node does not keep the TV's
Bluetooth busy.

Other settings:

- `--ez forget true` forgets the node so it auto-picks again. (`--es node ''` does the same when
  it reaches the TV, but run from a PC shell the empty argument is usually lost on the way
  through `adb shell`; use `forget`.)
- `--ez enabled false` turns the bridge off.
- `--es pin ''` clears the PIN (there is no default to fall back to).
- Only the extras you pass change anything: `--ez enabled true` on its own keeps the saved node,
  PIN and match, and doubles as a manual restart of the bridge.

Settings survive reboots and upgrades of the mesh APK (not a move between packages; see above).

Expected log: `listening on 100.x.x.x:4403` → `auto-picked …` (if no node set) →
`answered pairing request with configured PIN` (first time) → `BLE connected` →
`Meshtastic service ready` (logged only once notifications are actually enabled on the node).

## 5. Check it from the PC

```bash
meshtastic --host <tv-tailscale-ip> --info
```

Bench test without Tailscale: `adb forward tcp:4403 tcp:4403`, then `meshtastic --host 127.0.0.1`.

## Security: port 4403 has no authentication

The Meshtastic TCP API has no login. Any device that can reach `<tv>:4403` gets the full client
API of the node: it can read the channel keys (`--info` prints them), change the node's
configuration, or factory-reset it. The bridge binds only to the Tailscale and loopback
addresses, so "any device" means **anything on the tailnet** — today every member device, and
the CI runners in `display-monitor.yml`, which join untagged and so get member access.

Limit it with a tailnet policy grant so only the machines that need the radio can reach 4403,
for example only the development PC:

```json
"grants": [
  { "src": ["<dev PC tailnet address>"], "dst": ["<tv tailnet address>"], "ip": ["tcp:4403"] }
]
```

This only narrows anything once the policy's default allow-all rule is replaced; adb (5555) needs
its own grant then too.

## Troubleshooting

| Symptom | Fix |
|---|---|
| PIN prompt on the TV screen | No PIN configured (log: `no PIN is configured`) — set `--es pin`; or auto-PIN was refused — enter the pairing PIN with the remote once. Either way the prompt appears over whatever is on screen, so do this when no resident is using the TV. |
| Nothing at all in the log after a broadcast | The app is still in the "stopped" state: add `--include-stopped-packages`. |
| `not a Meshtastic node (service missing)` | Old firmware or wrong address; reflash or rescan. |
| `FromNum subscription failed (status=5)` or `(status=15)`, repeating | Wrong PIN, or a **stale bond**: a reflashed or factory-reset node forgets its pairing but the TV does not. Unpair the node on the TV (Settings → Controllers & Bluetooth Devices → the node → Unpair), then let the bridge reconnect. |
| Connects and drops repeatedly | Another device (phone) holds the node, or it's too far away. |
| `no node named like 'VHF' heard` | Nothing with that name in range; check the node's owner name or use `--es node`. |
| `refusing client …: radio link not ready` | The TCP client connected while the radio link was down; it is closed at once. Retry once the log says `Meshtastic service ready`. |
| `no Tailscale address yet; loopback only` | Tailscale is down on the TV; rechecked every 30 s. |

## Limits

- One TCP client at a time; a new connection replaces the old one.
- TCP clients are accepted only while the radio link is up, and are disconnected whenever it
  drops, so they reconnect and resynchronise — as with a Wi-Fi node that rebooted.
- With no client connected the bridge does not read from the node, so incoming packets wait in
  the node's own (small) queue for the next client, as on a Wi-Fi node.
- A node allows one BLE client, so phones can't connect to this node while the TV holds it.
