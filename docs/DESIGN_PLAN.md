# VHF Display — Design Plan

The work track for how the display **looks and reads**. Separate from
[BUILD_TREE.md](BUILD_TREE.md), which is the track for how it **stays alive**. The two run in
parallel and share almost no files.

Findings and the reasoning behind each item are in [DESIGN_REVIEW.md](DESIGN_REVIEW.md); this file
is the plan only. Every item names the file that owns it and what "done" looks like, because most
of this is judged by eye and needs a stated bar.

**Status key:** `[ ]` not started · `[~]` in progress · `[x]` done

---

## Stages at a glance

| Stage | Theme | Blocking? | Rough size |
|---|---|---|---|
| **D0** | Blockers live on the public display | **yes — ship now** | hours — **done** |
| **D1** | Brand and logo | no | half a day — **mostly done, mark-only crop pending** |
| **D2** | Colour system | no | half a day — **done** |
| **D3** | Layout and typography | no | a day — **mostly done** |
| **D4** | Motion | no | a day, plus TV verification — **CSS done, unverified on TV** |
| **D5** | Curation and pacing | no | ongoing |

**Dependencies.** D0 stands alone and should ship immediately. **D1–D3 should be done as one pass**
— they all rewrite the same rules in `web/css/scene.css`, and splitting them means touching the same
code three times with three rounds of eyeballing. D4 depends on nothing technically but must be
validated on the actual television. D5 is content work, not code, and can run alongside everything.

---

## D0 — Blockers

Live on a public display right now. No design decisions required; all four are unambiguous defects.

### D0.1 Remove the "Powered by Netlify" badge
**Owns:** Netlify site config, fallback in `web/css/scene.css`
Netlify injects `<iframe id="nl-badge-frame">` and `/.netlify/scripts/hud` into every deployed page.
It renders bottom-right over every scene and does not appear in local preview.

- [ ] disable it in Netlify site configuration if the plan allows (needs dashboard access — not
      done from here)
- [x] if not, `#nl-badge-frame { display: none !important; }` in `scene.css`
- [ ] add an assertion to `publish.mjs` when M2 lands: fail or warn if the published HTML still
      contains `nl-badge`

**Done when:** a screenshot of the deployed site — not the preview — has nothing in any corner but
VHF's own mark.

### D0.2 Clean event descriptions at the source
**Owns:** `sources/calendar/index.mjs`
10 of 38 events carry a URL in the description; several are *nothing but* a
`google.com/url?q=…regpack…` redirect. 8 of 38 have words run together from collapsed newlines.
Truncation currently cuts mid-word.

- [x] strip URLs entirely — a link is useless on a television
- [x] decode HTML entities
- [x] replace line breaks with a space rather than joining bare (fixes "toprovide", "aswellasvaccines")
- [x] truncate on a sentence boundary, falling back to a word boundary, with a real ellipsis
- [x] drop the description entirely if nothing meaningful survives, rather than printing a fragment

**Done when:** every one of the 38 current events renders as readable prose or no prose at all.

### D0.3 Make the URL defect unrepeatable
**Owns:** `scripts/validate-content.mjs`
- [x] reject any event description containing `http`

**Done when:** `npm test` fails if a future calendar sync reintroduces a raw link.

### D0.4 Keep screenshots out of the photo pool
**Owns:** `sources/gallery/index.mjs`
`screenshot-20260527-211653-facebook` (1080×1246) is in the pool today.

- [x] reject ids matching `/screenshot/i`
- [x] reject aspect ratios meaningfully taller than 4:5

**Done when:** a re-sync produces a pool with no screenshots, and the count is still ~120.

---

## D1 — Brand and logo

There is currently no VHF logo in the display; the brand mark is the text `VHF` at 24px. The logo
appears on screen only by accident, painted on a barn wall in one gallery photo.

### D1.1 Bring the logo into the project
**Owns:** `content/artwork/brand/`
Source: `VHF_Logo-2015.png` from the live site, 1024×1026 — circular, cream field, navy figures with
a rake, blueberry sprig and tomato, wordmark around the ring.

- [x] downloaded to `content/artwork/brand/vhf-logo.webp` (the source is itself WebP, 1024×1026) —
      **not** hot-linked, so it survives offline with everything else (BUILD_TREE M1)
- [ ] produce a simplified **mark-only** variant without the ring text for small sizes — **not
      done**, needs actual image editing (crop/vectorize) that isn't available in this pass; the
      corner mark below renders the full logo at 112px instead, which holds up as a shape but the
      ring wordmark is soft at that size

