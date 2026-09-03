/**
 * Add an invisible text layer to a page of a PDF file.
 *
 * The layer uses PDF text rendering mode 3. A viewer draws nothing for this
 * mode. A text extractor, a copy operation and a search index still read the
 * characters. The tool writes into a page that already exists, so the output
 * keeps the page count of the input.
 *
 * This module is a port of invisible_text_layer.py. Both keep the same
 * operator sequence and the same character codes.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import type { PDFContext, PDFPage } from '@cantoo/pdf-lib';

/**
 * Widths of Helvetica for the characters 32 to 126, in 1/1000 of the font
 * size. The values come from the Adobe Core 14 metrics.
 */
const HELVETICA_ASCII_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
  778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
  556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
];

/** The width for a Helvetica character that the metrics table does not list. */
const HELVETICA_FALLBACK_WIDTH = 556;

/**
 * The smallest font size that the tool accepts, in points. Text below this
 * size stays readable for a text extractor, but the margin is unknown for
 * every extractor. The layer is invisible at every size, so a larger size
 * gives no benefit.
 */
export const MIN_FONT_SIZE = 0.5;

const MAX_CID_COUNT = 0xffff;

export class InvisibleTextLayerError extends Error {}

/** The characters of WinAnsiEncoding in the range 0x80 to 0x9F. */
const WIN_ANSI_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

const WIN_ANSI_HIGH_REVERSE = new Map<number, number>(
  Object.entries(WIN_ANSI_HIGH).map(([code, byte]) => [byte, Number(code)]),
);

/** Return the WinAnsi byte for a character, or null if the encoding has none. */
function winAnsiByte(char: string): number | null {
  const code = char.codePointAt(0)!;
  if (code >= 0x20 && code <= 0x7e) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  return WIN_ANSI_HIGH[code] ?? null;
}

/** Return a PDF number with a maximum of 4 decimal places. */
export function num(value: number): string {
  let text = value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (text === '' || text === '-' || text === '-0') text = '0';
  return text;
}

// ---------------------------------------------------------------------------
// Graphics state balance
// ---------------------------------------------------------------------------

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));

/** Return the index after the inline image that starts at the BI operator. */
function skipInlineImage(data: Uint8Array, start: number): number {
  let index = start;
  while (index < data.length - 1) {
    if (data[index] === 0x49 && data[index + 1] === 0x44) {
      const before = index === 0 ? 0x20 : data[index - 1];
      if (WHITESPACE.has(before) || DELIMITERS.has(before)) {
        index += 3;
        break;
      }
    }
    index += 1;
  }
  // The image data can hold any byte. Look for EI with whitespace on both sides.
  for (let i = index; i < data.length - 2; i += 1) {
    if (WHITESPACE.has(data[i]) && data[i + 1] === 0x45 && data[i + 2] === 0x49) {
      const after = i + 3 < data.length ? data[i + 3] : 0x20;
      if (WHITESPACE.has(after) || DELIMITERS.has(after)) return i + 3;
    }
  }
  return data.length;
}

/**
 * Return the depth of the graphics state stack of a content stream.
 *
 * The result is [lowestDepth, finalDepth], both relative to a start depth of
 * 0. The scan counts the q and Q operators. It ignores comments, strings,
 * names and inline image data. A stream that follows the PDF rules gives
 * [0, 0].
 */
