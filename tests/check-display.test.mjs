/*
 * Run with: node --test tests/check-display.test.mjs
 *
 * The probing half of scripts/check-display.mjs needs a television. The
 * deciding half does not, and the deciding half is where a monitor goes wrong:
 * one bad rule and it either pages someone every Sunday or stays silent through
 * a real outage. So evaluate() and isClosedDay() are pure and tested here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, isClosedDay } from "../scripts/check-display.mjs";

const HEALTHY = {
  reachable: true,
  closedDay: false,
  foreground: "org.veteranshealingfarm.display/org.veteranshealingfarm.display.DisplayActivity",
  screenOn: true,
  crashes: 0,
  memFreeKb: 90000,
  uptime: "up 1 day",
  screenshotBytes: 1_500_000
};

test("a healthy display reports nothing", () => {
  const v = evaluate(HEALTHY);
  assert.equal(v.status, "ok");
  assert.deepEqual(v.findings, []);
});

test("an unreachable device is a fault, and stops there", () => {
  const v = evaluate({ reachable: false, closedDay: false });
  assert.equal(v.status, "fault");
  assert.equal(v.findings.length, 1, "no point piling on findings we could not measure");
  assert.equal(v.findings[0].code, "unreachable");
});

/*
 * The real incident this encodes: after a sleep/wake cycle the television came
 * back on the Fire TV launcher with our app alive behind it. A heartbeat posted
 * by the page would have said everything was fine while the display showed
 * Amazon's home row.
 */
test("the launcher in front is a fault even though the app is running", () => {
  const v = evaluate({ ...HEALTHY, foreground: "com.amazon.tv.launcher/.ui.HomeActivity_vNext" });
  assert.equal(v.status, "fault");
  assert.ok(v.findings.some((f) => f.code === "wrong-app"));
});

test("a blank screen is a fault on an open day", () => {
  const v = evaluate({ ...HEALTHY, screenshotBytes: 3000 });
  assert.equal(v.status, "fault");
  assert.ok(v.findings.some((f) => f.code === "blank"));
});

test("the same blank screen is expected on a closed day", () => {
  const v = evaluate({ ...HEALTHY, screenshotBytes: 3000, closedDay: true });
  assert.equal(v.status, "warn", "the farm is shut; a black screen is the display working");
  assert.ok(v.findings.some((f) => f.code === "blank-expected"));
});

test("a powered-off panel is a fault", () => {
  const v = evaluate({ ...HEALTHY, screenOn: false });
  assert.equal(v.status, "fault");
  assert.ok(v.findings.some((f) => f.code === "screen-off"));
});

test("crashes in logcat are a fault", () => {
  const v = evaluate({ ...HEALTHY, crashes: 2 });
  assert.equal(v.status, "fault");
  assert.ok(v.findings.some((f) => f.code === "crash"));
});

test("low memory warns but never pages anyone", () => {
  // The device idles at ~90 MB free with swap in use. Low is its normal state.
  const v = evaluate({ ...HEALTHY, memFreeKb: 20000 });
  assert.equal(v.status, "warn");
  assert.ok(v.findings.every((f) => f.severity === "warn"));
});

test("closed days are read in the display's own time zone", () => {
  const settings = { timezone: "America/New_York", hours: { closedWeekdays: [0, 1] } };
  // 2026-09-21 is a Monday. 03:00 UTC is still Sunday evening in New York, and
  // the display follows New York, not the machine running this check.
  assert.equal(isClosedDay(settings, new Date("2026-09-21T03:00:00Z")), true, "Sunday in NY");
  assert.equal(isClosedDay(settings, new Date("2026-09-21T16:00:00Z")), true, "Monday in NY");
  assert.equal(isClosedDay(settings, new Date("2026-09-22T16:00:00Z")), false, "Tuesday in NY");
});

test("no closed days configured means no day is ever excused", () => {
  assert.equal(isClosedDay({ timezone: "America/New_York", hours: {} }), false);
  assert.equal(isClosedDay({}), false);
});

/*
 * Added after a CI run reported "unreachable" for what was almost certainly an
 * adb key handshake refusal. The television was healthy at the time -- checked
 * by hand twenty minutes earlier -- so the monitor sent the reader looking at
 * the network when the answer was authorisation.
 */
test("an adb key refusal is named as such, not reported as unreachable", () => {
  const v = evaluate({ reachable: false, closedDay: false, adbState: "unauthorized", adbDetail: "device unauthorized" });
  assert.equal(v.status, "fault");
  assert.equal(v.findings[0].code, "adb-unauthorized");
});

test("a genuine network failure is still reported as unreachable", () => {
  const v = evaluate({ reachable: false, closedDay: false, adbState: null, adbDetail: "failed to connect" });
  assert.equal(v.findings[0].code, "unreachable");
});