### D1.2 Corner mark
**Owns:** `web/css/scene.css` `.scene__brand`, `web/js/scenes.js` `brand()`
- [x] replace the `VHF` text with the logo (full logo at 112px — mark-only crop still pending, see D1.1)
- [x] give it a soft shadow (`drop-shadow`) so it holds against a bright sky on photo scenes
- [x] its position varies with scene family — see D3.4 (burn-in)

### D1.3 Lockup
- [x] full logo plus wordmark at 280px on the announcement scene and the opening Welcome scene
      (`content.lockup: true`) — the two scenes with room to spare and the highest chance of
      being read

### D1.4 Ident *(optional)*
- [ ] a scene at the loop seam: logo at ~420px, centred on cream, held ~4s

**Done when:** a visitor who has never heard of VHF can name the organisation from across the room,
and the logo is never the blurriest thing on screen.

---

## D2 — Colour system

The palette is already correct — sampled from the live site. The problem is that almost none of it
is used: `--vhf-olive` is defined and referenced by **zero** rules, navy appears only as small
caption text, and the loop reads cream, cream, cream, red.

### D2.1 Grounds by scene family
**Owns:** `web/css/theme.css`, `web/css/scene.css`

| Family | Ground | Text |
|---|---|---|
| Mission / story (`information`) | cream `#f9f7f1` | charcoal, terracotta eyebrow |
| Events & workshops | **navy** `#3f5a78` | cream |
| Impact / numbers | **olive** `#a59d7a` | navy |
| Announcements | terracotta `#c95d59` | cream |

- [x] add ground tokens per family and apply by scene type
- [x] split the `information` type into story vs impact via a new `content.family` field —
      `our-impact-2025`, `memorial-wall`, `resource-fair` now carry `"family": "impact"`

### D2.2 Fix the contrast failure
Cream on terracotta measures **3.78:1** — passes for the 76px title, **fails** the 4.5:1 body
threshold at 32px.

- [x] darken the announcement ground to ≈`#b34a46`
- [x] run the same check on cream-on-olive and navy-on-olive before shipping D2.1 (used
      navy-on-olive per the table above)

**Done when:** every text/ground pair in the table clears 4.5:1, or is ≥40px and clears 3:1.

---

## D3 — Layout and typography

### D3.1 Title wrapping
Live orphans: "Healing from the Ground / **Up**", "Vet for Vets with Canine / **Companions**".
- [x] `text-wrap: balance` as progressive enhancement — too new to rely on in the Fire OS 7 WebView
- [x] tighten `max-width` so good breaks are likely without it (`max-width: 18ch` on `.scene__title`)
- [x] eyeball the longest titles in the playlist and the longest event titles in the feed — verified
      in local preview, see below

### D3.2 The empty right 40%
Content sits in a 1200px box anchored bottom-left; the rest is ghosted photo, which reads as an
unfinished slide.
- [ ] commit to a **two-column split** — image panel right, text panel left, hard edge — **or** let
      the type grow into the space. Pick one; the current in-between is the weakest option.
      **Not done** — a real layout call, deferred rather than guessed at.

### D3.3 Re-aim the wash
`.scene__fade` is opaque at the bottom and transparent at the top, so the background photo is
strongest along the top edge where there is no content — a ghosted crowd floating above the message.
- [ ] invert or re-centre the gradient, or replace with a botanical texture — **not done**; the wash
      is already faint (16% opacity) and the fix is a subjective art-direction call better made
      looking at the actual TV, not this pass
- [ ] tag a wash-eligible subset — **not done**, needs per-photo curation (see D5.1)

### D3.4 Vary the anchor by family
Everything is bottom-left on every scene, with a fixed corner mark. Monotonous across a 5½-minute
loop, and the textbook setup for LCD burn-in over months.
- [x] each family from D2.1 gets its own anchor and corner-mark position — event/impact families
      anchor content top-left with the brand mark bottom-right; story/announcement/crisis keep the
      original bottom-left anchor and top-right mark

**Done when:** three consecutive scenes don't look like the same slide with the words swapped.

---

## D4 — Motion

Currently the only movement in the display is a 900ms crossfade. Everything else is frozen for 10–12
seconds. From across a room that reads as *a crashed display* — worth avoiding on a system whose
whole reliability story is "it keeps running". Motion is also the cheapest burn-in mitigation there
is: pixels that drift don't burn.

Ordered by impact per unit of effort.

