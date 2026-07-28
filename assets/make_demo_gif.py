#!/usr/bin/env python3
"""Regenerate assets/demo.gif — the README's terminal animation.

Usage:  python3 assets/make_demo_gif.py
Needs:  Pillow, and DejaVu Sans Mono (path below; adjust for your OS).
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent / "demo.gif"

W, H = 840, 600
PAD_X, TOP = 26, 64
LINE_H = 24
FONT_SIZE = 15

BG = (13, 17, 23)
BAR = (22, 27, 34)
BORDER = (48, 54, 61)
FG = (201, 209, 217)
DIM = (110, 118, 129)
RED = (248, 81, 73)
GREEN = (63, 185, 80)
PURPLE = (188, 140, 255)

FONT_DIR = "/usr/share/fonts/truetype/dejavu/"
mono = ImageFont.truetype(FONT_DIR + "DejaVuSansMono.ttf", FONT_SIZE)
bold = ImageFont.truetype(FONT_DIR + "DejaVuSansMono-Bold.ttf", FONT_SIZE)

# Each line: list of (text, color, font) segments. Reveal steps below control timing.
L = lambda *segs: [(t, c, f) for (t, c, f) in segs]

lines = [
    L(("$ ", GREEN, bold), ("claude", FG, mono)),
    L(),
    L(("> ", PURPLE, bold), ("push it", FG, mono)),                                   # 2: typed
    L(),
    L(("● ", GREEN, mono), ("Bash", FG, bold), ("(git push origin main)", DIM, mono)),
    L(("  └ ", DIM, mono), ("✗ huuk blocked `git push origin main`", RED, bold)),
    L(("      Rule ", DIM, mono), ('"gate-push"', FG, mono), (" — tests must pass before push", DIM, mono)),
    L(("      `pytest -q` failed (exit 1):", DIM, mono)),
    L(("        test_auth.py::test_login ", FG, mono), ("FAILED", RED, bold)),
    L(),
    L(("● ", GREEN, mono), ("The push was blocked — test_login is failing. Fixing it…", FG, mono)),
    L(("● ", GREEN, mono), ("Update", FG, bold), ("(tests/test_auth.py)", DIM, mono)),
    L(("  └ ", DIM, mono), ("Updated 1 line", DIM, mono)),
    L(("● ", GREEN, mono), ("Bash", FG, bold), ("(pytest -q)", DIM, mono)),
    L(("  └ ", DIM, mono), ("24 passed", GREEN, bold), (" in 1.8s", DIM, mono)),
    L(),
    L(("● ", GREEN, mono), ("Bash", FG, bold), ("(git push origin main)", DIM, mono)),
    L(("  └ ", DIM, mono), ("✓ main -> main", GREEN, bold), ("  (checks passed)", DIM, mono)),
    L(),
    L(("✓ Pushed. huuk gate: tests green on retry.", GREEN, bold)),
]

TYPED_LINE = 2      # "> push it" gets a per-character typing effect
TYPED_PREFIX = 1    # segments before the typed one

# (line_index_visible_through, duration_ms) — cumulative reveal schedule
steps = [
    (0, 900),    # $ claude
    (1, 350),
    # typing happens here (inserted programmatically)
    (3, 500),
    (4, 950),    # Bash(git push)
    (8, 2600),   # huuk block (hold so it can be read)
    (10, 1300),  # claude reacts
    (12, 900),   # edit
    (14, 1500),  # pytest passes
    (16, 900),   # retry push
    (17, 1600),  # success line
    (19, 3800),  # final ✓ + long hold before loop
]


def base_frame():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W - 1, H - 1], radius=12, fill=BG, outline=BORDER, width=2)
    d.rounded_rectangle([0, 0, W - 1, 44], radius=12, fill=BAR)
    d.rectangle([0, 24, W - 1, 44], fill=BAR)
    d.line([0, 44, W, 44], fill=BORDER)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([18 + i * 26, 15, 32 + i * 26, 29], fill=c)
    title = "huuk — Claude Code"
    tw = d.textlength(title, font=bold)
    d.text(((W - tw) / 2, 14), title, font=bold, fill=DIM)
    return img


def draw_lines(img, upto, typed_chars=None):
    d = ImageDraw.Draw(img)
    y = TOP
    for i, segs in enumerate(lines):
        if i > upto:
            break
        x = PAD_X
        for j, (text, color, font) in enumerate(segs):
            if i == TYPED_LINE and typed_chars is not None and j >= TYPED_PREFIX:
                text = text[:typed_chars]
            d.text((x, y), text, font=font, fill=color)
            x += d.textlength(text, font=font)
        if i == upto or (i == TYPED_LINE and typed_chars is not None):
            d.rectangle([x + 3, y + 2, x + 12, y + FONT_SIZE + 3], fill=FG)  # cursor
        y += LINE_H
    return img


frames, durations = [], []


def add(upto, ms, typed_chars=None):
    frames.append(draw_lines(base_frame(), upto, typed_chars))
    durations.append(ms)


emitted_typing = False
for upto, ms in steps:
    if not emitted_typing and upto >= TYPED_LINE:
        typed = "push it"
        for n in range(1, len(typed) + 1):
            add(TYPED_LINE, 90, typed_chars=n)
        durations[-1] = 700  # hold after typing finishes
        emitted_typing = True
    if upto == TYPED_LINE:
        continue
    add(upto, ms)

# quantize for a small file
frames = [f.quantize(colors=64, dither=Image.Dither.NONE) for f in frames]
frames[0].save(
    OUT,
    save_all=True,
    append_images=frames[1:],
    duration=durations,
    loop=0,
    optimize=True,
)
print(f"wrote {OUT} — frames={len(frames)} total_ms={sum(durations)}")
