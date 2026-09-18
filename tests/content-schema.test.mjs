/*
 * Every file under content/ matches docs/CONTENT_SCHEMA.md.
 * Run with: node --test tests/content-schema.test.mjs
 * (Node's built-in test runner — no extra dependency needed.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateContentDir } from "../scripts/validate-content.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_DIR = path.join(ROOT, "content");

test("content/ matches the documented schema", async () => {
  const errors = await validateContentDir(CONTENT_DIR);
  assert.deepEqual(errors, []);
});
