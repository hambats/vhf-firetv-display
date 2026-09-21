#!/usr/bin/env node
/*
 * Ask the television how it is, from anywhere, over Tailscale.
 *
 *   node scripts/check-display.mjs                 # check, exit non-zero on a fault
 *   node scripts/check-display.mjs --observe       # check and report, never fail
 *   node scripts/check-display.mjs --json out.json # also write the report as JSON
 *
 * Why this exists: nothing noticed a dead display. The television has run
 * unattended for months with exactly one detection mechanism -- a human walking
 * past it. The farm is closed Sunday and Monday, so a Friday evening failure
 * could sit dark in a public building until Tuesday.
 *
 * Why it pulls rather than the page pushing a heartbeat: a heartbeat proves the
 * page's JavaScript ran. This proves what is on the screen. Those differ in
 * ways we have already hit -- after a sleep/wake cycle the television dropped
 * to the Fire TV launcher with our app still perfectly healthy behind it, and a
 * heartbeat would have reported everything fine while the display showed
 * Amazon's home row.
 *
 * It also needs no code on the device. Every probe below is a stock adb command
 * against a stock Fire OS, run as uid `shell`. Nothing is installed, nothing is
 * granted, and the display carries no credential. The Tailscale key that makes
 * the connection lives in CI.
 *
 * What it cannot do: tell "television dead" from "network dead" (both need
 * someone to walk over, so the distinction is academic), and judge whether the
 * content is any *good*. It answers "is it on, is it ours, is it painting".
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const ADB = process.env.VHF_ADB || "adb";
const DEVICE = process.env.VHF_DEVICE || "100.69.183.1:5555";

/*
 * A 1920x1080 screenshot of a real scene is 1-2 MB of PNG. A screen showing
 * flat black compresses to a few KB, because that is what PNG does to a single
 * colour. So file size alone separates "painting something" from "blank" with
 * no image library and no decoding -- worth preferring over a dependency for a
 * check that has to run unattended forever.
 *
 * The threshold is deliberately far below any real frame and far above any flat
 * one; it is not trying to be precise, only unambiguous.
 */
const BLANK_SCREENSHOT_BYTES = 50 * 1024;

const OUR_PACKAGE = "org.veteranshealingfarm.display";

function adb(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(ADB, args, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: "", err: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim(), err: err.trim() });
    });
  });
}

const shell = (cmd) => adb(["-s", DEVICE, "shell", cmd]);

/*
 * The display blanks itself on the farm's closed days rather than lighting an
 * empty building (engine.js, isQuietHours). Sunday and Monday are closed at the
 * time of writing, which is two days in seven where a black screen is the
 * display working correctly. A monitor that cannot tell those apart would cry
 * wolf 29% of the time, and an alert nobody trusts is the same as no alert.
 */
export function isClosedDay(settings, now = new Date()) {
  const closed = (settings && settings.hours && settings.hours.closedWeekdays) || [];
  if (closed.length === 0) return false;
  const tz = settings && settings.timezone;
  let weekday;
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
    weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name];
  } catch {
    weekday = now.getDay();
  }
  return closed.indexOf(weekday) !== -1;
}

/*
 * Pure, so the interesting part is testable without a television: given the
 * facts, what is wrong? Severity is "fault" (someone should look now) or "warn"
 * (worth knowing, not worth waking anyone).
 */
export function evaluate(facts) {
  const findings = [];
  const fault = (code, detail) => findings.push({ severity: "fault", code, detail });
  const warn = (code, detail) => findings.push({ severity: "warn", code, detail });

  if (!facts.reachable) {
    fault("unreachable", `no adb connection to ${DEVICE}`);
    return { status: "fault", findings };
  }

  if (facts.screenOn === false) {
    // Not a crash, but on an unattended display nobody asked for this.
    fault("screen-off", "display panel is powered off");
  }

  if (facts.foreground && facts.foreground.indexOf(OUR_PACKAGE) === -1) {
    fault("wrong-app", `foreground is ${facts.foreground}, not ${OUR_PACKAGE}`);
  } else if (!facts.foreground) {
    warn("foreground-unknown", "could not read the foreground activity");
  }

  if (facts.crashes > 0) {
    fault("crash", `${facts.crashes} FATAL/ANR line(s) for ${OUR_PACKAGE} in logcat`);
  }

  if (typeof facts.screenshotBytes === "number") {
    if (facts.screenshotBytes === 0) {
      warn("screenshot-failed", "screencap produced nothing");
    } else if (facts.screenshotBytes < BLANK_SCREENSHOT_BYTES) {
      // Black is correct on a closed day and wrong on an open one.
      if (facts.closedDay) {
        warn("blank-expected", "screen is blank, which is correct on a closed day");
      } else {
        fault("blank", `screen looks blank (${facts.screenshotBytes} bytes) on an open day`);
      }
    }
  }

  // Advisory only. The device runs with ~90 MB free and swap in use as a matter
  // of course, so a low number is its normal state, not news. This exists to
  // show a trend over time, not to page anyone.
  if (typeof facts.memFreeKb === "number" && facts.memFreeKb < 40 * 1024) {
    warn("memory-low", `${facts.memFreeKb} kB free`);
  }

  const status = findings.some((f) => f.severity === "fault") ? "fault"
    : findings.length > 0 ? "warn"
    : "ok";
  return { status, findings };
}

