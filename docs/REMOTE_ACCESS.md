# Reaching the television from off-site

Set up Sept 19, 2026, at the farm. This records what exists, why two settings are the way
they are, and the one piece of routine maintenance that will otherwise break it silently.

## What this does and does not buy

Tailscale gives **access**, not **awareness**. From anywhere you can install a new APK, pull
a screenshot, read logcat, restart the display — everything that previously required standing
in front of the television. What it does not do is tell you something is wrong. If the display
dies on a Friday, nothing here notices; it just means the fix is quick once you find out.

The complement is an outbound heartbeat, which is **not built**. `web/js/diagnostics.js`
already records uptime, error counts and the last error — it has nowhere to send them. That
remains the higher-value piece of work for an unattended display.

## The addresses

| Device | Tailnet address | Node name |
|---|---|---|
| The television (Toshiba AFTTI43) | `100.69.183.1` | `nicoles-tv` |
| Development PC | `100.84.23.92` | `desktop-m8kebh3` |

Tailnet: `taild0c74d.ts.net`, account `rwlauterbach@`.

The `100.x` address belongs to the device, not the network. It is the same from the farm, from
home, or if the television moves. The farm's router needs no configuration at all — no port
forwarding, no static IP, no dynamic DNS — because both ends connect *outward* to Tailscale's
coordination server, which introduces them and then steps out of the traffic path.

## Using it

```bash
adb connect 100.69.183.1:5555
```

Everything then behaves exactly as it does on the LAN:

```bash
adb -s 100.69.183.1:5555 install -r release/vhf-display-<version>.apk
adb -s 100.69.183.1:5555 shell dumpsys window | grep mCurrentFocus
adb -s 100.69.183.1:5555 shell screencap -p /data/local/tmp/t.png
adb -s 100.69.183.1:5555 pull /data/local/tmp/t.png
```

Two notes from experience: the television drops the ADB connection after a while and needs a
fresh `adb connect`, which is normal and not a fault. And in Git Bash, device paths like
`/data/local/tmp/...` get rewritten into Windows paths — prefix commands with
`MSYS_NO_PATHCONV=1`.

## The two settings, and why

Always-on VPN is what makes this survive a power cut. Without it, Tailscale does not start
after a reboot and the television is reachable only from the farm's own network — which is the
exact situation this exists to avoid.

```bash
adb shell settings put secure always_on_vpn_app com.tailscale.ipn
adb shell settings put secure always_on_vpn_lockdown 0
```

**`secure`, not `global`.** This cost a reboot to find. Writing `always_on_vpn_app` to the
`global` namespace is accepted without error and `settings get global always_on_vpn_app` reads
the value back correctly — it simply has no effect, because Android reads it from `secure`.
The setting looked right and did nothing. If Tailscale ever stops coming back after a reboot,
check which namespace holds the value before anything else.

**Lockdown is deliberately `0`.** Lockdown mode blocks all non-VPN traffic. On a public display
that is the wrong trade: if Tailscale failed to start, the television would show nothing at all
rather than falling back to its normal connection. With lockdown off, a broken VPN costs remote
access and nothing else. The cost of this choice is that a VPN failure is silent — accepted,
because the display staying up matters more.

## Maintenance: disable key expiry

**Tailscale nodes expire by default, typically every 180 days.** When the key for `nicoles-tv`
expires, the television drops off the tailnet with no warning, and the only way to bring it
back is to be physically at the farm — which defeats the entire point.

Disable key expiry for that node in the Tailscale admin console. This is the single piece of
maintenance that matters, and it is one click.

## Verifying it actually works

Only a real reboot tests this. Launching Tailscale by hand brings the tunnel up and proves
nothing about the boot path — during setup that produced a perfectly healthy-looking tunnel
while the boot path was still broken.

```bash
adb -s 100.69.183.1:5555 reboot
```

Then, from the PC, without touching the television:

- `tailscale status` shows `nicoles-tv` without `offline` (took about 10 seconds)
- `adb connect 100.69.183.1:5555` succeeds — drop any LAN connection first, or you will
  test the wrong path
- `adb shell ip -f inet addr show` shows `inet 100.` on `tun0`
- `dumpsys window | grep mCurrentFocus` shows `DisplayActivity` — this also confirms
  `BootReceiver` recovered the display

The last one is worth noting: the Fire TV **does** relaunch the display after a power cut.
`docs/BUILD_TREE.md` §5 records this as "better, not solved" because Fire OS makes no guarantee,
and that caveat stands — but it has now been observed working twice on this device.

## If it stops working

| Symptom | Likely cause |
|---|---|
| `tailscale status` says `offline` | Key expired (see above), or the farm's internet is down |
| Tunnel absent after a reboot | `always_on_vpn_app` in the wrong namespace, or reset by a Fire OS update |
| `adb connect` times out, tailnet fine | ADB debugging switched off by a Fire OS update |
| Reachable but display is dark | Unrelated to any of this — start at `docs/DISPLAY_SETUP.md` |

Nothing here is load-bearing for the display itself. If the whole Tailscale setup vanished, the
television would keep showing content from GitHub Pages exactly as before.
