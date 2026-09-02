#!/usr/bin/env python3
"""Add an invisible text layer to the pages of a PDF file.

The layer uses PDF text rendering mode 3. A viewer draws nothing for this
mode. A text extractor, a copy operation and a search index still read the
characters. The tool writes into the content stream of an existing page, so
the output file has the same page count as the input file.
"""

from __future__ import annotations

import argparse
import re
import sys
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Sequence

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    DecodedStreamObject,
    DictionaryObject,
    FloatObject,
    IndirectObject,
    NameObject,
    NumberObject,
    PdfObject,
    create_string_object,
)

__version__ = "1.0.0"

# Widths of Helvetica for the characters 32 to 126, in 1/1000 of the font
# size. The values come from the Adobe Core 14 metrics.
_HELVETICA_ASCII_WIDTHS = (
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    278, 278, 584, 584, 584, 556, 1015,
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
    778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
    278, 278, 278, 469, 556, 333,
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
    556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
    334, 260, 334, 584,
)

# The width for a Helvetica character that the metrics table does not list.
_HELVETICA_FALLBACK_WIDTH = 556

# The smallest font size that the tool accepts, in points. Text below this
# size stays readable for a text extractor, but the margin is unknown for
# every extractor. The layer is invisible at every size, so a larger size
# gives no benefit.
MIN_FONT_SIZE = 0.5
MAX_CID_COUNT = 0xFFFF


class InvisibleTextLayerError(Exception):
    """The tool cannot add the layer to the given file."""


def _num(value: float) -> str:
    """Return a PDF number with a maximum of 4 decimal places."""
    text = f"{value:.4f}".rstrip("0").rstrip(".")
    return text if text not in ("", "-") else "0"


# --------------------------------------------------------------------------
# Fonts
# --------------------------------------------------------------------------


class _Font:
    """A font for the invisible layer.

    A subclass maps the text to byte codes and reports the advance width of
    each character. The width is in multiples of the font size.
    """

    def width_em(self, char: str) -> float:
        raise NotImplementedError

    def encode(self, line: str) -> bytes:
        """Return the line as a PDF hexadecimal string, angle brackets included."""
        raise NotImplementedError

    def build(self, writer: PdfWriter) -> IndirectObject:
        """Add the font objects to the writer and return the font reference."""
        raise NotImplementedError


class LatinFont(_Font):
    """Helvetica with WinAnsiEncoding.

    The font covers the code page 1252 character set only. Every PDF viewer
    has this font, so the output needs no embedded font program.
    """

    name = "latin"

    @staticmethod
    def supports(text: str) -> bool:
        try:
            text.encode("cp1252")
        except UnicodeEncodeError:
            return False
        return True

    def width_em(self, char: str) -> float:
        code = ord(char)
        if 32 <= code <= 126:
            return _HELVETICA_ASCII_WIDTHS[code - 32] / 1000.0
        return _HELVETICA_FALLBACK_WIDTH / 1000.0

    def encode(self, line: str) -> bytes:
        return b"<" + line.encode("cp1252").hex().upper().encode("ascii") + b">"

    def build(self, writer: PdfWriter) -> IndirectObject:
        font = DictionaryObject()
        font[NameObject("/Type")] = NameObject("/Font")
        font[NameObject("/Subtype")] = NameObject("/Type1")
        font[NameObject("/BaseFont")] = NameObject("/Helvetica")
        font[NameObject("/Encoding")] = NameObject("/WinAnsiEncoding")
        return _add_object(writer, font)