export function stackBalance(data: Uint8Array): [number, number] {
  let lowest = 0;
  let depth = 0;
  let index = 0;
  while (index < data.length) {
    const char = data[index];
    if (WHITESPACE.has(char)) {
      index += 1;
    } else if (char === 0x25) {
      while (index < data.length && data[index] !== 0x0a && data[index] !== 0x0d) index += 1;
    } else if (char === 0x28) {
      let nesting = 1;
      index += 1;
      while (index < data.length && nesting > 0) {
        if (data[index] === 0x5c) {
          index += 2;
          continue;
        }
        if (data[index] === 0x28) nesting += 1;
        else if (data[index] === 0x29) nesting -= 1;
        index += 1;
      }
    } else if (char === 0x2f) {
      index += 1;
      while (index < data.length && !WHITESPACE.has(data[index]) && !DELIMITERS.has(data[index])) {
        index += 1;
      }
    } else if (DELIMITERS.has(char)) {
      index += 1;
    } else {
      const start = index;
      while (index < data.length && !WHITESPACE.has(data[index]) && !DELIMITERS.has(data[index])) {
        index += 1;
      }
      const token = String.fromCharCode(...data.subarray(start, index));
      if (token === 'q') {
        depth += 1;
      } else if (token === 'Q') {
        depth -= 1;
        lowest = Math.min(lowest, depth);
      } else if (token === 'BI') {
        index = skipInlineImage(data, index);
      }
    }
  }
  return [lowest, depth];
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/**
 * A font for the invisible layer.
 *
 * The font maps the text to byte codes and reports the advance width of each
 * character. The width is in multiples of the font size.
 */
export interface LayerFont {
  readonly kind: 'latin' | 'unicode';
  widthEm(char: string): number;
  encode(line: string): PDFHexString;
  build(context: PDFContext): PDFRef;
  /** Map the codes of an encoded line back to text. The check uses this. */
  decode(hex: string): string;
}

/**
 * Helvetica with WinAnsiEncoding.
 *
 * The font covers the WinAnsi character set only. Every PDF viewer has this
 * font, so the output needs no embedded font program.
 */
export class LatinFont implements LayerFont {
  readonly kind = 'latin';

  static supports(text: string): boolean {
    for (const char of text) {
      if (char === '\n' || char === '\r') continue;
      if (winAnsiByte(char) === null) return false;
    }
    return true;
  }

  widthEm(char: string): number {
    const code = char.charCodeAt(0);
    const width =
      code >= 32 && code <= 126 ? HELVETICA_ASCII_WIDTHS[code - 32] : HELVETICA_FALLBACK_WIDTH;
    return width / 1000;
  }

  encode(line: string): PDFHexString {
    let hex = '';
    for (const char of line) {
      hex += winAnsiByte(char)!.toString(16).padStart(2, '0').toUpperCase();
    }
    return PDFHexString.of(hex);
  }

  decode(hex: string): string {
    let text = '';
    for (let i = 0; i + 1 < hex.length; i += 2) {
      const byte = parseInt(hex.slice(i, i + 2), 16);
      const high = WIN_ANSI_HIGH_REVERSE.get(byte);
      text += high === undefined ? String.fromCharCode(byte) : String.fromCodePoint(high);
    }
    return text;
  }

  build(context: PDFContext): PDFRef {
    return context.register(
      context.obj({
        Type: 'Font',
        Subtype: 'Type1',
        BaseFont: 'Helvetica',
        Encoding: 'WinAnsiEncoding',
      }),
    );
  }
}

/**
 * A composite font with Identity-H encoding and a ToUnicode map.
 *
 * The font descriptor has no font program. Text in rendering mode 3 needs no
 * glyph. A text extractor reads the characters through the ToUnicode map, so
 * the layer supports the full Unicode range.
 */
export class UnicodeFont implements LayerFont {
  readonly kind = 'unicode';
  private readonly cids = new Map<string, number>();
  private readonly chars: string[] = [];

  constructor(text: string) {
    for (const char of text) {
      if (char === '\n' || char === '\r') continue;
      if (!this.cids.has(char)) {
        this.cids.set(char, this.chars.length + 1);
        this.chars.push(char);
      }
    }
    if (this.chars.length > MAX_CID_COUNT) {
      throw new InvisibleTextLayerError(
        `the text has ${this.chars.length} different characters, the limit is ${MAX_CID_COUNT}`,
      );
    }
  }

  widthEm(): number {
    // The descendant font declares /DW 1000 and no /W array, so every
    // character advances by one font size.
    return 1.0;
  }

  encode(line: string): PDFHexString {
    let hex = '';
    for (const char of line) {
      hex += this.cids.get(char)!.toString(16).padStart(4, '0').toUpperCase();
    }
    return PDFHexString.of(hex);
  }

  decode(hex: string): string {
    let text = '';
    for (let i = 0; i + 3 < hex.length; i += 4) {
      const cid = parseInt(hex.slice(i, i + 4), 16);
      text += this.chars[cid - 1] ?? '';
    }
    return text;
  }

  private toUnicodeCMap(): string {
    let out =
      '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
      '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
    // A bfchar section holds a maximum of 100 entries.
    for (let start = 0; start < this.chars.length; start += 100) {
      const block = this.chars.slice(start, start + 100);
      out += `${block.length} beginbfchar\n`;
      block.forEach((char, offset) => {
        const cid = start + offset + 1;
        let target = '';
        for (let i = 0; i < char.length; i += 1) {
          target += char.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
        }
        out += `<${cid.toString(16).padStart(4, '0').toUpperCase()}> <${target}>\n`;
      });
      out += 'endbfchar\n';
    }
    return out + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n';
  }

  build(context: PDFContext): PDFRef {
    const baseFont = 'AAAAAA+InvisibleTextLayer';
    const descriptor = context.register(
      context.obj({
        Type: 'FontDescriptor',
        FontName: baseFont,
        Flags: 4,
        FontBBox: [0, -200, 1000, 900],
        ItalicAngle: 0,
        Ascent: 900,
        Descent: -200,
        CapHeight: 700,
        StemV: 80,
      }),
    );
    const descendant = context.register(
      context.obj({
        Type: 'Font',
        Subtype: 'CIDFontType2',
        BaseFont: baseFont,
        CIDSystemInfo: {
          Registry: PDFHexString.fromText('Adobe'),
          Ordering: PDFHexString.fromText('Identity'),
          Supplement: 0,
        },
        FontDescriptor: descriptor,
        DW: 1000,
        CIDToGIDMap: 'Identity',
      }),
    );
    const toUnicode = context.register(context.flateStream(this.toUnicodeCMap()));
    return context.register(
      context.obj({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: baseFont,
        Encoding: 'Identity-H',
        DescendantFonts: [descendant],
        ToUnicode: toUnicode,
      }),
    );
  }
}

export type FontMode = 'auto' | 'latin' | 'unicode';

/**
 * Return the font for the text.
 *
 * The "auto" mode uses LatinFont when WinAnsiEncoding covers the text, and
 * UnicodeFont in all other cases.
 */
export function selectFont(text: string, mode: FontMode = 'auto'): LayerFont {
  if (mode === 'latin') {
    if (!LatinFont.supports(text)) {
      throw new InvisibleTextLayerError(
        'the text has characters outside WinAnsiEncoding. Use the unicode font.',
      );
    }
    return new LatinFont();
  }
  if (mode === 'unicode') return new UnicodeFont(text);
  return LatinFont.supports(text) ? new LatinFont() : new UnicodeFont(text);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface Layout {
  lines: string[];
  fontSize: number;
  leading: number;
  x: number;
  y: number;
  overflow: boolean;
}

/**
 * Break the text into lines that are not wider than maxWidth.
 *
 * A "\n" in the text starts a new line. The function breaks a long line at
 * the last space. A line without a space breaks between two characters. A
 * single character that is wider than maxWidth stays on its own line.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  widthOf: (char: string) => number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let current: string[] = [];
    let width = 0;
    let spaceIndex = -1;
    for (const char of paragraph) {
      const charWidth = widthOf(char);
      if (current.length > 0 && width + charWidth > maxWidth) {
        let head: string[];
        let tail: string[];
        if (spaceIndex >= 0 && spaceIndex < current.length) {
          head = current.slice(0, spaceIndex);
          tail = current.slice(spaceIndex + 1);
        } else {
          head = current;
          tail = [];
        }
        lines.push(head.join('').replace(/\s+$/, ''));
        current = tail;
        width = current.reduce((sum, c) => sum + widthOf(c), 0);
        spaceIndex = current.lastIndexOf(' ');
      }
      if (char === ' ') spaceIndex = current.length;
      current.push(char);
      width += charWidth;
    }
    lines.push(current.join(''));
  }
  return lines;
}

export type Position = 'bottom' | 'top';

/**
 * Fit the text into the box and return the placement of every line.
 *
 * The box is [left, bottom, right, top] in PDF user space units. fontSize is
 * the start size and MIN_FONT_SIZE is the lower limit. The function reduces
 * the size until the lines fit in the box. If the lines still do not fit, the
 * function reduces the line spacing and sets overflow to true.
 */
export function planLayout(
  text: string,
  font: LayerFont,
  box: [number, number, number, number],
  fontSize: number,
  margin: number,
  position: Position = 'bottom',
  lineSpacing = 1.2,
): Layout {
  if (fontSize < MIN_FONT_SIZE) {
    throw new InvisibleTextLayerError(
      `the font size ${num(fontSize)} is below the minimum of ${MIN_FONT_SIZE} points`,
    );
  }
  const [left, bottom, right, top] = box;
  const usableWidth = right - left - 2 * margin;
  const usableHeight = top - bottom - 2 * margin;
  if (usableWidth <= 0 || usableHeight <= 0) {
    throw new InvisibleTextLayerError(
      `the margin ${num(margin)} is too large for a page of ` +
        `${num(right - left)} x ${num(top - bottom)} units`,
    );
  }

  let size = fontSize;
  let lines: string[];
  let leading: number;
  for (;;) {
    lines = wrapText(text, usableWidth / size, (c) => font.widthEm(c));
    leading = size * lineSpacing;
    if (lines.length * leading <= usableHeight || size <= MIN_FONT_SIZE) break;
    size = Math.max(MIN_FONT_SIZE, size * 0.7);
  }

  const overflow = lines.length * leading > usableHeight;
  if (overflow) leading = usableHeight / lines.length;

  const blockHeight = (lines.length - 1) * leading;
  const y = position === 'top' ? top - margin - size : bottom + margin + 0.2 * size + blockHeight;
  return { lines, fontSize: size, leading, x: left + margin, y, overflow };
}

/** Return the content stream that draws the text in rendering mode 3. */
export function buildContentStream(layout: Layout, font: LayerFont, resourceName: string): string {
  const parts = [
    'q',
    'BT',
    '3 Tr',
    '0 Tc',
    '0 Tw',
    '100 Tz',
    '0 Ts',
    `${resourceName} ${num(layout.fontSize)} Tf`,
    `1 0 0 1 ${num(layout.x)} ${num(layout.y)} Tm`,
  ];
  layout.lines.forEach((line, index) => {
    if (index > 0) parts.push(`0 ${num(-layout.leading)} Td`);
    if (line !== '') parts.push(`${font.encode(line).toString()} Tj`);
  });
  parts.push('ET', 'Q');
  return parts.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// PDF page surgery
// ---------------------------------------------------------------------------

const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/**
 * Return a /Resources dictionary that belongs to this page alone.
 *
 * A page can inherit /Resources from a parent node, and several pages can
 * share one dictionary. The function copies the entries into a new dictionary
 * and attaches it to the page. A change to the copy leaves the other pages
 * unchanged.
 */
function ownResources(page: PDFPage): PDFDict {
  const context = page.doc.context;
  let source: PDFDict | undefined;
  let node: PDFDict | undefined = page.node;
  for (let depth = 0; node !== undefined && depth < 64; depth += 1) {
    const found = node.lookupMaybe(PDFName.of('Resources'), PDFDict);
    if (found) {
      source = found;
      break;
    }
    node = node.lookupMaybe(PDFName.of('Parent'), PDFDict);
  }
  const resources = context.obj({}) as PDFDict;
  if (source) {
    for (const [key, value] of source.entries()) resources.set(key, value);
  }
  page.node.set(PDFName.of('Resources'), resources);
  return resources;
}

/** Attach the font to the page and return the free resource name. */
function addFontResource(page: PDFPage, font: PDFRef): string {
  const context = page.doc.context;
  const resources = ownResources(page);
  const fonts = context.obj({}) as PDFDict;
  const existing = resources.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (existing) {
    for (const [key, value] of existing.entries()) fonts.set(key, value);
  }
  let index = 0;
  while (fonts.has(PDFName.of(`ITL${index}`))) index += 1;
  const name = `ITL${index}`;
  fonts.set(PDFName.of(name), font);
  resources.set(PDFName.of('Font'), fonts);
  return name;
}

/** Return the content streams of the page, in order. */
function contentStreams(page: PDFPage): PDFRawStream[] {
  const context = page.doc.context;
  const raw = page.node.get(PDFName.of('Contents'));
  if (raw === undefined) return [];
  const resolved = context.lookup(raw);
  const items = resolved instanceof PDFArray ? resolved.asArray().map((r) => context.lookup(r)) : [resolved];
  return items.filter((item): item is PDFRawStream => item instanceof PDFRawStream);
}

/**
 * Return the count of q operators to add before the original content, and the
 * count of Q operators to add after it.
 *
 * The original content can leave the graphics state stack out of balance. The
 * guard adds enough q operators to keep one private level, and enough Q
 * operators to return to the default state of the page.
 */
function guardDepth(page: PDFPage): [number, number] {
  let lowest = 0;
  let final = 0;
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (const stream of contentStreams(page)) {
      const data = decodePDFRawStream(stream).decode();
      total += data.length;
      if (total > MAX_SCAN_BYTES) throw new Error('the content is too large for the scan');
      chunks.push(data);
    }
    const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length + 1, 0));
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
      joined[offset] = 0x0a;
      offset += 1;
    }
    [lowest, final] = stackBalance(joined);
  } catch {
    // An unreadable stream falls back to one level.
    lowest = 0;
    final = 0;
  }
  const before = Math.max(1, 1 - lowest);
  return [before, before + final];
}

