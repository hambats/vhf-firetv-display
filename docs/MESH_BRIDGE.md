# Mesh bridge (optional, off by default)

The display APK (v1.2.0+) can carry a Meshtastic radio onto the tailnet. A node near the
television, powered from its USB port, is reached over BLE by `MeshBridgeService`, which exposes
it on **TCP 4403** — the standard Meshtastic network API — bound only to the Tailscale `tun`
interface's 100.x address and loopback (never to a LAN interface, even one in 100.64/10). To
anything on the tailnet, the television looks like a Wi-Fi Meshtastic node.

The bridge never touches the display. It runs in its own `:mesh` process, so even a
crash in it cannot take the WebView down; inside that process a crashed bridge is torn down and
restarted after a growing delay (10 s doubling to 10 min). It starts with the display, on boot,
and after `adb install -r` — the last one restarts the bridge only, never the display.

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
meshtastic --port COMx --set lora.region US --set device.role CLIENT --set bluetooth.enabled true --set bluetooth.mode FIXED_PIN --set bluetooth.fixed_pin 123456
```

```bash
meshtastic --port COMx --set-owner "VHF TV Relay" --set-owner-short VHFT
```

Unpair any phone from it — a node takes one BLE client.

## 2. Install and place

```bash
adb install -r app/build/outputs/apk/release/app-release.apk
```

Power the node from the TV's USB port, on an extension so it sits at a window with the antenna
vertical. If the node goes dark when the TV is in standby, use a 5V wall adapter instead.

## 3. Let the TV scan (once)

Android 9 needs location permission for BLE scans:

```bash
adb shell pm grant org.veteranshealingfarm.display android.permission.ACCESS_COARSE_LOCATION
```

```bash
adb shell am broadcast -a org.veteranshealingfarm.display.MESH_SCAN -n org.veteranshealingfarm.display/.MeshConfigReceiver
```

After ~8 s the log lists every Meshtastic node heard, strongest first, e.g.
`scan: VHFT_89ab  F1:23:45:67:89:AB  rssi=-58  [matches 'VHF']` (the advertised name comes from the
node's owner name; the flag marks names auto-pick would accept). Better than about -80 is a solid link;
use it to choose where the node sits. "No nodes heard" with one powered nearby usually means
Fire OS location is off.

## 4. Turn it on

Name the node explicitly (preferred — the address from the scan above):

```bash
adb shell am broadcast -a org.veteranshealingfarm.display.MESH_CONFIG -n org.veteranshealingfarm.display/.MeshConfigReceiver --ez enabled true --es node F1:23:45:67:89:AB --es pin 123456
```

Or auto-pick: with no node set, the bridge takes the strongest node **whose advertised name
contains `VHF`** (case-insensitive) and remembers it. A louder node with any other name — a
neighbour's, a passer-by's — is never taken. Change the match with `--es match <text>`:

```bash
adb shell am broadcast -a org.veteranshealingfarm.display.MESH_CONFIG -n org.veteranshealingfarm.display/.MeshConfigReceiver --ez enabled true --es pin 123456
```

If nothing matching is heard it keeps looking with a backoff (5 s up to 60 s between 10 s scans),
and after 10 empty scans only once every 30 minutes, so a missing node does not keep the TV's
Bluetooth busy.

Other settings:

- `--ez forget true` forgets the node so it auto-picks again. (`--es node ''` does the same when
  it reaches the TV, but run from a PC shell the empty argument is usually lost on the way
  through `adb shell`; use `forget`.)
- `--ez enabled false` turns the bridge off.
- Only the extras you pass change anything: `--ez enabled true` on its own keeps the saved node,
  PIN and match, and doubles as a manual restart of the bridge.

Settings survive reboots and upgrades.

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
  { "src": ["100.84.23.92"], "dst": ["100.69.183.1"], "ip": ["tcp:4403"] }
]
```

This only narrows anything once the policy's default allow-all rule is replaced; adb (5555) needs
its own grant then too.

## Troubleshooting

| Symptom | Fix |
|---|---|
| PIN prompt on the TV screen | Auto-PIN was refused; enter `123456` with the remote once. |
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