class UnicodeFont(_Font):
    """A composite font with Identity-H encoding and a ToUnicode map.

    The font descriptor has no font program. Text in rendering mode 3 needs no
    glyph. A text extractor reads the characters through the ToUnicode map, so
    the layer supports the full Unicode range.
    """

    name = "unicode"

    def __init__(self, text: str) -> None:
        chars: list[str] = []
        cids: dict[str, int] = {}
        for char in text:
            if char in ("\n", "\r"):
                continue
            if char not in cids:
                cids[char] = len(chars) + 1
                chars.append(char)
        if len(chars) > MAX_CID_COUNT:
            raise InvisibleTextLayerError(
                f"the text has {len(chars)} different characters, "
                f"the limit is {MAX_CID_COUNT}"
            )
        self._cids = cids
        self._chars = chars

    def width_em(self, char: str) -> float:
        # The descendant font declares /DW 1000 and no /W array, so every
        # character advances by one font size.
        return 1.0

    def encode(self, line: str) -> bytes:
        codes = "".join(f"{self._cids[char]:04X}" for char in line)
        return b"<" + codes.encode("ascii") + b">"

    def _to_unicode_cmap(self) -> bytes:
        header = (
            "/CIDInit /ProcSet findresource begin\n"
            "12 dict begin\n"
            "begincmap\n"
            "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
            "/CMapName /Adobe-Identity-UCS def\n"
            "/CMapType 2 def\n"
            "1 begincodespacerange\n"
            "<0000> <FFFF>\n"
            "endcodespacerange\n"
        )
        body: list[str] = []
        # A bfchar section holds a maximum of 100 entries.
        for start in range(0, len(self._chars), 100):
            block = self._chars[start:start + 100]
            body.append(f"{len(block)} beginbfchar\n")
            for offset, char in enumerate(block, start=start + 1):
                target = char.encode("utf-16-be").hex().upper()
                body.append(f"<{offset:04X}> <{target}>\n")
            body.append("endbfchar\n")
        footer = (
            "endcmap\n"
            "CMapName currentdict /CMap defineresource pop\n"
            "end\n"
            "end\n"
        )
        return (header + "".join(body) + footer).encode("ascii")

    def build(self, writer: PdfWriter) -> IndirectObject:
        base_font = NameObject("/AAAAAA+InvisibleTextLayer")

        descriptor = DictionaryObject()
        descriptor[NameObject("/Type")] = NameObject("/FontDescriptor")
        descriptor[NameObject("/FontName")] = base_font
        descriptor[NameObject("/Flags")] = NumberObject(4)
        descriptor[NameObject("/FontBBox")] = ArrayObject(
            [NumberObject(0), NumberObject(-200), NumberObject(1000), NumberObject(900)]
        )
        descriptor[NameObject("/ItalicAngle")] = NumberObject(0)
        descriptor[NameObject("/Ascent")] = NumberObject(900)
        descriptor[NameObject("/Descent")] = NumberObject(-200)
        descriptor[NameObject("/CapHeight")] = NumberObject(700)
        descriptor[NameObject("/StemV")] = NumberObject(80)
        descriptor_ref = _add_object(writer, descriptor)

        system_info = DictionaryObject()
        system_info[NameObject("/Registry")] = create_string_object("Adobe")
        system_info[NameObject("/Ordering")] = create_string_object("Identity")
        system_info[NameObject("/Supplement")] = NumberObject(0)

        descendant = DictionaryObject()
        descendant[NameObject("/Type")] = NameObject("/Font")
        descendant[NameObject("/Subtype")] = NameObject("/CIDFontType2")
        descendant[NameObject("/BaseFont")] = base_font
        descendant[NameObject("/CIDSystemInfo")] = system_info
        descendant[NameObject("/FontDescriptor")] = descriptor_ref
        descendant[NameObject("/DW")] = NumberObject(1000)
        descendant[NameObject("/CIDToGIDMap")] = NameObject("/Identity")
        descendant_ref = _add_object(writer, descendant)

        to_unicode = DecodedStreamObject()
        to_unicode.set_data(self._to_unicode_cmap())
        to_unicode_ref = _add_object(writer, to_unicode)

        font = DictionaryObject()
        font[NameObject("/Type")] = NameObject("/Font")
        font[NameObject("/Subtype")] = NameObject("/Type0")
        font[NameObject("/BaseFont")] = base_font
        font[NameObject("/Encoding")] = NameObject("/Identity-H")
        font[NameObject("/DescendantFonts")] = ArrayObject([descendant_ref])
        font[NameObject("/ToUnicode")] = to_unicode_ref
        return _add_object(writer, font)