/**
 * Add the data after the content of the page.
 *
 * The function does not change the original streams. It adds one stream with
 * q operators in front, and one stream that starts with Q operators and holds
 * the new data. The graphics state of the original content cannot reach the
 * new data.
 */
function appendContent(page: PDFPage, data: string): void {
  const context = page.doc.context;
  const raw = page.node.get(PDFName.of('Contents'));
  const merged = PDFArray.withContext(context);

  if (raw === undefined) {
    merged.push(context.register(context.stream(data)));
    page.node.set(PDFName.of('Contents'), merged);
    return;
  }

  const [before, after] = guardDepth(page);
  merged.push(context.register(context.stream('q\n'.repeat(before))));
  const resolved = context.lookup(raw);
  if (resolved instanceof PDFArray) {
    for (const ref of resolved.asArray()) merged.push(ref);
  } else if (raw instanceof PDFRef) {
    merged.push(raw);
  } else if (resolved) {
    merged.push(context.register(resolved));
  }
  merged.push(context.register(context.stream('Q\n'.repeat(after) + data)));
  page.node.set(PDFName.of('Contents'), merged);
}

export interface LayerOptions {
  fontMode?: FontMode;
  fontSize?: number;
  margin?: number;
  position?: Position;
}

/** Add the invisible text to one page and return the layout of the lines. */
export function addInvisibleText(
  document: PDFDocument,
  pageIndex: number,
  text: string,
  options: LayerOptions = {},
): Layout {
  const {
    fontMode = 'auto',
    fontSize = MIN_FONT_SIZE,
    margin = 18,
    position = 'bottom',
  } = options;

  const page = document.getPages()[pageIndex];
  const context = document.context;
  const font = selectFont(text, fontMode);
  const rect = page.getCropBox();
  const box: [number, number, number, number] = [
    rect.x,
    rect.y,
    rect.x + rect.width,
    rect.y + rect.height,
  ];
  const layout = planLayout(text, font, box, fontSize, margin, position);

  const name = addFontResource(page, font.build(context));
  appendContent(page, buildContentStream(layout, font, `/${name}`));
  return layout;
}

