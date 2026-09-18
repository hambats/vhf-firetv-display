# VHF Display — Design & Content Review

Reviewed against the **live deploy** (`hambats.github.io/vhf-firetv-display`) on a 16:9 canvas, not
against the CSS. Several of the worst findings are invisible in the source — they only appear once
real gallery photos and real calendar text land in the layout.

Findings are ordered by how badly they hurt, not by how hard they are to fix. Each one names the
file that owns it. The work itself is planned separately in [DESIGN_PLAN.md](DESIGN_PLAN.md).

---

## 1. Blockers — wrong on a public display today

### 1.1 There is a "Powered by Netlify" badge on the screen. Permanently.

Netlify injects two things into every page of the deployed site:

```html
<script async src="/.netlify/scripts/hud?variant=public" ...></script>
<iframe id="nl-badge-frame" title="Powered by Netlify">
```

It renders as a dark pill in the **bottom-right corner**, on top of every scene — photos,
announcements, the crisis-line slide. It is in every screenshot taken for this review. On a TV in
the VHF building it would sit there for months.

Nothing in `web/` puts it there, which is why it has gone unnoticed: it doesn't exist in local
preview, only on the deploy.

**Fix, in order of preference:**
1. Turn it off in Netlify site configuration if the plan allows it.
2. If not, hide it in `scene.css` — `#nl-badge-frame { display: none !important; }`. It is an
   injected iframe in the top-level document, so CSS reaches it.
3. Verify against the deploy, not the preview. Worth adding to `publish.mjs` (M2) as an assertion:
   if the published HTML contains `nl-badge`, fail loudly or confirm the override is still applied.

### 1.2 Event scenes are printing raw registration URLs on the wall

Live, on screen, at 32px:

> `https://www.regpack.com/reg/templates/build/?url_vars=f1ce83b6a26731fe21f5c35b702fcc2e The staff
> of Pinnacle Animal Hospital will be here toprovide brief health exams, heartworm tests, as
> wellasvaccines appropriate to your pet(s). Flea, t...`

Three separate defects in one paragraph:

- **10 of 38 events have a URL in the description.** Several have *nothing else* — the entire
  description is a `google.com/url?q=...regpack...` redirect. Those events render as a wall of
  query string.
- **Run-together words** — "toprovide", "aswellasvaccines". The ICS description has newlines
  collapsed without substituting a space. 8 of 38 events show this.
- **Truncation lands mid-word** — "Flea, t...".

All three belong to `sources/calendar/index.mjs`, not the renderer: the adapter should be emitting
display-ready prose. Strip URLs entirely (a URL is useless on a TV — nobody can click it), decode
HTML entities, normalise whitespace by replacing line breaks with a space, and truncate on a
sentence or word boundary with a real ellipsis.

Worth adding to `validate-content.mjs` as a rule, so it can never regress: **no event description
may contain `http`**.

### 1.3 A Facebook screenshot is in the photo pool

`screenshot-20260527-211653-facebook` — 1080×1246, portrait. It passes the ≥1200px filter on one
axis and is a screenshot of a social post, not a photograph. `sources/gallery/index.mjs` should
reject ids matching `/screenshot/i`, and probably anything meaningfully taller than 4:5.

---

## 2. Logo — the biggest single upgrade available

**There is no VHF logo anywhere in the display.** The brand signature is the literal text `VHF`,
24px, letter-spaced, navy, in the top-right corner. From ten feet away on a television it is close
to invisible, and to a visitor who doesn't already know the organisation it means nothing.

The irony: the real logo *does* appear on screen — painted on a barn wall, in the bottom-right cell
of a four-photo grid. The display shows its own logo by accident and never on purpose.

The asset is on the live site:

```
https://images.squarespace-cdn.com/content/v1/6477470669facb6ffbb41557/2d1e4ec4-8a12-448c-80c4-6cfb6089dc43/VHF_Logo-2015.png?format=1500w
```

1024×1026, circular: cream field, navy silhouettes of two figures with a rake, blueberry sprig and
tomato, "VETERANS HEALING FARM" set around the ring.

**Recommended use — three tiers, not one:**

