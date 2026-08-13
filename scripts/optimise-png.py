#!/usr/bin/env python3
"""Losslessly shrink a PNG in place. Called by the guide capture run.

Lossless on purpose: these images are screenshots of text, and quantising
them makes small type mushy exactly where a reader is trying to read it.
"""
import sys
from PIL import Image

for path in sys.argv[1:]:
    with Image.open(path) as image:
        image.load()
        image.save(path, format="PNG", optimize=True)