// ---------------------------------------------------------------------------
// Page selection
// ---------------------------------------------------------------------------

function pageNumber(text: string, pageCount: number): number {
  const value = Number(text.trim());
  if (!Number.isInteger(value)) {
    throw new InvisibleTextLayerError(`"${text.trim()}" is not a page number`);
  }
  if (value === 0) throw new InvisibleTextLayerError('page numbers start at 1');
  return value > 0 ? value - 1 : pageCount + value;
}

/**
 * Return the 0 based page indexes for the specification.
 *
 * The specification is a comma separated list. Each item is "all", "first",
 * "last", a 1 based page number, a negative page number that counts from the
 * end, or a range such as "2-5".
 */
export function parsePages(spec: string, pageCount: number): number[] {
  const selected: number[] = [];
  for (const rawItem of spec.split(',')) {
    const item = rawItem.trim().toLowerCase();
    if (item === '') continue;
    if (item === 'all') {
      for (let i = 0; i < pageCount; i += 1) selected.push(i);
    } else if (item === 'first') {
      selected.push(0);
    } else if (item === 'last') {
      selected.push(pageCount - 1);
    } else if (item.slice(1).includes('-')) {
      const cut = item.indexOf('-', 1);
      const start = pageNumber(item.slice(0, cut), pageCount);
      const end = pageNumber(item.slice(cut + 1), pageCount);
      const step = end >= start ? 1 : -1;
      for (let i = start; i !== end + step; i += step) selected.push(i);
    } else {
      selected.push(pageNumber(item, pageCount));
    }
  }

  const result: number[] = [];
  for (const index of selected) {
    if (index < 0 || index >= pageCount) {
      throw new InvisibleTextLayerError(
        `page ${index + 1} is outside the document, which has ${pageCount} pages`,
      );
    }
    if (!result.includes(index)) result.push(index);
  }
  if (result.length === 0) {
    throw new InvisibleTextLayerError(`the page selection "${spec}" is empty`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/** Parse the bfchar entries of a ToUnicode CMap into a map of code to text. */
function parseToUnicode(cmap: string): Map<number, string> {
  const table = new Map<number, string>();
  const pattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
  for (const section of cmap.split('beginbfchar').slice(1)) {
    const block = section.split('endbfchar')[0];
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(block)) !== null) {
      const units: number[] = [];
      for (let i = 0; i + 3 < match[2].length; i += 4) {
        units.push(parseInt(match[2].slice(i, i + 4), 16));
      }
      table.set(parseInt(match[1], 16), String.fromCharCode(...units));
    }
  }
  return table;
}

/**
 * Read the text back from a finished PDF file.
 *
 * The function reads the last content stream of the page, and maps the codes
 * through the ToUnicode map that the file holds. A text extractor uses the
 * same map, so the result shows what an extractor reads.
 */
export async function readLayerText(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = document.getPages().at(pageIndex)!;
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray)) return '';
  const refs = contents.asArray();
  const last = document.context.lookup(refs[refs.length - 1]);
  if (!(last instanceof PDFRawStream)) return '';
  const stream = new TextDecoder('latin1').decode(decodePDFRawStream(last).decode());

  const fontMatch = /\/(\S+)\s+[\d.]+\s+Tf/.exec(stream);
  if (!fontMatch) return '';
  const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const font = fonts?.lookupMaybe(PDFName.of(fontMatch[1]), PDFDict);
  if (!font) return '';

  let table: Map<number, string> | null = null;
  const toUnicode = font.lookup(PDFName.of('ToUnicode'));
  if (toUnicode instanceof PDFRawStream) {
    table = parseToUnicode(new TextDecoder('latin1').decode(decodePDFRawStream(toUnicode).decode()));
  }

  const lines: string[] = [];
  const pattern = /<([0-9A-Fa-f]*)>\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stream)) !== null) {
    const hex = match[1];
    if (table) {
      let line = '';
      for (let i = 0; i + 3 < hex.length; i += 4) {
        line += table.get(parseInt(hex.slice(i, i + 4), 16)) ?? '';
      }
      lines.push(line);
    } else {
      lines.push(new LatinFont().decode(hex));
    }
  }
  return lines.join('\n');
}