async function probe(screenshotPath, closedDay) {
  await adb(["connect", DEVICE], { timeoutMs: 20000 });
  const state = await adb(["-s", DEVICE, "get-state"], { timeoutMs: 20000 });
  if (!state.ok || state.out !== "device") {
    return { reachable: false, closedDay };
  }

  const [focus, power, mem, logcat, uptime] = await Promise.all([
    shell("dumpsys window | grep -i mCurrentFocus"),
    shell("dumpsys power | grep 'Display Power'"),
    shell("cat /proc/meminfo"),
    shell(`logcat -d -t 2000 | grep -E 'FATAL|ANR in' | grep -c ${OUR_PACKAGE}`),
    shell("uptime")
  ]);

  let screenshotBytes = 0;
  const remote = "/data/local/tmp/vhf-monitor.png";
  const cap = await shell(`screencap -p ${remote}`);
  if (cap.ok) {
    const pull = await adb(["-s", DEVICE, "pull", remote, screenshotPath], { timeoutMs: 60000 });
    if (pull.ok) {
      try {
        screenshotBytes = (await fs.stat(screenshotPath)).size;
      } catch { /* left at 0 */ }
    }
    await shell(`rm -f ${remote}`);
  }

  const memFreeKb = Number((mem.out.match(/MemFree:\s+(\d+)/) || [])[1]) || null;

  return {
    reachable: true,
    closedDay,
    // dumpsys prints the activity inside a Window{...} record, so stop at the
    // closing brace rather than taking the rest of the token with it.
    foreground: (focus.out.match(/u0 ([^\s}]+)/) || [])[1] || null,
    screenOn: /state=ON/.test(power.out) ? true : /state=OFF/.test(power.out) ? false : null,
    crashes: Number(logcat.out.trim()) || 0,
    memFreeKb,
    uptime: uptime.out || null,
    screenshotBytes
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const observe = argv.includes("--observe");
  const jsonAt = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : null;
  const shotAt = argv.includes("--screenshot")
    ? argv[argv.indexOf("--screenshot") + 1]
    : path.join(ROOT, "display-screenshot.png");

  const settings = JSON.parse(await fs.readFile(path.join(ROOT, "content", "settings.json"), "utf8"));
  const closedDay = isClosedDay(settings);

  const facts = await probe(shotAt, closedDay);
  const verdict = evaluate(facts);
  const report = { checkedAt: new Date().toISOString(), device: DEVICE, closedDay, facts, ...verdict };

  console.log(`[monitor] ${verdict.status.toUpperCase()}  ${closedDay ? "(closed day)" : ""}`);
  console.log(`[monitor] foreground : ${facts.foreground || "-"}`);
  console.log(`[monitor] screen     : ${facts.screenOn === null ? "-" : facts.screenOn ? "ON" : "OFF"}`);
  console.log(`[monitor] uptime     : ${facts.uptime || "-"}`);
  console.log(`[monitor] screenshot : ${facts.screenshotBytes || 0} bytes`);
  for (const f of verdict.findings) console.log(`[monitor]   ${f.severity}: ${f.code} — ${f.detail}`);
  if (verdict.findings.length === 0) console.log("[monitor]   nothing to report");

  if (jsonAt) {
    await fs.writeFile(jsonAt, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`[monitor] wrote ${jsonAt}`);
  }

  if (verdict.status === "fault" && !observe) process.exitCode = 1;
  if (observe && verdict.status === "fault") {
    console.log("[monitor] --observe: fault recorded, exiting 0 on purpose");
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-display.mjs")) {
  main().catch((err) => {
    console.error("[monitor] unexpected failure:", err);
    process.exitCode = 1;
  });
}
