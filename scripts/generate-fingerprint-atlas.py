#!/usr/bin/env python3
"""generate-fingerprint-atlas.py - Phase 64 Plan 10 (D-29).

Offline rasteriser for the 17-glyph fingerprint atlas that the Authority share PNG draws its
fingerprint band from (apps/VoteTorrentAuthority/src/utils/qr/share-png.ts). Nothing is rendered at
run time on a phone: the bitmaps are produced here, once, and committed as a generated TypeScript
module.

Locked font (D-29): JetBrains Mono Bold 2.304, taken from the local Android Studio JBR copy
  /Applications/Android Studio.app/Contents/jbr/Contents/Home/lib/fonts/JetBrainsMono-Bold.ttf
  sha256 5590990c82e097397517f275f430af4546e1c45cff408bde4255dad142479dcb
The font is SIL OFL 1.1; the licence text sits next to the generated module in
FINGERPRINT-ATLAS-LICENSE.txt. The TTF itself is never committed and never downloaded.

Run (stdlib plus Pillow only, no network):
  python3 -I scripts/generate-fingerprint-atlas.py --font <ttf> --write
  python3 -I scripts/generate-fingerprint-atlas.py --font <ttf> --check [--atlas <path>]

Exit codes: 0 ok, 1 check mismatch, 2 usage, 3 provenance refusal.
"""

import base64
import hashlib
import os
import re
import struct
import sys
import zlib

EXPECTED_FONT_SHA256 = "5590990c82e097397517f275f430af4546e1c45cff408bde4255dad142479dcb"
EXPECTED_PILLOW = "12.3.0"
GLYPHS = "0123456789abcdef "
SIZE_PX = 56

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ATLAS = os.path.normpath(
    os.path.join(HERE, "..", "apps", "VoteTorrentAuthority", "src", "utils", "qr", "fingerprint-atlas.generated.ts")
)


def refuse(reason):
    print("REFUSED: " + reason)
    sys.exit(3)


def usage():
    print("usage: generate-fingerprint-atlas.py --font <ttf> (--write | --check) [--atlas <path>]")
    sys.exit(2)


def read_name_table(data):
    num_tables = struct.unpack(">H", data[4:6])[0]
    table = None
    for i in range(num_tables):
        tag, _chk, off, length = struct.unpack(">4sIII", data[12 + 16 * i:12 + 16 * i + 16])
        if tag == b"name":
            table = data[off:off + length]
    if table is None:
        refuse("font has no name table")
    _fmt, count, string_offset = struct.unpack(">HHH", table[:6])
    names = {}
    for i in range(count):
        plat, _enc, lang, name_id, length, off = struct.unpack(">6H", table[6 + 12 * i:6 + 12 * i + 12])
        if plat == 3 and lang == 0x409:
            raw = table[string_offset + off:string_offset + off + length]
            names[name_id] = raw.decode("utf-16-be")
    return names


