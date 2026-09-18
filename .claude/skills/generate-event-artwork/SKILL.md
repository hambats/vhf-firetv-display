---
name: generate-event-artwork
description: Generate AI stand-in photos (Stable Diffusion / ComfyUI, Juggernaut XL) for a VHF event or program that has no real farm photo yet, and wire it into the curated-photo pipeline. Use when a new recurring program/event appears on the calendar with no photos in content/artwork/curated/, or the user asks to fill in missing event images.
---

# Generate Event Artwork

Fills the gap between "a program shows up on the calendar" and "VHF has actually
photographed it yet." `sources/calendar/index.mjs` matches event titles to a
`programId` (see `PROGRAM_KEYWORDS`), and `web/js/scenes.js` prefers a curated
photo set for that `programId` over the general gallery pool — but only if
`content/artwork/curated/<programId>/` has files in it. An empty folder just
falls back to the generic gallery wash, which is fine, but a placeholder photo
specific to the program reads much better on the display.

**This is a stand-in, not a permanent fix.** The moment VHF has a real photo of
the actual program, it replaces the AI image — see "Retiring a generated image"
below. Don't let generated images silently become the permanent look of a
program that just hasn't been photographed yet.

## When to use this

- A new `PROGRAM_KEYWORDS` entry was added in `sources/calendar/index.mjs` for a
  program that has no folder (or an empty folder) under `content/artwork/curated/`.
- The user asks to "fill in" or "make images for" missing program/event photos.
- A curation review turns up a program folder with 0 files.

## Check what's actually missing first

Don't regenerate a category that already has real photos. Cross-reference the
keyword table against what's on disk:

```bash
node -e "
const fs = require('fs');
const src = fs.readFileSync('sources/calendar/index.mjs', 'utf8');
const ids = [...src.matchAll(/programId: \"(program-[a-z0-9-]+)\"/g)].map(m => m[1]);
for (const id of ids) {
  const dir = 'content/artwork/curated/' + id;
  const count = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  console.log(count === 0 ? 'MISSING' : '      ok', id, count);
}
"
```

Only generate for the ones printed `MISSING`.

## Generating images

Stable Diffusion runs locally via ComfyUI at `D:\AI Images\`. Full setup and
model notes: `D:\AI Images\README.md`.

1. **Start the server** if it isn't already running:
   ```bash
   curl -s http://127.0.0.1:8188/system_stats
   ```
   If that fails, launch it. **This machine has a known transient
   access-violation crash on startup** (documented in the README's "Stability
   warning" section — same `0xc0000005` signature that also hits pip, Python,
   and Firefox on this machine independently of anything in this repo). It is
   not this project's bug and not consistently reproducible — just retry:
   ```bash
   "/d/AI Images/ComfyUI/venv/Scripts/python.exe" -u "/d/AI Images/ComfyUI/main.py" --port 8188
   ```
   Run it in the background, then poll `/system_stats` every ~10s for up to
   ~90s before concluding it actually failed — the Manager plugin fetches
   several GitHub JSON caches on startup before the "To see the GUI" line
   prints, so a quiet log in the first 10-15s does not mean it crashed.

2. **Use Juggernaut XL, not the base SDXL checkpoint** — the base checkpoint
   looks flat and plastic; this is exactly what Juggernaut XL's finetune fixes.
   ```
   Checkpoint: Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors
   VAE:        sdxl_vae_fp16fix.safetensors  (wire into VAE Decode explicitly —
               don't rely on the checkpoint's baked-in VAE)
   Sampler:    dpmpp_2m / karras, CFG 5-6, 28-30 steps, 1024x1024
   ```

3. **Submit via the HTTP API**, not the web UI — scriptable and batchable.
   `POST /prompt` with a workflow graph (Checkpoint → CLIPTextEncode x2 →
   KSampler → VAEDecode → SaveImage), poll `GET /history/<prompt_id>` until it
   has an `outputs` key, then copy the file out of `ComfyUI\output\` into
   `content/artwork/curated/<programId>/`. A worked example generation script
   pattern (build workflow dict, queue, poll, copy) is worth writing fresh each
   time rather than keeping a stale one around — the workflow graph is short.

4. **Prompt style** — keep every prompt anchored to the same documentary look
   so a generated photo doesn't stick out next to real farm photos in the same
   pool:
   ```
   ...documentary photography, natural outdoor daylight, shallow depth of
   field, candid moment, warm color grading, shot on a full-frame DSLR, 35mm
   lens, realistic skin texture, authentic, rural North Carolina farm setting
   ```
   Negative prompt, every time: `text, watermark, logo, signature, extra limbs,
   deformed hands, deformed face, blurry, low quality, cartoon, illustration,
   3d render, plastic skin, oversaturated, distorted anatomy, disfigured, bad
   proportions`

   Describe the *activity*, not generic scenery — a veteran actually doing the
   specific program (fly fishing mid-cast, pouring soap into molds, receiving
   acupuncture) reads as authentic on a television; a generic farm landscape
   does not tell the viewer what the program is.

5. **Generate 2-4 candidates per category**, not just one — SDXL output varies
   a lot run to run, and a hand with six fingers or a face in the background
   distortion is common enough that you need to actually look before picking.

6. **Pick the best one, discard the rest.** Do not commit every generated
   image — one strong photo per category beats three mediocre ones diluting a
   thin pool. Zoom in on hands and faces before choosing; SDXL's most common
   tell is there.

## Wiring it in

1. Save the chosen file(s) into `content/artwork/curated/<programId>/` (jpg,
   jpeg, png, or webp — matches the extensions `sources/curated-photos/index.mjs`
   scans for).
2. Rebuild the manifest:
   ```bash
   node sources/curated-photos/index.mjs
   ```
3. Validate and build:
   ```bash
   npm run build
   ```
4. Spot-check in a local preview that the new photo actually shows up when its
   `programId` scene is rendered (see `appendWash` / `buildEventScene` in
   `web/js/scenes.js` for how a `programId` picks the curated set over the
   general gallery).

## Mark it as a stand-in

Generated images are not VHF's real photos of the actual program. Keep that
visible so nobody mistakes it for documentation later:

- Use an obvious filename suffix, e.g. `<programId>-ai-01.png` — never rename
  to match the pattern of real camera-file photos.
- Tell the user explicitly which folders got AI-generated images and which
  still have none, so they know what to prioritize replacing when they
  actually photograph that program.

## Retiring a generated image

When a real farm photo of the program becomes available: drop it into the same
folder, delete the `-ai-` file, re-run `sources/curated-photos/index.mjs`. No
other code changes — the manifest and scene logic don't know or care whether a
photo is real or generated.

## Don't

- Don't regenerate a category that already has real photos, even a thin pool —
  ask before replacing anything that might be an actual farm photo.
- Don't use the base `sd_xl_base_1.0.safetensors` checkpoint — it's kept only
  for reference per the AI workspace README.
- Don't commit every raw output — curate down to the best 1-2 per category.
- Don't let a startup crash retry loop run unbounded — after ~5-6 failed
  attempts with the same error signature, stop and tell the user rather than
  continuing to burn time on a machine-level issue that isn't yours to fix.
