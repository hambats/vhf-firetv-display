/*
 * Run with: node --test tests/image-size.test.mjs
 *
 * sources/curated-photos/image-size.mjs reads image dimensions from a header
 * rather than decoding, and rather than adding a dependency. That trade is only
 * worth making if it is right, because the display picks a slide's whole layout
 * from the answer (DESIGN_PLAN D3.2) — a wrong width silently puts a landscape
 * photo in the portrait treatment, which looks like a design mistake rather
 * than a parsing one.
 *
 * The expected values below were verified against Pillow across all 86 curated
 * photos, which agreed on every one. These four are the formats the folder
 * actually contains, one each.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imageSize, imageSizeFromBuffer } from "../sources/curated-photos/image-size.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = (p) => path.join(ROOT, p);

const KNOWN = [
  ["JPEG", "content/artwork/curated/gen-pop-additions/481342530_660857999943454_792166771420538192_n.jpg", 1103, 1638],
  ["JPEG (.jpeg, 4032px)", "content/artwork/curated/gen-pop-additions/IMG_6002.jpeg", 4032, 3024],
  ["PNG", "content/artwork/curated/program-5k-fundraiser/VDF_5k_2026Logo_-598x1030.png", 598, 1030],
  ["WebP", "content/artwork/curated/memorial-wall/traveling-wall-visitors.webp", 660, 372]
];

for (const [label, file, width, height] of KNOWN) {
  test(`${label} reads its real dimensions`, async () => {
    assert.deepEqual(await imageSize(at(file)), { width, height });
  });
}

test("orientation is what the layout rule actually asks for", async () => {
  // The rule is height > width -> portrait -> split treatment.
  const portrait = await imageSize(at(KNOWN[0][1]));
  const landscape = await imageSize(at(KNOWN[3][1]));
  assert.ok(portrait.height > portrait.width, "1103x1638 is portrait");
  assert.ok(landscape.width > landscape.height, "660x372 is landscape");
});

/*
 * Null is a supported answer, not a crash: scenes.js falls back to the previous
 * layout when a photo has no dimensions, so a file this cannot read degrades to
 * the old design rather than to a broken one.
 */
test("a missing file returns null rather than throwing", async () => {
  assert.equal(await imageSize(at("content/artwork/curated/does-not-exist.jpg")), null);
});

test("junk returns null rather than a confident wrong answer", () => {
  assert.equal(imageSizeFromBuffer(Buffer.from("this is not an image at all")), null);
  assert.equal(imageSizeFromBuffer(Buffer.alloc(0)), null);
});

test("a truncated JPEG header returns null", () => {
  // SOI and the start of a segment, then nothing — the frame marker never
  // arrives, so there is no honest answer to give.
  assert.equal(imageSizeFromBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), null);
});

/*
 * The naive JPEG readers that circulate assume the frame marker sits at a fixed
 * offset, which holds only for files with no EXIF and no colour profile. This
 * builds one with a 1 KB APP1 segment in front of the frame, where a
 * fixed-offset reader lands inside the EXIF payload and returns nonsense.
 */
test("a JPEG with a large EXIF segment before the frame still reads correctly", () => {
  const app1Payload = Buffer.alloc(1024, 0x41);
  const parts = [
    Buffer.from([0xff, 0xd8]),                                  // SOI
    Buffer.from([0xff, 0xe1]),                                  // APP1
    Buffer.from([(app1Payload.length + 2) >> 8, (app1Payload.length + 2) & 0xff]),
    app1Payload,
    Buffer.from([0xff, 0xc0]),                                  // SOF0
    Buffer.from([0x00, 0x11, 0x08]),                            // length, precision
    Buffer.from([0x04, 0x38]),                                  // height 1080
    Buffer.from([0x07, 0x80])                                   // width 1920
  ];
  assert.deepEqual(imageSizeFromBuffer(Buffer.concat(parts)), { width: 1920, height: 1080 });
});

test("a Huffman table is not mistaken for a frame header", () => {
  // 0xC4 sits in the Cx range but is a DHT, not a frame. Reading it as one
  // yields dimensions from table data.
  const dht = Buffer.alloc(64, 0x00);
  const parts = [
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc4]),
    Buffer.from([(dht.length + 2) >> 8, (dht.length + 2) & 0xff]),
    dht,
    Buffer.from([0xff, 0xc2]),                                  // SOF2, progressive
    Buffer.from([0x00, 0x11, 0x08]),
    Buffer.from([0x02, 0xd0]),                                  // height 720
    Buffer.from([0x05, 0x00])                                   // width 1280
  ];
  assert.deepEqual(imageSizeFromBuffer(Buffer.concat(parts)), { width: 1280, height: 720 });
});