def select_font(text: str, mode: str) -> _Font:
    """Return the font for the text.

    mode is "auto", "latin" or "unicode". The "auto" mode uses LatinFont when
    the code page 1252 covers the text, and UnicodeFont in all other cases.
    """
    if mode == "latin":
        if not LatinFont.supports(text):
            raise InvisibleTextLayerError(
                "the text has characters outside code page 1252. "
                "Use --font unicode or --font auto."
            )
        return LatinFont()
    if mode == "unicode":
        return UnicodeFont(text)
    if mode != "auto":
        raise InvisibleTextLayerError(f"unknown font mode: {mode}")
    return LatinFont() if LatinFont.supports(text) else UnicodeFont(text)


# --------------------------------------------------------------------------
# Layout
# --------------------------------------------------------------------------


@dataclass
class Layout:
    lines: list[str]
    font_size: float
    leading: float
    x: float
    y: float
    overflow: bool


def wrap_text(text: str, max_width: float, width_of: Callable[[str], float]) -> list[str]:
    """Break the text into lines that are not wider than max_width.

    A "\\n" in the text starts a new line. The function breaks a long line at
    the last space. A line without a space breaks between two characters. A
    single character that is wider than max_width stays on its own line.
    """
    lines: list[str] = []
    for paragraph in text.split("\n"):
        if paragraph == "":
            lines.append("")
            continue
        current: list[str] = []
        current_width = 0.0
        space_index = -1
        for char in paragraph:
            char_width = width_of(char)
            if current and current_width + char_width > max_width:
                if 0 <= space_index < len(current):
                    head = current[:space_index]
                    tail = current[space_index + 1:]
                else:
                    head = current
                    tail = []
                lines.append("".join(head).rstrip())
                current = tail
                current_width = sum(width_of(c) for c in current)
                space_index = max(
                    (i for i, c in enumerate(current) if c == " "), default=-1
                )
            if char == " ":
                space_index = len(current)
            current.append(char)
            current_width += char_width
        lines.append("".join(current))
    return lines


def plan_layout(
    text: str,
    font: _Font,
    box: tuple[float, float, float, float],
    font_size: float,
    margin: float,
    position: str,
    line_spacing: float = 1.2,
) -> Layout:
    """Fit the text into the box and return the placement of every line.

    box is (left, bottom, right, top) in PDF user space units. font_size is the
    start size and MIN_FONT_SIZE is the lower limit. The function reduces the
    size until the lines fit in the box. If the lines still do not fit, the
    function reduces the line spacing and sets Layout.overflow to True.
    """
    if font_size < MIN_FONT_SIZE:
        raise InvisibleTextLayerError(
            f"the font size {font_size:g} is below the minimum of {MIN_FONT_SIZE:g} points"
        )
    left, bottom, right, top = box
    usable_width = (right - left) - 2 * margin
    usable_height = (top - bottom) - 2 * margin
    if usable_width <= 0 or usable_height <= 0:
        raise InvisibleTextLayerError(
            f"the margin {margin} is too large for a page of "
            f"{right - left:.1f} x {top - bottom:.1f} units"
        )

    size = font_size
    while True:
        lines = wrap_text(text, usable_width / size, font.width_em)
        leading = size * line_spacing
        if len(lines) * leading <= usable_height or size <= MIN_FONT_SIZE:
            break
        size = max(MIN_FONT_SIZE, size * 0.7)

    overflow = len(lines) * leading > usable_height
    if overflow:
        leading = usable_height / len(lines)

    x = left + margin
    block_height = (len(lines) - 1) * leading
    if position == "top":
        y = top - margin - size
    else:
        y = bottom + margin + 0.2 * size + block_height
    return Layout(lines=lines, font_size=size, leading=leading, x=x, y=y, overflow=overflow)