| Tier | Where | Size | Why |
|---|---|---|---|
| **Corner mark** | every scene, replacing the `VHF` text | ~96px circle | quiet, constant attribution |
| **Lockup** | announcement + the opening Welcome scene | ~280px, with the wordmark set beside or beneath it | these are the scenes with room, and the ones a passer-by is most likely to read |
| **Ident** | a new scene at the loop seam | ~420px, centred on cream, held 4s | gives the 5½-minute loop a punctuation mark instead of running as an undifferentiated stream |

Practical notes: download it into `content/artwork/brand/vhf-logo.png` rather than hot-linking, so
it survives offline with everything else (M1). Its ring text is fine at 280px+ and illegible at
96px — for the corner mark, either accept it as a graphic device or produce a simplified
mark-without-ring variant. On photo scenes the circle needs a soft shadow or the existing top fade
to stay legible against a bright sky.

---

## 3. Colour

The palette itself is right — it was sampled from the live site and it matches. The problem is
**how little of it is used**.

- `--vhf-olive: #a59d7a` is **defined and never referenced by any rule.** Dead token.
- `--vhf-navy` appears only as small caption and brand text. The site uses it as a large field
  colour, for whole panels.
- So the display reads as: cream, cream, cream, red, cream. One accent doing all the work.

**Recommendation: give each scene family its own ground.** This is the single change that would
make the loop feel designed rather than templated, and it costs almost nothing — the tokens already
exist:

| Family | Ground | Text |
|---|---|---|
| Mission / story (`information`) | cream `#f9f7f1` | charcoal + terracotta eyebrow |
| Events & workshops | **navy** `#3f5a78` | cream |
| Impact / numbers | **olive** `#a59d7a` | navy |
| Announcements | terracotta `#c95d59` | cream |

A viewer glancing up learns, without being told, that navy means "something is happening here soon."

**One measured contrast problem.** Cream on terracotta is **3.78:1**. That passes for large text
(≥3:1, so the 76px announcement title is fine) and **fails** the 4.5:1 threshold for the 32px body
underneath it. Either darken the announcement ground to about `#b34a46`, or push the body up to
~40px and treat it as large text. The same check should be run on cream-on-olive before adopting
the table above.

---

## 4. Layout and typography

**4.1 Titles wrap into orphans.** Live examples: "Healing from the Ground / **Up**" and "Vet for
Vets with Canine / **Companions**". A single trailing word on line two looks like a mistake at TV
scale. `text-wrap: balance` fixes it in one line, but is too new for the Fire OS 7 WebView to be
relied on — ship it as progressive enhancement over a tightened `max-width` that makes good breaks
likely, and check the worst offenders by eye.

**4.2 The right 40% of every information scene is empty.** Content sits in a 1200px box anchored
bottom-left; the rest is ghosted photo. On a 16:9 TV that reads as an unfinished slide rather than a
deliberate composition. Either commit to a **two-column split** (image panel right, text panel left,
hard edge) or let the type grow into the space.

**4.3 The photo wash is emphasised in exactly the wrong place.** `.scene__fade` is opaque at the
bottom and transparent at the top — so the background photo is *most* visible along the top edge,
where there is no content, and invisible behind the text. The result is a random ghosted crowd
floating above the message, cropped at the shoulders. Inverting or re-centring the gradient would
put the photographic interest where the composition wants it.

**4.4 The wash photo has nothing to do with the slide.** "Medicinal Herb Squad — Healing from the
Ground Up" is backed by a woman presenting beside a projector screen. "Agritherapy — Growing
Together" is backed by a garage interior. The pool is picked at random, so the pairing is random.
Options, cheapest first: tag a small subset of pool photos as wash-eligible (landscape, low detail,
no faces, no signage); or pick the wash by keyword match against the eyebrow; or drop photographic
washes for these scenes and use a soft botanical texture instead.

**4.5 Everything is anchored bottom-left, always.** Combined with a fixed corner mark, that is both
monotonous across a 5½-minute loop and the textbook setup for **LCD burn-in** on a display that runs
for months. Varying the anchor by scene family (see §3) solves both at once.

---