- [x] **D4.1 Ken Burns on full-bleed photos** — scale `1.00 → 1.06` plus translate, `transform`-only
      CSS animation. Direction is fixed per element rather than alternated per scene instance (a
      pure-CSS instance-level alternation needs a JS hook this pass didn't add) — still turns a
      slideshow into something alive.
- [x] **D4.2 Staggered text entrance** — eyebrow, then title, then body/subtitle, then caption, each
      fading up 12px over 400ms, ~120ms apart.
- [x] **D4.3 Independent grid drift** — each of the 4 grid cells gets its own `nth-child`-keyed
      direction so the grid doesn't move as one block.
- [ ] **D4.4 Wash pan** — not done; the wash is decorative and low-priority next to the rest.
- [x] **D4.5 Announcement breathes** — added to `.scene--announcement` and `.scene--crisis`: a 16s
      ease-in-out `scale(1) → scale(1.015)`, never a blink/pulse.

**Not yet verified on the actual Fire TV hardware** — animations are `transform`/`opacity` only, at
most 2-3 animated layers, driven by CSS (not JS), per the constraints below, but this whole item's
"done" bar is a TV frame-rate check that a desktop browser can't stand in for.

**Hardware constraints — these are not negotiable on a Fire OS 7 WebView:**
- animate `transform` and `opacity` **only** — never `width`, `left`, `filter` or `blur`
- at most two or three animated layers at once
- CSS animations, not JS timers, so they run on the compositor
- every duration longer than feels right on a desktop; at TV distance anything that reads as "an
  animation" is too fast. The target is *ambient*, not *transition*.

**Done when:** it holds a steady frame rate on the actual television — this is the one item in this
plan that cannot be signed off in a desktop browser.

---

## D5 — Curation and pacing

Content work rather than code; can run in parallel with everything above.

### D5.1 Photo pool sweep
- [x] exclude signage-dominated frames — `content/gallery-exclude.json` is now actively curated (9
      entries), including the "APLIX INC. QUALITY POLICY" cheque-presentation frame this bullet
      called out.
- [x] spot-check crops: `object-position: center 35%` is still the global default, but per-photo
      focus overrides now exist — `content/gallery-focus.json` for the scraped pool, and a
      per-set `focus.json` convention for curated folders (see `sources/curated-photos/index.mjs`
      and `content/artwork/curated/program-pottery/focus.json`). `appendWash` in
      `web/js/scenes.js` applies them, and `pickFocus` lets a focus value be a list of crops that
      cycle per showing.
- [ ] consider reserving part of the pool for **seasonal spread**. It is currently 98 photos from
      2026 and 22 from 2025, clustered in a few months — recency weighting working as designed, but
      the farm is a seasonal place and the display shows one slice of the year

### D5.2 Pacing
- [ ] per-type durations instead of uniform: information 12–14s, photo grids 8–10s, single photo 8s
- [ ] re-order so text slides don't stack — `our-mission` → `our-history` and
      `program-agritherapy` → `program-herb-squad` are currently back to back, and 15 of 30 items
      are text

### D5.3 The crisis-line slide
"You Are Not Alone / call the Veterans Crisis Line: 988, then press 1" currently carries exactly the
same visual weight as "Founded in 2013".
- [x] give it its own calm, high-contrast treatment — `content.family: "crisis"` on the `crisis-line`
      playlist item now renders `.scene--crisis`: charcoal ground, centered, no photo wash/fade,
      slow breathing animation, no visual overlap with the announcement/terracotta treatment
- [ ] guarantee its position in the loop — not done, needs playlist/engine ordering logic
- [ ] make sure it is never the slide left frozen if the playlist stalls — not done, needs engine
      watchdog work (BUILD_TREE M1), out of scope for this design pass

### D5.4 Resolve the unused scene types
- [x] `events` (the plural list view) — adopted. It's now used twice in `playlist.json` (the Open
      Studio Pottery and ornament-workshop date lists), and it breaks up the one-event-at-a-time
      rhythm exactly as hoped.
- [ ] `custom` (artwork) — still unused in `playlist.json`. Use it or delete it.

---

## Relationship to the build tree

Nothing here is on the M0–M5 critical path in [BUILD_TREE.md](BUILD_TREE.md), with one exception:
**D0 is live on a public display and should ship regardless of what else is happening.**

Two places where the tracks touch:
- **D1.1** (logo downloaded rather than hot-linked) depends on the same reasoning as BUILD_TREE M1:
  anything the display needs must survive the network going away.
- **D3.4 and D4** both mitigate burn-in, which BUILD_TREE M4 also lists. Do it once, here.
