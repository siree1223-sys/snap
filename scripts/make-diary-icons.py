"""Draws the Snap Diary icons: a round photo 'lens' whose grains drift away to
the upper right, the Meet Vanish dust effect as a mark. Run from the repo root:
    python3 scripts/make-diary-icons.py
"""
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "snap-diary" / "icons"
BG = (21, 19, 27)
STOPS = [(255, 196, 120), (244, 114, 140), (148, 108, 255)]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(t):
    t = max(0.0, min(1.0, t))
    if t < 0.5:
        return lerp(STOPS[0], STOPS[1], t * 2)
    return lerp(STOPS[1], STOPS[2], (t - 0.5) * 2)


def draw(size, safe=1.0, rounded=True):
    scale = 4  # supersample
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG + (255,))
    else:
        d.rectangle([0, 0, s, s], fill=BG + (255,))
    rng = random.Random(7187)
    cx, cy, r = s * 0.46, s * 0.55, s * 0.27 * safe
    cell = s * 0.03 * safe
    n = int(r * 2 / cell) + 2
    for gy in range(n):
        for gx in range(n):
            x = cx - r + (gx + 0.5) * cell
            y = cy - r + (gy + 0.5) * cell
            if math.hypot(x - cx, y - cy) > r:
                continue
            u = (x - (cx - r)) / (2 * r)
            v = (y - (cy - r)) / (2 * r)
            color = gradient(0.15 + 0.7 * (u * 0.6 + (1 - v) * 0.4))
            release = u + (rng.random() - 0.5) * 0.35
            if release > 0.62:
                age = min(1.0, (release - 0.62) / 0.5)
                dx = (0.35 + rng.random() * 0.9) * age * s * 0.32 * safe
                dy = -(0.25 + rng.random() * 0.8) * age * s * 0.28 * safe
                rad = cell * (0.42 - 0.22 * age) * (0.7 + rng.random() * 0.6)
                alpha = int(255 * (1 - 0.65 * age))
                d.ellipse([x + dx - rad, y + dy - rad, x + dx + rad, y + dy + rad], fill=color + (alpha,))
            else:
                h = cell * 0.56
                d.rectangle([x - h, y - h, x + h, y + h], fill=color + (255,))
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    draw(192).save(OUT / "icon-192.png")
    draw(512).save(OUT / "icon-512.png")
    draw(512, safe=0.78, rounded=False).save(OUT / "icon-maskable-512.png")
    apple = Image.new("RGBA", (180, 180), BG + (255,))
    apple.alpha_composite(draw(180, rounded=False))
    apple.convert("RGB").save(OUT / "apple-touch-icon.png")
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
