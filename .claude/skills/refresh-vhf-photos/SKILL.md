---
name: refresh-vhf-photos
description: Re-scrape the VHF gallery, rebuild the recency-weighted photo pool for the Fire TV display's photo-pool scenes, and redeploy. Use when the user asks to refresh, update, or rotate in new photos, or mentions the display showing stale/old photos.
---

# Refresh VHF Photos

Re-runs the VHF gallery adapter to pull in newly-added gallery photos, rebuilds the
Netlify site, and redeploys — so the Fire TV display's `photo-pool` scenes rotate in
fresh content instead of showing the same pool indefinitely.

## What this actually does

`sources/gallery/index.mjs` re-scrapes the three yearly gallery pages
(`/gallery-2026`, `/gallery-2025`, `/gallery-2024-present`) from scratch every time —
it has no memory of the previous run. Selection into the 120-photo pool is **recency-
weighted, not uniform random**: photos are ranked by a best-effort `takenAt` (parsed
from camera-style filenames like `20260506_110209.jpg`, falling back to a per-gallery-
year date when a filename has no parseable timestamp), then sampled with exponential
decay favoring the top of that ranking (`RECENCY_DECAY` in the adapter — smaller
means more heavily skewed toward brand-new photos). Practically: running this after
new photos go up on the site mostly rotates newer ones in rather than diluting them
one-in-several-hundred.

## Steps

1. Run the adapter and read its summary output:
   ```bash
   node sources/gallery/index.mjs
   ```
   Note how many candidates were found, how many qualified (>= 1200px on the long
   side — smaller ones are unusable social-media re-post thumbnails Squarespace
   can't serve larger), and how many were excluded via
   `content/gallery-exclude.json`.

2. Rebuild and run the test suite (validates all content against
   `docs/CONTENT_SCHEMA.md`, including the new `gallery.json`):
   ```bash
   npm run build
   npm test
   ```
   If either fails, stop and investigate — do not deploy on a failed build/test.

3. Spot-check the new pool's date spread before deploying (catches an adapter bug
   or a gallery-page URL that moved, faster than eyeballing the TV):
   ```bash
   node -e "
   const g = require('./content/generated/gallery.json');
   const byYear = {};
   for (const p of g.photos) byYear[(p.takenAt||'').slice(0,4)||'unknown'] = (byYear[(p.takenAt||'').slice(0,4)||'unknown']||0)+1;
   console.log('total:', g.photos.length, byYear);
   "
   ```
   Expect it skewed toward the most recent year(s) — if it looks flat/uniform across
   years, the recency weighting or date parsing may be broken; investigate before
   deploying.

4. Deploy:
   ```bash
   netlify deploy --prod
   ```

5. Tell the user: how many photos are in the new pool, the year breakdown, and
   whether anything looked off (e.g. a spike in `dateSource: "gallery-page-fallback"`
   might mean a batch of new photos has unparseable filenames — not broken, just
   less precisely dated than camera-timestamped ones).

## If a photo needs to be excluded

If the user (or a screenshot/spot-check) flags a photo in rotation that needs context
an unattended TV can't provide (this has happened — a respectful flag-retirement
ceremony photo read as alarming with no caption), add it to
`content/gallery-exclude.json` with a one-line reason, then re-run this whole skill
so the exclusion takes effect immediately rather than waiting for the next scheduled
refresh.

## Don't

- Don't hand-edit `content/generated/gallery.json` — it's regenerated from scratch
  every run; edits there are lost.
- Don't skip the build/test step to save time — a schema violation must never reach
  the deployed site.