def build_content_stream(layout: Layout, font: _Font, resource_name: str) -> bytes:
    """Return the content stream that draws the text in rendering mode 3."""
    parts = [
        b"q\n",
        b"BT\n",
        b"3 Tr\n",
        b"0 Tc\n",
        b"0 Tw\n",
        b"100 Tz\n",
        b"0 Ts\n",
        f"{resource_name} {_num(layout.font_size)} Tf\n".encode("ascii"),
        f"1 0 0 1 {_num(layout.x)} {_num(layout.y)} Tm\n".encode("ascii"),
    ]
    for index, line in enumerate(layout.lines):
        if index:
            parts.append(f"0 {_num(-layout.leading)} Td\n".encode("ascii"))
        if line:
            parts.append(font.encode(line) + b" Tj\n")
    parts.append(b"ET\nQ\n")
    return b"".join(parts)


# --------------------------------------------------------------------------
# PDF page surgery
# --------------------------------------------------------------------------


def _add_object(writer: PdfWriter, obj: PdfObject) -> IndirectObject:
    return writer._add_object(obj)


def _make_stream(writer: PdfWriter, data: bytes, compress: bool) -> IndirectObject:
    stream = DecodedStreamObject()
    if compress and len(data) > 512:
        stream.set_data(zlib.compress(data, 9))
        stream[NameObject("/Filter")] = NameObject("/FlateDecode")
    else:
        stream.set_data(data)
    return _add_object(writer, stream)


def _own_resources(page: DictionaryObject) -> DictionaryObject:
    """Return a /Resources dictionary that belongs to this page alone.

    A page can inherit /Resources from a parent node, and several pages can
    share one dictionary. The function copies the entries into a new
    dictionary and attaches it to the page. A change to the copy leaves the
    other pages unchanged.
    """
    source: DictionaryObject | None = None
    node: DictionaryObject | None = page
    seen = 0
    while node is not None and seen < 64:
        if "/Resources" in node:
            source = node["/Resources"]
            break
        node = node["/Parent"].get_object() if "/Parent" in node else None
        seen += 1

    resources = DictionaryObject()
    if source is not None:
        for key, value in source.get_object().items():
            resources[NameObject(key)] = value
    page[NameObject("/Resources")] = resources
    return resources


def _add_font_resource(page: DictionaryObject, font_ref: IndirectObject) -> str:
    """Attach the font to the page and return the free resource name."""
    resources = _own_resources(page)
    fonts = DictionaryObject()
    if "/Font" in resources:
        for key, value in resources["/Font"].get_object().items():
            fonts[NameObject(key)] = value
    index = 0
    while f"/ITL{index}" in fonts:
        index += 1
    name = f"/ITL{index}"
    fonts[NameObject(name)] = font_ref
    resources[NameObject("/Font")] = fonts
    return name


_WHITESPACE = b"\x00\t\n\x0c\r "
_DELIMITERS = b"()<>[]{}/%"
_MAX_SCAN_BYTES = 64 * 1024 * 1024


def _skip_literal_string(data: bytes, start: int) -> int:
    """Return the index after the literal string that starts at start."""
    index = start + 1
    depth = 1
    while index < len(data) and depth:
        char = data[index]
        if char == 0x5C:  # backslash
            index += 2
            continue
        if char == 0x28:
            depth += 1
        elif char == 0x29:
            depth -= 1
        index += 1
    return index


def _skip_inline_image(data: bytes, start: int) -> int:
    """Return the index after the inline image that starts at the BI operator.

    The image data between ID and EI can hold any byte value. The scan looks
    for an EI operator with whitespace on both sides.
    """
    match = re.compile(rb"(?:^|[\x00\t\n\x0c\r ])ID").search(data, start)
    if match is None:
        return len(data)
    index = match.end() + 1
    end = re.compile(rb"[\x00\t\n\x0c\r ]EI(?:[\x00\t\n\x0c\r /\[<(]|$)").search(
        data, index
    )
    return len(data) if end is None else end.start() + 3