def render(font_path):
    try:
        import PIL
        from PIL import Image, ImageDraw, ImageFont, ImageOps, features
    except ImportError:
        refuse("Pillow is not importable")
    if PIL.__version__ != EXPECTED_PILLOW:
        refuse("Pillow %s, expected %s" % (PIL.__version__, EXPECTED_PILLOW))
    if not features.check("freetype2"):
        refuse("Pillow has no FreeType support")
    with open(font_path, "rb") as fh:
        data = fh.read()
    if hashlib.sha256(data).hexdigest() != EXPECTED_FONT_SHA256:
        refuse("font sha256 differs from the locked JetBrains Mono Bold 2.304")
    names = read_name_table(data)
    if not names.get(5, "").startswith("Version 2.304"):
        refuse("font name table version is not 2.304")
    if "SIL Open Font License, Version 1.1" not in names.get(13, ""):
        refuse("font name table licence is not SIL OFL 1.1")

    font = ImageFont.truetype(font_path, SIZE_PX, layout_engine=ImageFont.Layout.BASIC)
    if font.getname() != ("JetBrains Mono", "Bold"):
        refuse("font family/style is not JetBrains Mono Bold")
    advances = set(font.getlength(ch) for ch in GLYPHS)
    if len(advances) != 1:
        refuse("glyph advances are not all equal")
    advance = advances.pop()
    cell_w = int(-(-advance // 1))
    ascent, descent = font.getmetrics()
    cell_h = ascent + descent
    baseline = ascent

    n = len(GLYPHS)
    strip = Image.new("L", (cell_w * n, cell_h), 255)
    draw = ImageDraw.Draw(strip)
    for i, ch in enumerate(GLYPHS):
        draw.text((i * cell_w, baseline), ch, font=font, fill=0, anchor="ls")

    # containment: each glyph rendered alone in a 3x3-cell canvas must stay inside its own cell
    for ch in GLYPHS:
        big = Image.new("L", (cell_w * 3, cell_h * 3), 255)
        ImageDraw.Draw(big).text((cell_w, cell_h + baseline), ch, font=font, fill=0, anchor="ls")
        box = ImageOps.invert(big).getbbox()
        if box is None:
            continue
        if box[0] < cell_w or box[2] > cell_w * 2 or box[1] < cell_h or box[3] > cell_h * 2:
            refuse("glyph %r ink falls outside its own cell" % ch)

    ink = []
    for i, ch in enumerate(GLYPHS):
        cell = strip.crop((i * cell_w, 0, (i + 1) * cell_w, cell_h))
        box = ImageOps.invert(cell).getbbox()
        if ch == " ":
            if box is not None:
                refuse("space glyph has ink")
            ink.append(None)
            continue
        if box is None:
            refuse("glyph %r has no ink" % ch)
        if cell.getextrema()[0] != 0:
            refuse("glyph %r darkest pixel is not 0" % ch)
        ink.append([box[0], box[1], box[2] - 1, box[3] - 1])

    return {
        "cell_w": cell_w,
        "cell_h": cell_h,
        "baseline": baseline,
        "ink": ink,
        "raw": strip.tobytes(),
        "pillow": PIL.__version__,
        "freetype": features.version("freetype2"),
    }


def chunk_literals(text, width=100):
    return [text[i:i + width] for i in range(0, len(text), width)]


def emit(r, payload_b64=None):
    raw = r["raw"]
    strip_sha = hashlib.sha256(raw).hexdigest()
    if payload_b64 is None:
        payload_b64 = base64.b64encode(zlib.compress(raw, 9)).decode("ascii")
    lines = []
    lines.append("/**")
    lines.append(" * fingerprint-atlas.generated.ts - GENERATED by scripts/generate-fingerprint-atlas.py. Do not edit.")
    lines.append(" * Regenerate: python3 -I scripts/generate-fingerprint-atlas.py --font <JetBrainsMono-Bold.ttf> --write")
    lines.append(" *")
    lines.append(" * The bitmaps are derived from JetBrains Mono Bold 2.304 under the SIL Open Font License 1.1")
    lines.append(" * (see FINGERPRINT-ATLAS-LICENSE.txt). Provenance:")
    lines.append(" *   font sha256   " + EXPECTED_FONT_SHA256)
    lines.append(" *   Pillow        " + r["pillow"])
    lines.append(" *   FreeType      " + r["freetype"])
    lines.append(" *   zlib          " + zlib.ZLIB_VERSION)
    lines.append(" */")
    lines.append("")
    lines.append("export interface FingerprintAtlasData {")
    lines.append("\treadonly glyphs: string;")
    lines.append("\treadonly sizePx: number;")
    lines.append("\treadonly cellWidth: number;")
    lines.append("\treadonly cellHeight: number;")
    lines.append("\treadonly baseline: number;")
    lines.append("\treadonly ink: ReadonlyArray<readonly [number, number, number, number] | null>;")
    lines.append("\treadonly fontFamily: string;")
    lines.append("\treadonly fontStyle: string;")
    lines.append("\treadonly fontVersion: string;")
    lines.append("\treadonly fontSha256: string;")
    lines.append("\treadonly pillowVersion: string;")
    lines.append("\treadonly freetypeVersion: string;")
    lines.append("\treadonly stripSha256: string;")
    lines.append("\treadonly stripZlibBase64: string;")
    lines.append("}")
    lines.append("")
    lines.append("export const FINGERPRINT_ATLAS: FingerprintAtlasData = {")
    lines.append("\tglyphs: '%s'," % GLYPHS)
    lines.append("\tsizePx: %d," % SIZE_PX)
    lines.append("\tcellWidth: %d," % r["cell_w"])
    lines.append("\tcellHeight: %d," % r["cell_h"])
    lines.append("\tbaseline: %d," % r["baseline"])
    lines.append("\tink: [")
    for box in r["ink"]:
        lines.append("\t\tnull," if box is None else "\t\t[%d, %d, %d, %d]," % tuple(box))
    lines.append("\t],")
    lines.append("\tfontFamily: 'JetBrains Mono',")
    lines.append("\tfontStyle: 'Bold',")
    lines.append("\tfontVersion: '2.304',")
    lines.append("\tfontSha256: '%s'," % EXPECTED_FONT_SHA256)
    lines.append("\tpillowVersion: '%s'," % r["pillow"])
    lines.append("\tfreetypeVersion: '%s'," % r["freetype"])
    lines.append("\tstripSha256: '%s'," % strip_sha)
    # '+' is written as the escape \x2b: the Authority raw-error guard scans every source line for
    # a '+' followed by an error-ish identifier, and a base64 payload would trip it by chance.
    lits = [c.replace("+", "\\x2b") for c in chunk_literals(payload_b64)]
    lines.append("\tstripZlibBase64:")
    for i, lit in enumerate(lits):
        lines.append("\t\t'%s'%s" % (lit, " +" if i < len(lits) - 1 else ","))
    lines.append("};")
    lines.append("")
    return "\n".join(lines)


def fields(text):
    out = {}
    for name in ("cellWidth", "cellHeight", "baseline", "sizePx"):
        m = re.search(r"^\t%s: (\d+),$" % name, text, re.M)
        out[name] = m.group(1) if m else None
    for name in ("glyphs", "fontFamily", "fontStyle", "fontVersion", "fontSha256", "pillowVersion",
                 "freetypeVersion", "stripSha256"):
        m = re.search(r"^\t%s: '([^']*)',$" % name, text, re.M)
        out[name] = m.group(1) if m else None
    m = re.search(r"^\tink: \[\n(.*?)^\t\],$", text, re.M | re.S)
    out["ink"] = m.group(1) if m else None
    m = re.search(r"^\tstripZlibBase64:\n((?:\t\t'[^']*'(?: \+|,)\n)+)", text, re.M)
    out["stripZlibBase64"] = "".join(re.findall(r"'([^']*)'", m.group(1))).replace("\\x2b", "+") if m else None
    return out


def main(argv):
    font = None
    mode = None
    atlas = DEFAULT_ATLAS
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--font" and i + 1 < len(argv):
            font = argv[i + 1]
            i += 2
        elif a == "--atlas" and i + 1 < len(argv):
            atlas = argv[i + 1]
            i += 2
        elif a in ("--write", "--check") and mode is None:
            mode = a
            i += 1
        else:
            usage()
    if font is None or mode is None:
        usage()
    if mode == "--write" and atlas != DEFAULT_ATLAS:
        usage()

    r = render(font)

    if mode == "--write":
        text = emit(r)
        with open(DEFAULT_ATLAS, "w", encoding="ascii", newline="\n") as fh:
            fh.write(text)
        print("ATLAS glyphs=17 cell=%dx%d baseline=%d strip_sha256=%s bytes=%d" % (
            r["cell_w"], r["cell_h"], r["baseline"], hashlib.sha256(r["raw"]).hexdigest()[:12],
            len(text.encode("ascii"))))
        return 0

    try:
        with open(atlas, "r", encoding="ascii") as fh:
            committed = fh.read()
    except OSError:
        print("ATLAS CHECK: MISMATCH unreadable")
        return 1
    fresh = emit(r)
    if fresh == committed:
        print("ATLAS CHECK: IDENTICAL")
        return 0
    want = fields(fresh)
    have = fields(committed)
    for name in want:
        if name == "stripZlibBase64":
            continue
        if want[name] != have[name]:
            print("ATLAS CHECK: MISMATCH " + name)
            return 1
    try:
        inflated = zlib.decompress(base64.b64decode(have["stripZlibBase64"] or ""))
    except Exception:
        print("ATLAS CHECK: MISMATCH stripZlibBase64")
        return 1
    if inflated != r["raw"]:
        print("ATLAS CHECK: MISMATCH stripZlibBase64")
        return 1
    print("ATLAS CHECK: EQUIVALENT (compressed payload differs; strip identical)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
