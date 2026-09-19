import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDashes, normalizeSentenceSpacing, truncateText } from "../sources/calendar/text.mjs";

/*
 * The string that caused this: the Meal Prep Workshop description, as Google
 * Calendar actually stores it. Note "ingredients.Learn" — no space after the
 * full stop, which is what hid the sentence boundary and pushed the cut out to
 * "saving time in…" on the television.
 */
const MEAL_PREP =
  "Simple & Nourishing Meal Prep: prioritizing your health through affordable, " +
  "seasonal, and local ingredients.Learn simple and cost-effective meal preparation " +
  "to nourish your body, and support your local community—all while saving time in " +
  "the kitchen.";

test("a missing space after a full stop is repaired", () => {
  assert.equal(
    normalizeSentenceSpacing("local ingredients.Learn simple"),
    "local ingredients. Learn simple"
  );
});

test("initials and abbreviations are left alone", () => {
  // An uppercase letter before the dot means it is not the end of a word.
  assert.equal(normalizeSentenceSpacing("U.S.A"), "U.S.A");
  assert.equal(normalizeSentenceSpacing("J.R.R Tolkien"), "J.R.R Tolkien");
});

test("decimals are not sentence ends", () => {
  assert.equal(normalizeSentenceSpacing("3.5 acres"), "3.5 acres");
  // ...and truncation must not cut inside one either.
  const text = "The farm covers 3.5 acres of growing space and woodland beyond it.";
  assert.equal(truncateText(text, 500), text);
});

test("text shorter than the limit is returned untouched", () => {
  assert.equal(truncateText("Short enough.", 240), "Short enough.");
});

test("truncation prefers a sentence boundary over a word boundary", () => {
  const out = truncateText(normalizeSentenceSpacing(MEAL_PREP), 240);
  assert.ok(out.endsWith("."), `expected a full stop, got: ${JSON.stringify(out.slice(-40))}`);
  assert.ok(!out.endsWith("…"), "should not fall back to an ellipsis when a sentence fits");
  assert.ok(out.length <= 240);
});

test("the real regression: no cut mid-thought at 'saving time in'", () => {
  const out = truncateText(normalizeSentenceSpacing(MEAL_PREP), 240);
  assert.ok(
    !/saving time in…$/.test(out),
    `cut mid-thought again: ${JSON.stringify(out.slice(-40))}`
  );
});

test("an ellipsis is still used when no sentence boundary is available", () => {
  const runOn = "word ".repeat(80).trim();
  const out = truncateText(runOn, 100);
  assert.ok(out.endsWith("…"));
  assert.ok(out.length <= 100);
  // The ellipsis replaces a whole word, never half of one.
  assert.ok(/(^|\s)word…$/.test(out), `cut mid-word: ${JSON.stringify(out.slice(-20))}`);
});

test("a very early full stop does not gut the text", () => {
  // Below the 0.4 floor, a slightly clipped sentence beats a near-empty one.
  const text = "Note. " + "detail ".repeat(60).trim();
  const out = truncateText(text, 240);
  assert.ok(out.length > 100, `lost almost everything: ${JSON.stringify(out)}`);
});

/*
 * Both strings below are real: the Meal Prep and Quail Hunt descriptions as
 * the calendar feed actually delivered them on 2026-09-19.
 */
test("a spaced em dash becomes a full stop", () => {
  const out = normalizeDashes("Veterans Quail Hunt — November 14!");
  assert.equal(out, "Veterans Quail Hunt. November 14!");
});

test("a tight em dash becomes a comma, not a sentence break", () => {
  const out = normalizeDashes("support your local community—all while saving time");
  assert.equal(out, "support your local community, all while saving time");
});

test("an en dash range keeps its meaning and loses its shape", () => {
  assert.equal(normalizeDashes("from 8:30 AM–3:30 PM"), "from 8:30 AM-3:30 PM");
  assert.equal(normalizeDashes("Oct 3 – Oct 24"), "Oct 3 - Oct 24");
});

test("text with no dashes is returned untouched", () => {
  const text = "Come learn the easiest sourdough bread baking ever!";
  assert.equal(normalizeDashes(text), text);
});
