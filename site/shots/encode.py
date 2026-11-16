#!/usr/bin/env python3
"""The landing's renders, from capture.mjs's PNGs: each at two widths, as WebP.

    python3 site/shots/encode.py [raw folder]

The raw folder defaults to $NEBULA_SHOTS_RAW, else <tmp>/nebula-shots-raw. Menus
are cropped to the rail, the menu and the start of the note, so their words stay
readable at the size the landing shows them.
"""
import json
import os
import sys
import tempfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('NEBULA_SHOTS_RAW', os.path.join(tempfile.gettempdir(), 'nebula-shots-raw'))

SCALE = 2  # capture.mjs shoots at deviceScaleFactor 2
VIEW = (1440, 900)  # and a 1440x900 window

# name: (crop around the open menu?, widths)
SHOTS = {
    'workspace': (False, (1920, 960)),
    'canvas': (False, (1920, 960)),
    'paste': (True, (1520, 760)),
    'link': (True, (1520, 760)),
}

# A menu shot keeps the rail, the menu and the start of the note: 760x475 of
# the window (16:10), shown near its own size so the menu's words read.
CROP_W, CROP_H, MARGIN = 760, 475, 28

with open(os.path.join(RAW, 'boxes.json')) as handle:
    BOXES = json.load(handle)


def menu_crop(box):
    top = max(0, box['y'] - 150)
    if box['y'] + box['height'] + MARGIN > top + CROP_H:
        top = box['y'] + box['height'] + MARGIN - CROP_H
    top = min(max(0, top), VIEW[1] - CROP_H)
    return tuple(round(v * SCALE) for v in (0, top, CROP_W, top + CROP_H))


for name, (menu, widths) in SHOTS.items():
    for theme in ('night', 'day'):
        source = os.path.join(RAW, f'{name}-{theme}.png')
        image = Image.open(source).convert('RGB')
        if menu:
            image = image.crop(menu_crop(BOXES[f'{name}-{theme}']))
        for width in widths:
            height = round(image.height * width / image.width)
            out = os.path.join(HERE, f'{name}-{theme}-{width}.webp')
            image.resize((width, height), Image.Resampling.LANCZOS).save(out, 'WEBP', quality=82, method=6)
            print(f'{os.path.relpath(out)}  {width}x{height}  {os.path.getsize(out) // 1024} KB')
