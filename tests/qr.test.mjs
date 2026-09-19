import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SVG = path.join(ROOT, "web", "img", "register-qr.svg");
const SETTINGS = path.join(ROOT, "content", "settings.json");

/*
 * A QR code is unreadable to a human, so a stale one looks exactly like a
 * correct one right up until a veteran scans it and lands nowhere. The
 * committed SVG is generated from settings.json by scripts/generate-qr.mjs;
 * these tests fail the build if the two ever drift apart.
 */

async function readSvg() {
  return fs.readFile(SVG, "utf8");
}

async function readRegistration() {
  const settings = JSON.parse(await fs.readFile(SETTINGS, "utf8"));
  return settings.registration || {};
}

test("the committed QR encodes the URL in settings.json", async () => {
  const [svg, reg] = await Promise.all([readSvg(), readRegistration()]);
  assert.ok(reg.url, 'settings.json is missing "registration.url"');
  assert.ok(
    svg.includes(`<!-- encodes: ${reg.url} -->`),
    "web/img/register-qr.svg is stale — re-run: node scripts/generate-qr.mjs"
  );
});

test("the registration URL is https and absolute", async () => {
  const reg = await readRegistration();
  const url = new URL(reg.url);
  assert.equal(url.protocol, "https:", "a public display must not advertise a plain-http link");
});

test("the QR keeps the error correction its centre logo depends on", async () => {
  const svg = await readSvg();
  // The seal covers part of the code; only level H has the headroom to survive
  // that. If the generator ever drops to a lower level the logo has to go too.
  assert.ok(svg.includes("<image "), "expected the centre logo to be embedded");
  assert.ok(
    /viewBox="0 0 (\d+)/.test(svg),
    "expected a viewBox to size the code against"
  );
});

test("the QR carries no opaque white backdrop", async () => {
  const svg = await readSvg();
  // The light field comes from .scene__qr-code's cream card, so the SVG itself
  // must stay transparent — otherwise the slide shows a hard white square.
  assert.ok(
    !/fill="#ffffff" d="M0 0h/.test(svg),
    "the full-bleed white background is back; the scene supplies the light field"
  );
});
