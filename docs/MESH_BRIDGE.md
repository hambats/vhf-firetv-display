# Mesh bridge (optional, off by default)

The display APK (v1.2.0+) can carry a Meshtastic radio onto the tailnet. A node near the
television, powered from its USB port, is reached over BLE by `MeshBridgeService`, which exposes
it on **TCP 4403** — the standard Meshtastic network API — bound to the TV's Tailscale address
and loopback only. To anything on the tailnet, the television looks like a Wi-Fi Meshtastic node.

The bridge never touches the display: if it fails it logs and retries on its own.

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
`scan: VHF TV Relay_89ab  F1:23:45:67:89:AB  rssi=-58`. Better than about -80 is a solid link;
use it to choose where the node sits. "No nodes heard" with one powered nearby usually means
Fire OS location is off.

## 4. Turn it on

Auto-pick (takes the strongest node heard and remembers it):

```bash
adb shell am broadcast -a org.veteranshealingfarm.display.MESH_CONFIG -n org.veteranshealingfarm.display/.MeshConfigReceiver --ez enabled true --es pin 123456
```

Or name the node explicitly, if a neighbour's node might be louder:

```bash
adb shell am broadcast -a org.veteranshealingfarm.display.MESH_CONFIG -n org.veteranshealingfarm.display/.MeshConfigReceiver --ez enabled true --es node F1:23:45:67:89:AB --es pin 123456
```

`--es node ''` forgets the node so it auto-picks again; `--ez enabled false` turns the bridge off.
Settings survive reboots; the bridge starts with the display and on boot.

Expected log: `listening on 100.x.x.x:4403` → `auto-picked …` (if no node set) →
`answered pairing request with configured PIN` (first time) → `BLE connected` →
`Meshtastic service ready`.

## 5. Check it from the PC

```bash
meshtastic --host <tv-tailscale-ip> --info
```

Bench test without Tailscale: `adb forward tcp:4403 tcp:4403`, then `meshtastic --host 127.0.0.1`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| PIN prompt on the TV screen | Auto-PIN was refused; enter `123456` with the remote once. |
| `not a Meshtastic node (service missing)` | Old firmware or wrong address; reflash or rescan. |
| Connects and drops repeatedly | Another device (phone) holds the node, or it's too far away. |
| `no Tailscale address yet; loopback only` | Tailscale is down on the TV; rechecked every 30 s. |

## Limits

- One TCP client at a time; a new connection replaces the old one.
- A node allows one BLE client, so phones can't connect to this node while the TV holds it.
