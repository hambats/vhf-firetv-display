#!/usr/bin/env python3
"""Generate the Fire TV app's launcher icon and home-screen banner from the VHF logo.

Source of truth is content/artwork/brand/vhf-logo.webp — the same file the display itself
uses. Run this after the logo changes; it rewrites everything under app/src/main/res.

    python scripts/generate-app-icons.py

Requires Pillow. Nothing in the normal build calls this: icons change about as often as the
logo does, and checked-in PNGs keep `assembleRelease` free of a Python dependency.
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required:  pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "content" / "artwork" / "brand" / "vhf-logo.webp"
RES = ROOT / "app" / "src" / "main" / "res"

# Brand dark green, matching the banner background the shell already used.
BRAND_BG = (27, 46, 31, 255)
BRAND_CREAM = (222, 214, 185, 255)

# Android density buckets: directory suffix -> px for a 48dp launcher icon.
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

# An adaptive icon's 108dp canvas is masked down to a 72dp safe zone. The logo is a circular
# seal with a thin outer ring, so anything larger than the safe zone loses that ring on
# launchers using a circle mask.
ADAPTIVE_CANVAS_DP = 108
ADAPTIVE_SAFE_DP = 72

# 320x180 is the xhdpi banner spec Amazon publishes. The 2x copy keeps the tile crisp on
# 4K panels, which report a higher density and would otherwise upscale the small one.
BANNER_SIZES = {"xhdpi": 1, "xxxhdpi": 2}
BANNER_W, BANNER_H = 320, 180

WORDMARK_CANDIDATES = [
    Path("C:/Windows/Fonts/seguisb.ttf"),   # Segoe UI Semibold
    Path("C:/Windows/Fonts/segoeuib.ttf"),  # Segoe UI Bold
    Path("C:/Windows/Fonts/arialbd.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
]


def load_logo() -> Image.Image:
    """The logo trimmed to its own alpha bounds, so scaling math is about the mark itself."""
    img = Image.open(LOGO).convert("RGBA")
    bbox = img.getchannel("A").getbbox()
    return img.crop(bbox) if bbox else img


def fit(logo: Image.Image, size: int) -> Image.Image:
    """Scale the logo to fit a size x size box, preserving aspect ratio."""
    scale = size / max(logo.size)
    target = (max(1, round(logo.width * scale)), max(1, round(logo.height * scale)))
    return logo.resize(target, Image.LANCZOS)


def centered(canvas_px: int, logo_px: int, logo: Image.Image) -> Image.Image:
    canvas = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
    mark = fit(logo, logo_px)
    canvas.alpha_composite(
        mark, ((canvas_px - mark.width) // 2, (canvas_px - mark.height) // 2)
    )
    return canvas


def write(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", optimize=True)
    print(f"  {path.relative_to(ROOT)}  {img.width}x{img.height}")


def pick_font(px: int) -> ImageFont.FreeTypeFont:
    for candidate in WORDMARK_CANDIDATES:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), px)
    return ImageFont.load_default()


def draw_tracked(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    font: ImageFont.FreeTypeFont,
    tracking: float,
) -> float:
    """Draw letter-spaced text (Pillow has no tracking). Returns the width drawn."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=BRAND_CREAM)
        x += draw.textlength(ch, font=font) + tracking
    return x - tracking - xy[0]


def text_width(draw: ImageDraw.ImageDraw, text: str, font, tracking: float) -> float:
    return sum(draw.textlength(c, font=font) for c in text) + tracking * (len(text) - 1)


def build_launcher_icons(logo: Image.Image) -> None:
    print("Launcher icons (legacy, pre-API-26 — unmasked, so near full bleed):")
    for suffix, px in DENSITIES.items():
        icon = centered(px, round(px * 0.94), logo)
        write(icon, RES / f"mipmap-{suffix}" / "ic_launcher.png")
        write(icon, RES / f"mipmap-{suffix}" / "ic_launcher_round.png")

    print("Adaptive icon foreground (API 26+ — inset to the 72dp safe zone):")
    for suffix, px in DENSITIES.items():
        canvas_px = round(px * ADAPTIVE_CANVAS_DP / 48)
        logo_px = round(px * ADAPTIVE_SAFE_DP / 48)
        write(
            centered(canvas_px, logo_px, logo),
            RES / f"mipmap-{suffix}" / "ic_launcher_foreground.png",
        )


def build_banner(logo: Image.Image, scale: int) -> Image.Image:
    """Fire TV home-row tile.

    The seal's own ring text is unreadable at this height, so the name is set beside the
    mark instead of relying on it.
    """
    w, h = BANNER_W * scale, BANNER_H * scale
    banner = Image.new("RGBA", (w, h), BRAND_BG)
    draw = ImageDraw.Draw(banner)

    mark = fit(logo, 132 * scale)
    mark_x = 16 * scale
    banner.alpha_composite(mark, (mark_x, (h - mark.height) // 2))

    tracking = 2.2 * scale
    lines = ["VETERANS", "HEALING", "FARM"]
    line_h = 30 * scale
    text_x = mark_x + mark.width + 16 * scale
    available = w - text_x - 12 * scale

    # Shrink until the longest line fits rather than letting it run off the tile.
    font = pick_font(21 * scale)
    while (max(text_width(draw, l, font, tracking) for l in lines) > available
           and font.size > 11 * scale):
        font = pick_font(font.size - 1)

    top = (h - line_h * len(lines)) // 2 + 2 * scale
    for i, line in enumerate(lines):
        draw_tracked(draw, (text_x, top + i * line_h), line, font, tracking)

    return banner


def main() -> None:
    if not LOGO.exists():
        sys.exit(f"Logo not found: {LOGO}")
    logo = load_logo()
    print(f"Source: {LOGO.relative_to(ROOT)}  (trimmed to {logo.width}x{logo.height})\n")
    build_launcher_icons(logo)
    print("Fire TV banner:")
    for suffix, scale in BANNER_SIZES.items():
        write(build_banner(logo, scale), RES / f"drawable-{suffix}" / "banner.png")
    print("\nDone. Rebuild with:  ./gradlew :app:assembleRelease")


if __name__ == "__main__":
    main()