def content_stack_balance(data: bytes) -> tuple[int, int]:
    """Return the depth of the graphics state stack of a content stream.

    The result is (lowest_depth, final_depth), both relative to a start depth
    of 0. The scan counts the q and Q operators. It ignores comments, strings,
    names and inline image data. A stream that follows the PDF rules gives
    (0, 0).
    """
    lowest = 0
    depth = 0
    index = 0
    size = len(data)
    while index < size:
        char = data[index]
        if char in _WHITESPACE:
            index += 1
        elif char == 0x25:  # percent, starts a comment
            end = min(
                (pos for pos in (data.find(b"\n", index), data.find(b"\r", index)) if pos >= 0),
                default=size,
            )
            index = size if end == size else end + 1
        elif char == 0x28:
            index = _skip_literal_string(data, index)
        elif char == 0x2F:  # slash, starts a name
            index += 1
            while index < size and data[index] not in _WHITESPACE and data[index] not in _DELIMITERS:
                index += 1
        elif char in _DELIMITERS:
            index += 1
        else:
            start = index
            while index < size and data[index] not in _WHITESPACE and data[index] not in _DELIMITERS:
                index += 1
            token = data[start:index]
            if token == b"q":
                depth += 1
            elif token == b"Q":
                depth -= 1
                lowest = min(lowest, depth)
            elif token == b"BI":
                index = _skip_inline_image(data, index)
    return lowest, depth


def _content_streams(page: DictionaryObject) -> list[PdfObject]:
    if "/Contents" not in page:
        return []
    resolved = page.raw_get("/Contents").get_object()
    if isinstance(resolved, ArrayObject):
        return [item.get_object() for item in resolved]
    return [resolved]


def _guard_depth(page: DictionaryObject) -> tuple[int, int]:
    """Return the count of q operators to add before and Q operators to add after.

    The original content can leave the graphics state stack out of balance. The
    guard adds enough q operators to keep one private level, and enough Q
    operators to return to the default state of the page.
    """
    chunks: list[bytes] = []
    total = 0
    try:
        for stream in _content_streams(page):
            data = stream.get_data()
            total += len(data)
            if total > _MAX_SCAN_BYTES:
                raise ValueError("the content is too large for the scan")
            chunks.append(data)
        lowest, final = content_stack_balance(b"\n".join(chunks))
    except Exception:  # noqa: BLE001 - an unreadable stream falls back to one level
        lowest, final = 0, 0
    before = max(1, 1 - lowest)
    return before, before + final


def _append_content(
    writer: PdfWriter, page: DictionaryObject, data: bytes, compress: bool
) -> None:
    """Add the data after the content of the page.

    The function does not change the original streams. It adds one stream with
    q operators in front, and one stream that starts with Q operators and holds
    the new data. The graphics state of the original content cannot reach the
    new data.
    """
    if "/Contents" not in page:
        page[NameObject("/Contents")] = ArrayObject([_make_stream(writer, data, compress)])
        return

    before, after = _guard_depth(page)
    new_ref = _make_stream(writer, b"Q\n" * after + data, compress)
    save_ref = _make_stream(writer, b"q\n" * before, False)
    raw = page.raw_get("/Contents")
    resolved = raw.get_object()
    contents = ArrayObject([save_ref])
    if isinstance(resolved, ArrayObject):
        contents.extend(resolved)
    elif isinstance(raw, IndirectObject):
        contents.append(raw)
    else:
        contents.append(_add_object(writer, resolved))
    contents.append(new_ref)
    page[NameObject("/Contents")] = contents


def _text_box(page: DictionaryObject) -> tuple[float, float, float, float]:
    """Return the visible area of the page as (left, bottom, right, top)."""
    box = page.cropbox if "/CropBox" in page else page.mediabox
    left, right = sorted((float(box.left), float(box.right)))
    bottom, top = sorted((float(box.bottom), float(box.top)))
    return left, bottom, right, top


