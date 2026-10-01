/*
 * The Google Drive feed's rules, without a network: which folder means what,
 * what is skipped and why, when a flyer retires, and how Drive sets merge into
 * the curated ones the display already reads.
 *
 * Run with: node --test tests/drive.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  planFromTree,
  flyerExpiry,
  classSetId,
  classKeyword,
  sectionFor,
  sizedThumbnail
} from "../sources/drive/index.mjs";
import { mergeDriveSets } from "../sources/curated-photos/index.mjs";

const FOLDER = "application/vnd.google-apps.folder";
const NOW = new Date("2026-10-01T12:00:00Z");

function folder(name, children) {
  return { id: `f-${name}`, name, mimeType: FOLDER, children };
}
function image(name, opts = {}) {
  return {
    id: opts.id || `i-${name}`,
    name,
    mimeType: opts.mimeType || "image/jpeg",
    createdTime: opts.createdTime || "2026-09-29T15:00:00Z",
    modifiedTime: opts.modifiedTime || "2026-09-29T15:00:00Z",
    description: opts.description,
    thumbnailLink: "https://lh3.googleusercontent.com/drive-storage/abc=s220",
    imageMediaMetadata: { width: opts.width ?? 4032, height: opts.height ?? 3024 }
  };
}

test("a class folder becomes the program set its name already belongs to", () => {
  assert.equal(classSetId("Pottery"), "program-pottery");
  assert.equal(classSetId("Dog Training"), "program-dog-training");
  assert.equal(classSetId("Hendersonville Woman's Club"), "program-hendersonville-womans-club");
  assert.equal(classSetId("Arts & Crafts"), "program-arts-and-crafts");
  assert.equal(classSetId("!!!"), null);
});

test("a folder name's filler words do not stop it matching the calendar", () => {
  assert.equal(classKeyword("Pottery Classes"), "pottery");
  assert.equal(classKeyword("Beeswax Candles"), "beeswax candles");
  assert.equal(classKeyword("Wreath Making Workshop Photos"), "wreath making");
});

test("top-level folders are recognised by name, loosely", () => {
  assert.equal(sectionFor("Classes"), "classes");
  assert.equal(sectionFor("class photos"), "classes");
  assert.equal(sectionFor("Flyers"), "flyers");
  assert.equal(sectionFor("Farm Photos"), "farm");
  assert.equal(sectionFor("Old stuff"), null);
});

test("the tree maps to class, flyer and farm sets, and says why anything was left out", () => {
  const tree = [
    folder("Classes", [
      folder("Wreath Making", [image("IMG_1.HEIC", { mimeType: "image/heic" }), folder("Day 2", [image("IMG_2.jpg")])]),
      folder("Pottery", [image("tiny.jpg", { width: 640, height: 480 }), { id: "v", name: "clip.mov", mimeType: "video/quicktime" }]),
      image("loose.jpg")
    ]),
    folder("Flyers", [image("wreath 11-21.png", { width: 1080, height: 1350 })]),
    folder("Farm Photos", [image("sunrise.jpg", { description: "  Sunrise over\nthe garden  " })]),
    folder("Random", []),
    image("top.jpg")
  ];
  const { sets, skipped } = planFromTree(tree, NOW);

  assert.deepEqual(Object.keys(sets).sort(), ["drive-flyers", "gen-pop-additions", "program-pottery", "program-wreath-making"]);
  // Nested subfolders still belong to the class.
  assert.deepEqual(sets["program-wreath-making"].files.map((f) => f.name), ["IMG_1.HEIC", "IMG_2.jpg"]);
  assert.equal(sets["program-wreath-making"].keyword, "wreath making");
  assert.equal(sets["program-pottery"].files.length, 0);
  assert.equal(sets["gen-pop-additions"].files[0].caption, "Sunrise over the garden");
  assert.equal(sets["drive-flyers"].files[0].expires, "2026-11-22T04:00:00.000Z");

  const reasons = Object.fromEntries(skipped.map((s) => [s.path, s.reason]));
  assert.match(reasons["Classes/Pottery/tiny.jpg"], /too small/);
  assert.match(reasons["Classes/Pottery/clip.mov"], /video/);
  assert.match(reasons["Classes/loose.jpg"], /folder named for the class/);
  assert.match(reasons["Random"], /unrecognised/);
  assert.match(reasons["top.jpg"], /top level/);
});

test("a flyer runs through the date in its name, in any of the usual spellings", () => {
  const added = "2026-09-29T15:00:00Z";
  assert.equal(flyerExpiry("2026-11-21 wreath.png", added), "2026-11-22T04:00:00.000Z");
  assert.equal(flyerExpiry("Wreath 11.21.png", added), "2026-11-22T04:00:00.000Z");
  assert.equal(flyerExpiry("wreath_11_21_26.jpg", added), "2026-11-22T04:00:00.000Z");
  // No year, and the date has already passed this year: it means next year.
  assert.equal(flyerExpiry("new year 1-3.png", added), "2027-01-04T04:00:00.000Z");
});

test("a flyer with no date retires itself after 30 days", () => {
  assert.equal(flyerExpiry("Wreath Making.png", "2026-09-29T15:00:00Z"), "2026-10-29T15:00:00.000Z");
});

test("an expired flyer is skipped, not published", () => {
  const tree = [folder("Flyers", [image("5k 9-20.png", { createdTime: "2026-09-01T12:00:00Z" })])];
  const { sets, skipped } = planFromTree(tree, NOW);
  assert.equal(sets["drive-flyers"].files.length, 0);
  assert.match(skipped[0].reason, /expired/);
});

test("photos are fetched through Drive's renderer at TV size", () => {
  assert.equal(
    sizedThumbnail({ driveId: "x", thumbnailLink: "https://lh3.googleusercontent.com/drive-storage/abc=s220" }),
    "https://lh3.googleusercontent.com/drive-storage/abc=s1920"
  );
  assert.equal(sizedThumbnail({ driveId: "x y" }), "https://drive.google.com/thumbnail?id=x%20y&sz=s1920");
});

test("Drive photos join the hand-curated set of the same name instead of replacing it", () => {
  const sets = { "program-pottery": [{ id: "program-pottery/01.jpg", src: "content/artwork/curated/program-pottery/01.jpg" }] };
  mergeDriveSets(sets, {
    sets: {
      "program-pottery": { photos: [{ driveId: "abc", src: "content/artwork/drive/program-pottery/abc.jpg", width: 1920, height: 1440 }] },
      "drive-flyers": { photos: [{ driveId: "fly", src: "content/artwork/drive/flyers/fly.png", width: 1080, height: 1350, expires: "2026-11-22T04:00:00.000Z" }] },
      "program-empty": { photos: [] }
    }
  });
  assert.deepEqual(sets["program-pottery"].map((p) => p.id), ["program-pottery/01.jpg", "drive/abc"]);
  assert.equal(sets["drive-flyers"][0].expires, "2026-11-22T04:00:00.000Z");
  assert.equal("program-empty" in sets, false);
});