export interface LayerResult {
  bytes: Uint8Array;
  pages: number[];
  font: 'latin' | 'unicode';
  fontSize: number;
  lineCount: number;
  overflow: boolean;
  verified: boolean;
}

/**
 * Add the invisible text to a PDF file and return the new file.
 *
 * The result keeps the page count of the input. The function reads the output
 * back and searches for the text, and reports the result in verified.
 */
export async function addLayer(
  input: Uint8Array,
  text: string,
  options: LayerOptions & { pages?: string; verify?: boolean } = {},
): Promise<LayerResult> {
  if (text === '') throw new InvisibleTextLayerError('the text is empty');
  const { pages = 'last', verify = true, ...layerOptions } = options;

  const document = await PDFDocument.load(input, {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const pageCount = document.getPageCount();
  if (pageCount === 0) throw new InvisibleTextLayerError('the file has no pages');
  const indexes = parsePages(pages, pageCount);

  let layout: Layout | null = null;
  for (const index of indexes) {
    layout = addInvisibleText(document, index, text, layerOptions);
  }
  const bytes = await document.save({ useObjectStreams: false });

  let verified = false;
  if (verify) {
    const wanted = text.replace(/\s+/g, '');
    verified = true;
    for (const index of indexes) {
      const found = (await readLayerText(bytes, index)).replace(/\s+/g, '');
      if (!found.includes(wanted)) verified = false;
    }
  }

  return {
    bytes,
    pages: indexes.map((index) => index + 1),
    font: selectFont(text, layerOptions.fontMode ?? 'auto').kind,
    fontSize: layout!.fontSize,
    lineCount: layout!.lines.length,
    overflow: layout!.overflow,
    verified,
  };
}
