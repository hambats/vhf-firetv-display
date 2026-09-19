#!/usr/bin/env python3
"""Work out where each gallery photo should be cropped, by finding the faces.

    python scripts/detect-photo-focus.py            # report only, writes nothing
    python scripts/detect-photo-focus.py --write    # update content/gallery-focus.json

The problem this solves: the display crops every photo to 16:9, and the default
`object-position: center 35%` is right for a landscape farm shot and wrong for a
group portrait, where it starts the crop below everyone's chin and shows torsos.
Hand-tuning does not scale to a 120-photo pool that is re-sampled on every sync.

So: detect faces PC-side, pick the object-position that keeps all of them inside
the crop, and write it to content/gallery-focus.json. Nothing here runs on the
television, and no image leaves this machine -- detection is a local Haar
cascade, not a cloud API.

Entries a human wrote are never overwritten. Automation is a good default and a
bad authority: when someone has looked at a photo and chosen a crop, that
judgement beats this script's.

STATUS: review tool, not an automatic step. Do not wire this into the sync.

Measured against the real 120-photo pool it proposed moving 89 of them, and the
proposals are genuinely mixed. It reliably fixes the case it was built for --
a tall group portrait whose faces sit above the default crop. It also produces
clear regressions: where a Haar cascade misses a standing person and finds only
the seated ones, the window slides down and decapitates whoever it missed, which
is worse than the problem being solved.

So run it, read the --sheet, and copy across only the entries that are actually
better. Getting to unattended would mean a stronger detector (OpenCV's YuNet DNN
rather than Haar, which needs a model file this repo does not carry), not more
tuning of the heuristics here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

try:
    import cv2
    import numpy as np
except ImportError:  # pragma: no cover
    sys.exit("opencv-python and numpy are required:  pip install opencv-python numpy")

ROOT = Path(__file__).resolve().parent.parent
GALLERY = ROOT / "content" / "generated" / "gallery.json"
FOCUS = ROOT / "content" / "gallery-focus.json"
CACHE = ROOT / ".cache" / "photo-focus"

# Must match .scene__photo / the wash: the display crops to 16:9.
TARGET_ASPECT = 16 / 9

# web/js/scenes.js: buildPhotoScene falls back to this when focus is unset.
DEFAULT_FOCUS_PCT = 35.0

# Below this the crop is doing nothing useful -- a photo already near 16:9 has
# almost no vertical slack, so moving the window cannot help or hurt much.
MIN_SLACK_PX = 40

# A detection smaller than this fraction of image width is usually a false
# positive on foliage or gravel, both of which this gallery has a lot of.
MIN_FACE_FRAC = 0.03

# Keep this much of the crop above the topmost face, as a fraction of crop
# height, so heads are not flush against the top edge.
#
# Tuned against three crops a human had already chosen by eye. At 0.12 the
# script clamped to the very top of the frame and gave up much of the subject
# to ceiling; 0.05 lands within a few percent of the human choices. It still
# errs toward more headroom rather than less, which is the safe direction: too
# much sky is untidy, a cut-off head is the bug being fixed.
HEADROOM = 0.05


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def fetch(url: str) -> bytes | None:
    """Download with a small on-disk cache; the pool is re-sampled every sync."""
    CACHE.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]
    blob = CACHE / f"{key}.img"
    if blob.exists():
        return blob.read_bytes()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "vhf-display-focus/1.0"})
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = resp.read()
    except Exception as exc:
        print(f"    ! download failed: {exc}")
        return None
    blob.write_bytes(data)
    return data


def detect_faces(image) -> list[tuple[int, int, int, int]]:
    """Frontal + profile faces, de-duplicated. Returns (x, y, w, h) boxes."""
    grey = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    grey = cv2.equalizeHist(grey)
    h, w = grey.shape[:2]
    min_side = max(24, int(w * MIN_FACE_FRAC))

    boxes: list[tuple[int, int, int, int]] = []
    for name in ("haarcascade_frontalface_default.xml", "haarcascade_profileface.xml"):
        cascade = cv2.CascadeClassifier(cv2.data.haarcascades + name)
        if cascade.empty():
            continue
        found = cascade.detectMultiScale(
            grey, scaleFactor=1.1, minNeighbors=6, minSize=(min_side, min_side)
        )
        boxes.extend(tuple(int(v) for v in b) for b in found)

    # A profile cascade only finds faces looking one way, so mirror and re-run.
    flipped = cv2.flip(grey, 1)
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
    if not cascade.empty():
        for (x, y, fw, fh) in cascade.detectMultiScale(
            flipped, scaleFactor=1.1, minNeighbors=6, minSize=(min_side, min_side)
        ):
            boxes.append((int(w - x - fw), int(y), int(fw), int(fh)))

    return drop_outliers(dedupe(boxes))


def drop_outliers(boxes):
    """Keep only detections near the scale of the largest one.

    Haar fires readily on repetitive texture -- this gallery is full of quilts,
    foliage and gravel. Observed directly: a patriotic quilt produced a 56px
    "face" alongside two real 126px ones, and because it sat near the bottom of
    the frame it dragged the crop window down past the actual faces, which is
    the exact failure this script exists to prevent.

    People photographed together are roughly the same distance from the lens, so
    their faces come out a similar size. Anything under half the width of the
    biggest detection is treated as texture.
    """
    if not boxes:
        return boxes
    widest = max(b[2] for b in boxes)
    return [b for b in boxes if b[2] >= widest * 0.5]


def dedupe(boxes: list[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    """Drop boxes that mostly overlap one already kept (frontal+profile agree)."""
    kept: list[tuple[int, int, int, int]] = []
    for box in sorted(boxes, key=lambda b: b[2] * b[3], reverse=True):
        x, y, w, h = box
        if any(iou(box, k) > 0.35 for k in kept):
            continue
        kept.append(box)
    return kept


def iou(a, b) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union else 0.0


def focus_for(width: int, height: int, faces) -> tuple[float, str] | None:
    """The object-position percentage that keeps every face inside the crop.

    Returns None when the photo does not need one -- no faces, or so little
    vertical slack that the crop window barely moves.
    """
    crop_h = width / TARGET_ASPECT
    slack = height - crop_h
    if slack <= MIN_SLACK_PX:
        return None, "already near 16:9; the crop has nowhere to move"
    if not faces:
        return None, "no faces detected"

    top = min(y for (_, y, _, _) in faces)
    bottom = max(y + h for (_, y, _, h) in faces)

    # Ideal window: all faces in, with a little headroom above the highest.
    want_top = top - crop_h * HEADROOM
    # If the faces are taller than the crop, centre on them and accept the loss.
    if bottom - top > crop_h:
        want_top = (top + bottom) / 2 - crop_h / 2

    want_top = max(0.0, min(slack, want_top))
    pct = (want_top / slack) * 100.0
    return round(pct), f"{len(faces)} face(s), band {int(top)}-{int(bottom)} of {height}px"


def crop_at(image, pct: float):
    """The 16:9 window the display would show at this object-position."""
    h, w = image.shape[:2]
    crop_h = int(w / TARGET_ASPECT)
    top = int(max(0, min(h - crop_h, (h - crop_h) * pct / 100.0)))
    return image[top:top + crop_h, :, :]


def write_sheet(rows, out: Path) -> None:
    """Before/after strips, so a human can reject a bad crop before it ships.

    Automated cropping is judged by eye or not at all: a detector that is right
    95% of the time still puts a beheaded photo on a public wall, and nobody
    will be watching when it does.
    """
    tiles = []
    for pid, image, pct in rows:
        before = cv2.resize(crop_at(image, DEFAULT_FOCUS_PCT), (480, 270))
        after = cv2.resize(crop_at(image, pct), (480, 270))
        cv2.putText(before, "35% (now)", (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
        cv2.putText(after, f"{pct:g}% (proposed)", (8, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 220, 0), 2)
        strip = np.hstack([before, np.full((270, 6, 3), 255, np.uint8), after])
        cv2.putText(strip, pid[:46], (8, 262), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 0), 1)
        tiles.append(strip)
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), np.vstack(tiles))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="update content/gallery-focus.json")
    ap.add_argument("--limit", type=int, default=0, help="only process N photos (for a quick look)")
    ap.add_argument("--only", default="", help="substring of a photo id, to check one")
    ap.add_argument("--sheet", default="", help="write a before/after review image to this path")
    args = ap.parse_args()

    photos = load_json(GALLERY)["photos"]
    doc = load_json(FOCUS) if FOCUS.exists() else {"focus": {}}
    existing = doc.setdefault("focus", {})

    manual = {
        pid for pid, e in existing.items()
        if not (isinstance(e, dict) and e.get("source") == "auto")
    }

    if args.only:
        photos = [p for p in photos if args.only in p["id"] or args.only in p["src"]]
    if args.limit:
        photos = photos[: args.limit]

    changed = skipped_manual = no_change = 0
    review: list = []
    for i, photo in enumerate(photos, 1):
        pid = photo["id"]
        if pid in manual:
            skipped_manual += 1
            continue
        print(f"[{i}/{len(photos)}] {pid}")

        raw = fetch(photo["src"])
        if raw is None:
            continue
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            print("    ! could not decode")
            continue

        h, w = image.shape[:2]
        faces = detect_faces(image)
        pct, why = focus_for(w, h, faces)
        if pct is None:
            print(f"    - {why}")
            no_change += 1
            continue

        value = f"center {pct:g}%"
        if abs(pct - DEFAULT_FOCUS_PCT) < 4:
            print(f"    - {why}; {value} is within a hair of the default")
            no_change += 1
            continue

        print(f"    -> {value}  ({why})")
        if args.sheet:
            review.append((pid, image, pct))
        if args.write:
            existing[pid] = {
                "focus": value,
                "source": "auto",
                "reason": f"Face detection: {why}.",
            }
        changed += 1

    print(
        f"\n{changed} photo(s) would move, {no_change} left at the default, "
        f"{skipped_manual} hand-tuned entr(ies) untouched."
    )
    if args.sheet and review:
        write_sheet(review, Path(args.sheet))
        print(f"review sheet: {args.sheet}  ({len(review)} photo(s))")

    if args.write:
        FOCUS.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {FOCUS.relative_to(ROOT)}")
    else:
        print("(report only — pass --write to save)")


if __name__ == "__main__":
    main()