def add_invisible_text(
    writer: PdfWriter,
    page_index: int,
    text: str,
    *,
    font_mode: str = "auto",
    font_size: float = MIN_FONT_SIZE,
    margin: float = 18.0,
    position: str = "bottom",
    compress: bool = True,
) -> Layout:
    """Add the invisible text to one page and return the layout of the lines."""
    page = writer.pages[page_index]
    font = select_font(text, font_mode)
    layout = plan_layout(text, font, _text_box(page), font_size, margin, position)
    font_ref = font.build(writer)
    resource_name = _add_font_resource(page, font_ref)
    _append_content(writer, page, build_content_stream(layout, font, resource_name), compress)
    return layout


# --------------------------------------------------------------------------
# Page selection
# --------------------------------------------------------------------------


def parse_pages(spec: str, page_count: int) -> list[int]:
    """Return the 0 based page indexes for the specification.

    The specification is a comma separated list. Each item is "all", "first",
    "last", a 1 based page number, a negative page number that counts from the
    end, or a range such as "2-5".
    """
    selected: list[int] = []
    for raw_item in spec.split(","):
        item = raw_item.strip().lower()
        if not item:
            continue
        if item == "all":
            selected.extend(range(page_count))
        elif item == "first":
            selected.append(0)
        elif item == "last":
            selected.append(page_count - 1)
        elif "-" in item[1:]:
            start_text, _, end_text = item[1:].partition("-")
            start = _page_number(item[0] + start_text, page_count)
            end = _page_number(end_text, page_count)
            step = 1 if end >= start else -1
            selected.extend(range(start, end + step, step))
        else:
            selected.append(_page_number(item, page_count))

    result: list[int] = []
    for index in selected:
        if not 0 <= index < page_count:
            raise InvisibleTextLayerError(
                f"page {index + 1} is outside the document, which has {page_count} pages"
            )
        if index not in result:
            result.append(index)
    if not result:
        raise InvisibleTextLayerError(f"the page selection {spec!r} is empty")
    return result


def _page_number(text: str, page_count: int) -> int:
    try:
        number = int(text.strip())
    except ValueError:
        raise InvisibleTextLayerError(f"{text.strip()!r} is not a page number") from None
    if number == 0:
        raise InvisibleTextLayerError("page numbers start at 1")
    return number - 1 if number > 0 else page_count + number


# --------------------------------------------------------------------------
# Top level operation
# --------------------------------------------------------------------------


@dataclass
class Result:
    output: Path
    pages: list[int]
    font: str
    font_size: float
    line_count: int
    overflow: bool
    verified: bool | None


def process(
    input_path: Path,
    output_path: Path,
    text: str,
    *,
    pages: str = "last",
    font_mode: str = "auto",
    font_size: float = MIN_FONT_SIZE,
    margin: float = 18.0,
    position: str = "bottom",
    password: str | None = None,
    compress: bool = True,
    verify: bool = True,
) -> Result:
    """Copy the PDF and add the invisible text to the selected pages."""
    if not text:
        raise InvisibleTextLayerError("the text is empty")

    reader = PdfReader(str(input_path))
    if reader.is_encrypted:
        if reader.decrypt(password or "") == 0:
            raise InvisibleTextLayerError(
                "the file is encrypted. Give the password with --password."
            )
    page_count = len(reader.pages)
    if page_count == 0:
        raise InvisibleTextLayerError("the file has no pages")
    indexes = parse_pages(pages, page_count)

    writer = PdfWriter(clone_from=reader)
    layout = None
    for index in indexes:
        layout = add_invisible_text(
            writer,
            index,
            text,
            font_mode=font_mode,
            font_size=font_size,
            margin=margin,
            position=position,
            compress=compress,
        )
    assert layout is not None

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("wb") as handle:
        writer.write(handle)

    verified: bool | None = None
    if verify:
        verified = verify_text(output_path, text, indexes)

    return Result(
        output=output_path,
        pages=[index + 1 for index in indexes],
        font=select_font(text, font_mode).name,
        font_size=layout.font_size,
        line_count=len(layout.lines),
        overflow=layout.overflow,
        verified=verified,
    )