## 5. Motion — currently none, and it shows

The only movement in the entire display is a 900ms opacity crossfade between scenes. Everything
else is frozen for 10–12 seconds at a time. From across a room a static frame reads as *a display
that has crashed* — which is precisely the failure mode the reliability work is trying to avoid, so
it is worth not *looking* broken while working perfectly.

Motion also directly mitigates the burn-in risk in §4.5: pixels that drift don't burn.

**Recommended, in order of impact per unit of effort:**

1. **Ken Burns on full-bleed photos.** Slow scale `1.00 → 1.06` plus a few percent of translate over
   the scene's full duration, direction alternating per scene. This is the big one — it turns a
   slideshow into something that feels alive.
2. **Staggered text entrance.** Eyebrow, then title, then body, each fading up 12px over ~400ms,
   ~120ms apart. Costs nothing, makes every information scene feel authored.
3. **Grid cells drift independently.** In the 2/3/4-photo grids, give each cell its own very slow
   scale in a different direction. Avoid synchronised movement, which looks mechanical.
4. **The wash pans.** A 30-second linear drift behind the text — slow enough to be subliminal.
5. **Announcement breathes.** A very slow scale or gradient shift on the terracotta field. Never a
   blink or a pulse; this is a calm organisation.

**Constraints that matter on this hardware.** Animate `transform` and `opacity` only — never
`width`, `left`, `filter` or `blur`, which will stutter on a Fire OS 7 WebView. Keep it to two or
three animated layers at once. Use CSS animations rather than JS timers so they run on the
compositor. And keep every duration long: at TV distance, anything that reads as "an animation" is
too fast. The target is *ambient*, not *slideshow transition*.

---

## 6. Photo pool quality

- **Screenshots in the pool** — see §1.3.
- **Signage dominates some frames.** One grid cell is a cheque presentation where two large "APLIX
  INC. QUALITY POLICY / ENVIRONMENTAL POLICY" boards occupy the centre of the image. It reads as a
  corporate office, not a farm. Candidates for `gallery-exclude.json`.
- **Faces are cropped at cell edges.** `object-position: center 35%` is a blunt global rule; in the
  2- and 3-up grids it slices people at the frame edge. Worth spot-checking the pool and adding a
  per-photo focus override for the ones that matter.
- **Seasonal narrowness.** The pool is 98 photos from 2026 and 22 from 2025, and the 2026 ones
  cluster in a few months. Recency weighting is working as designed, but the farm is a
  *seasonal* place and the display currently shows one slice of the year. Consider reserving a
  portion of the pool for seasonal spread rather than pure recency.

---

## 7. Playlist and pacing

- **30 items, ~5½ minutes, 15 of them text slides.** That is a lot of reading for an audience that
  is walking past. Several land back-to-back (`our-mission` → `our-history`,
  `program-agritherapy` → `program-herb-squad`), so the loop has stretches of unbroken prose.
- **Durations are uniform where they shouldn't be.** A four-photo grid holds 12s — too long for an
  image with no text. A three-line body holds 10s — tight for an older reader at distance. Suggest
  information 12–14s, photo grids 8–10s, single photo 8s.
- **The crisis-line slide is styled exactly like every other slide.** "You Are Not Alone / call the
  Veterans Crisis Line: 988, then press 1" currently has the same weight as "Founded in 2013". It
  deserves its own calm, high-contrast treatment and a guaranteed position in the loop — and it
  should never be the slide that sits frozen if the playlist stalls.
- **Two implemented scene types are unused.** `events` (the plural list view) and `custom`
  (artwork) are built and never appear in `playlist.json`. The events-list view in particular would
  break up the one-event-at-a-time rhythm. Either use them or drop them.

---

## 8. The plan

Lives in **[DESIGN_PLAN.md](DESIGN_PLAN.md)** — stages D0–D5, each item naming the file it touches
and what "done" looks like. This file is the findings; that one is the work.

Short version: **D0 is live on a public display and should ship regardless of what else is
happening** — the Netlify badge (§1.1), the raw URLs in event text (§1.2), and the screenshot in the
photo pool (§1.3). Everything else is discretionary and sequenced there.
