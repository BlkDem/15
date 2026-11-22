"""Нарезает иконки PWA из рендера Blender.

  python blender/make_icons.py icon_render.png public/icons
"""
import os
import sys

from PIL import Image, ImageDraw

src = Image.open(sys.argv[1]).convert("RGB")
out = sys.argv[2]
os.makedirs(out, exist_ok=True)


def rounded(img, radius_frac=0.225):
    w, h = img.size
    scale = 4  # сглаживание края маски
    mask = Image.new("L", (w * scale, h * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w * scale - 1, h * scale - 1), radius=int(w * scale * radius_frac), fill=255)
    mask = mask.resize((w, h), Image.LANCZOS)
    rgba = img.convert("RGBA")
    rgba.putalpha(mask)
    return rgba


def sized(size):
    return src.resize((size, size), Image.LANCZOS)


# maskable / apple — во весь квадрат (система сама скруглит)
sized(512).save(os.path.join(out, "maskable-512.png"), optimize=True)
sized(180).save(os.path.join(out, "apple-touch-icon.png"), optimize=True)

# «any» — с собственным скруглением; костяшка крупнее (кадрируем центр)
w, h = src.size
crop = src.crop((int(w * 0.06), int(h * 0.06), int(w * 0.94), int(h * 0.94)))
for size in (512, 192):
    rounded(crop.resize((size, size), Image.LANCZOS)).save(os.path.join(out, f"icon-{size}.png"), optimize=True)
rounded(crop.resize((64, 64), Image.LANCZOS)).save(os.path.join(out, "favicon-64.png"), optimize=True)
print("icons ->", out)
