/*
 * Pure text helpers for the calendar adapter.
 *
 * Split out of index.mjs so they can be tested directly: index.mjs calls main()
 * at import time, so importing it from a test would hit the live calendar and
 * rewrite content/generated/events.json.
 */

/*
 * Calendar authors routinely omit the space after a full stop —
 * "…local ingredients.Learn simple and cost-effective…". Two things go wrong
 * when that reaches the display, and the second one is the expensive one:
 *
 *   1. It renders as a run-on, which looks like a bug in the display.
 *   2. It makes the sentence boundary invisible to truncateText below, which
 *      then falls back to a word break and cuts mid-thought ("saving time in…").
 *
 * Only a lowercase letter or digit before the punctuation counts, so initials
 * and abbreviations ("U.S.A", "J.R.R") are left alone. A decimal like "3.5"
 * never matches because the character after the point is not uppercase.
 */
export function normalizeSentenceSpacing(text) {
  return String(text).replace(/([a-z0-9])([.!?])([A-Z])/g, "$1$2 $3");
}

/*
 * Index of the last sentence-ending punctuation mark in `text`.
 *
 * A mark only counts when whitespace or the end of the string follows it, so
 * decimals ("3.5") and mid-word dots are never mistaken for sentence ends.
 * Returns -1 when there is none.
 */
function lastSentenceEnd(text) {
  const pattern = /[.!?](?=\s|$)/g;
  let index = -1;
  let match;
  while ((match = pattern.exec(text)) !== null) index = match.index;
  return index;
}

/*
 * Trim to maxLen, preferring a sentence boundary so the fragment reads as a
 * complete thought; falls back to a word boundary so we never cut mid-word.
 *
 * The 0.4 floor stops a very early full stop ("Note. ") from throwing away most
 * of the text — below that, a slightly clipped sentence beats a near-empty one.
 */
export function truncateText(text, maxLen) {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen - 1);

  const sentenceBreak = lastSentenceEnd(slice);
  if (sentenceBreak > maxLen * 0.4) return slice.slice(0, sentenceBreak + 1).trimEnd();

  const wordBreak = slice.lastIndexOf(" ");
  return (wordBreak > 0 ? slice.slice(0, wordBreak) : slice).trimEnd() + "…";
}
