/*
 * A photo uploaded to the Drive folder twice is one photo on the wall, not
 * two. Drive gives each upload its own id but the same md5Checksum.
 *
 * Run with: node --test tests/drive-duplicates.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { planFromTree } from "../sources/drive/index.mjs";

const FOLDER = "application/vnd.google-apps.folder";
const NOW = new Date("2026-10-01T12:00:00Z");

const image = (id, name, md5Checksum) => ({
  id,
  name,
  md5Checksum,
  mimeType: "image/jpeg",
  createdTime: "2026-08-25T16:02:28Z",
  modifiedTime: "2026-08-25T16:02:28Z",
  thumbnailLink: "https://lh3.googleusercontent.com/drive-storage/abc=s220",
  imageMediaMetadata: { width: 1421, height: 1920 }
});

test("the same upload twice in one set is kept once, and the other is reported", () => {
  // Listing order deliberately reversed: which copy survives must not depend on it.
  const fishing = { id: "f", name: "Fishing", mimeType: FOLDER, children: [
    image("1oq_gf151OjemsN05DCw1Ghq6Lif4To-A", "IMG_4909.JPG", "aaa"),
    image("1P1ZCxVnmMKlidylSHgbcSKj7gaxMnkVq", "IMG_4909.JPG", "aaa"),
    image("1ElEcOIXwiblt2sANOgnOpNHwM8GeqeTq", "IMG_4908.JPG", "bbb")
  ] };
  const plan = (children) => planFromTree([{ id: "c", name: "Classes", mimeType: FOLDER, children: [{ ...fishing, children }] }], NOW);

  const a = plan(fishing.children);
  const b = plan([...fishing.children].reverse());
  const kept = (p) => p.sets["program-fishing"].files.map((f) => f.driveId);

  assert.equal(kept(a).length, 2);
  assert.deepEqual(kept(a), kept(b));
  assert.ok(a.skipped.some((s) => s.path === "Fishing/IMG_4909.JPG" && /duplicate of IMG_4909\.JPG/.test(s.reason)));
});

test("files without a checksum are never treated as duplicates", () => {
  const tree = [{ id: "p", name: "Farm Photos", mimeType: FOLDER, children: [
    image("x1", "a.jpg", undefined),
    image("x2", "a.jpg", undefined)
  ] }];
  assert.equal(planFromTree(tree, NOW).sets["gen-pop-additions"].files.length, 2);
});