def verify_text(pdf_path: Path, text: str, page_indexes: Sequence[int]) -> bool:
    """Report whether a text extractor reads the text back from every page."""
    wanted = "".join(text.split())
    reader = PdfReader(str(pdf_path))
    for index in page_indexes:
        found = "".join(reader.pages[index].extract_text().split())
        if wanted not in found:
            return False
    return True


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------


def _read_text(args: argparse.Namespace) -> str:
    if args.text is not None:
        return args.text
    if args.text_file is not None:
        if str(args.text_file) == "-":
            return sys.stdin.read()
        return Path(args.text_file).read_text(encoding="utf-8")
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise InvisibleTextLayerError("give the text with --text, --text-file or stdin")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="invisible_text_layer",
        description=(
            "Add an invisible text layer to a PDF file. "
            "The output has the same page count as the input."
        ),
    )
    parser.add_argument("input", type=Path, help="the input PDF file")
    parser.add_argument(
        "-o", "--output", type=Path, help="the output PDF file (default: INPUT.invisible.pdf)"
    )
    source = parser.add_mutually_exclusive_group()
    source.add_argument("-t", "--text", help="the text of the layer")
    source.add_argument(
        "-f", "--text-file", help="a UTF-8 file with the text, or - for stdin"
    )
    parser.add_argument(
        "-p", "--pages", default="last",
        help='the target pages: all, first, last, 3, -1, 2-5 (default: last)',
    )
    parser.add_argument(
        "--font", choices=("auto", "latin", "unicode"), default="auto",
        help="the font type (default: auto)",
    )
    parser.add_argument(
        "--font-size", type=float, default=MIN_FONT_SIZE,
        help=(
            f"the start font size in points "
            f"(default and minimum: {MIN_FONT_SIZE:g})"
        ),
    )
    parser.add_argument(
        "--margin", type=float, default=18.0,
        help="the page margin in points (default: 18)",
    )
    parser.add_argument(
        "--position", choices=("bottom", "top"), default="bottom",
        help="the anchor of the text block (default: bottom)",
    )
    parser.add_argument("--password", help="the password of an encrypted input file")
    parser.add_argument(
        "--no-compress", dest="compress", action="store_false",
        help="write the new content stream without compression",
    )
    parser.add_argument(
        "--no-verify", dest="verify", action="store_false",
        help="skip the extraction check on the output file",
    )
    parser.add_argument(
        "--force", action="store_true", help="overwrite the output file"
    )
    parser.add_argument("--version", action="version", version=__version__)
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(list(argv) if argv is not None else None)
    try:
        if not args.input.is_file():
            raise InvisibleTextLayerError(f"the input file {args.input} does not exist")
        output = args.output or args.input.with_suffix(".invisible.pdf")
        if output.resolve() == args.input.resolve():
            raise InvisibleTextLayerError("the output file must differ from the input file")
        if output.exists() and not args.force:
            raise InvisibleTextLayerError(f"{output} exists. Use --force to overwrite it.")

        result = process(
            args.input,
            output,
            _read_text(args),
            pages=args.pages,
            font_mode=args.font,
            font_size=args.font_size,
            margin=args.margin,
            position=args.position,
            password=args.password,
            compress=args.compress,
            verify=args.verify,
        )
    except InvisibleTextLayerError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001
        print(f"error: {type(error).__name__}: {error}", file=sys.stderr)
        return 1

    pages = ", ".join(str(number) for number in result.pages)
    print(f"wrote {result.output}")
    print(
        f"  pages {pages} | font {result.font} | size {result.font_size:g} pt | "
        f"{result.line_count} lines"
    )
    if result.overflow:
        print("  warning: the lines overlap, because the text does not fit on the page")
    if result.verified is False:
        print("  warning: the extraction check did not find the text", file=sys.stderr)
        return 3
    if result.verified:
        print("  check: a text extractor reads the text back")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
