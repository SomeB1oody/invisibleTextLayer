import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import {
  InvisibleTextLayerError,
  LatinFont,
  MIN_FONT_SIZE,
  addLayer,
  num,
  parsePages,
  planLayout,
  readLayerText,
  stackBalance,
  wrapText,
} from '../src/core.ts';
import { buildInherited, buildOpenState, buildSample } from './fixtures.ts';

const LATIN = 'Hidden note: contract 2026-09-02, approved.';
const CJK = '隐藏文本层：不可见的中文内容 ✅ mixed 123.';
const flat = (text: string) => text.replace(/\s+/g, '');
const raw = (text: string) => new TextEncoder().encode(text);

/** Return the text of the last content stream of a page. */
async function lastStream(bytes: Uint8Array, pageIndex = -1): Promise<string> {
  const document = await PDFDocument.load(bytes);
  const page = document.getPages().at(pageIndex)!;
  const contents = page.node.Contents() as PDFArray;
  const refs = contents.asArray();
  const stream = document.context.lookup(refs[refs.length - 1]) as PDFRawStream;
  return new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode());
}

test('num formats a PDF number', () => {
  assert.equal(num(0.5), '0.5');
  assert.equal(num(18), '18');
  assert.equal(num(-0.6), '-0.6');
  assert.equal(num(0), '0');
});

test('stackBalance counts a balanced stream', () => {
  assert.deepEqual(stackBalance(raw('q 1 0 0 1 0 0 cm Q')), [0, 0]);
});

test('stackBalance counts open levels', () => {
  assert.deepEqual(stackBalance(raw('q q q')), [0, 3]);
});

test('stackBalance counts an extra close', () => {
  assert.deepEqual(stackBalance(raw('Q Q q')), [-2, -1]);
});

test('stackBalance ignores strings, names and comments', () => {
  assert.deepEqual(stackBalance(raw('BT (q q Q) Tj ET')), [0, 0]);
  assert.deepEqual(stackBalance(raw('/Q gs')), [0, 0]);
  assert.deepEqual(stackBalance(raw('% q q q\n')), [0, 0]);
  assert.deepEqual(stackBalance(raw('<0071> Tj')), [0, 0]);
});

test('stackBalance ignores inline image data', () => {
  assert.deepEqual(stackBalance(raw('BI /W 2 /H 2 /BPC 8 /CS /G ID qQqQ\nEI Q')), [-1, -1]);
});

test('wrapText keeps the lines inside the width', () => {
  const font = new LatinFont();
  const lines = wrapText('alpha beta gamma delta epsilon', 10, (c) => font.widthEm(c));
  for (const line of lines) {
    const width = [...line].reduce((sum, c) => sum + font.widthEm(c), 0);
    assert.ok(width <= 10, `line "${line}" is too wide`);
  }
  assert.equal(lines.join(' '), 'alpha beta gamma delta epsilon');
});

test('wrapText keeps the hard line breaks', () => {
  assert.deepEqual(wrapText('a\n\nb', 100, () => 1), ['a', '', 'b']);
});

test('wrapText breaks text without spaces between characters', () => {
  const lines = wrapText('x'.repeat(20), 5, () => 1);
  assert.ok(lines.every((line) => line.length <= 5));
  assert.equal(lines.join(''), 'x'.repeat(20));
});

test('planLayout reduces the font size for a long text', () => {
  const layout = planLayout('word '.repeat(4000), new LatinFont(), [0, 0, 612, 792], 8, 18);
  assert.ok(layout.fontSize < 8);
  assert.equal(layout.overflow, false);
});

test('planLayout keeps the block inside the page', () => {
  const layout = planLayout('word '.repeat(500), new LatinFont(), [0, 0, 612, 792], 8, 18);
  const top = layout.y + layout.fontSize;
  const bottom = layout.y - (layout.lines.length - 1) * layout.leading;
  assert.ok(top <= 792 - 18 + 1);
  assert.ok(bottom >= 18 - 1);
});

test('planLayout needs no shrink at the minimum size', () => {
  const layout = planLayout('word '.repeat(200), new LatinFont(), [0, 0, 612, 792], MIN_FONT_SIZE, 18);
  assert.equal(layout.fontSize, MIN_FONT_SIZE);
  assert.equal(layout.overflow, false);
});

test('planLayout rejects a size below the minimum', () => {
  assert.throws(
    () => planLayout('x', new LatinFont(), [0, 0, 612, 792], 0.4, 18),
    InvisibleTextLayerError,
  );
});

test('planLayout rejects a margin that is too large', () => {
  assert.throws(
    () => planLayout('x', new LatinFont(), [0, 0, 100, 100], 8, 60),
    InvisibleTextLayerError,
  );
});

test('parsePages reads every form', () => {
  assert.deepEqual(parsePages('1,3', 3), [0, 2]);
  assert.deepEqual(parsePages('2-4', 5), [1, 2, 3]);
  assert.deepEqual(parsePages('4-2', 5), [3, 2, 1]);
  assert.deepEqual(parsePages('-1', 5), [4]);
  assert.deepEqual(parsePages('first,last', 5), [0, 4]);
  assert.deepEqual(parsePages('1,1,1', 5), [0]);
  assert.deepEqual(parsePages('all', 3), [0, 1, 2]);
});

test('parsePages rejects a bad selection', () => {
  for (const spec of ['9', '0', 'abc', '']) {
    assert.throws(() => parsePages(spec, 3), InvisibleTextLayerError, `spec ${spec}`);
  }
});

test('addLayer keeps the page count', async () => {
  const result = await addLayer(buildSample(3), LATIN);
  const document = await PDFDocument.load(result.bytes);
  assert.equal(document.getPageCount(), 3);
});

test('addLayer writes the text on the last page', async () => {
  const result = await addLayer(buildSample(3), LATIN);
  assert.equal(result.verified, true);
  assert.equal(flat(await readLayerText(result.bytes, 2)), flat(LATIN));
  assert.equal(await readLayerText(result.bytes, 0), '');
});

test('addLayer uses the minimum font size by default', async () => {
  const result = await addLayer(buildSample(2), LATIN);
  assert.equal(result.fontSize, MIN_FONT_SIZE);
  assert.equal(result.font, 'latin');
});

test('addLayer writes unicode text', async () => {
  const result = await addLayer(buildSample(2), CJK);
  assert.equal(result.font, 'unicode');
  assert.equal(result.verified, true);
  assert.equal(flat(await readLayerText(result.bytes, 1)), flat(CJK));
});

test('addLayer writes text with hard line breaks in order', async () => {
  const text = Array.from({ length: 40 }, (_, i) => `LINE${String(i + 1).padStart(3, '0')} 第${i + 1}行`).join('\n');
  const result = await addLayer(buildSample(2), text);
  const found = await readLayerText(result.bytes, 1);
  const numbers = [...found.matchAll(/LINE(\d{3})/g)].map((m) => Number(m[1]));
  assert.deepEqual(numbers, Array.from({ length: 40 }, (_, i) => i + 1));
});

test('addLayer uses text rendering mode 3', async () => {
  const result = await addLayer(buildSample(2), LATIN);
  assert.match(await lastStream(result.bytes), /\n3 Tr\n/);
});

test('addLayer keeps the original content stream', async () => {
  const result = await addLayer(buildSample(3), LATIN);
  const document = await PDFDocument.load(result.bytes);
  const page = document.getPages()[2];
  const refs = (page.node.Contents() as PDFArray).asArray();
  const original = new TextDecoder('latin1').decode(
    decodePDFRawStream(document.context.lookup(refs[1]) as PDFRawStream).decode(),
  );
  assert.match(original, /Visible page 3 of 3/);
});

test('addLayer leaves the other pages alone', async () => {
  const result = await addLayer(buildSample(3), LATIN);
  const document = await PDFDocument.load(result.bytes);
  for (const index of [0, 1]) {
    const contents = document.getPages()[index].node.Contents();
    assert.ok(!(contents instanceof PDFArray) || contents.size() === 1);
  }
});

test('addLayer writes every page for the all selection', async () => {
  const result = await addLayer(buildSample(3), LATIN, { pages: 'all' });
  assert.deepEqual(result.pages, [1, 2, 3]);
  for (const index of [0, 1, 2]) {
    assert.equal(flat(await readLayerText(result.bytes, index)), flat(LATIN));
  }
});

test('addLayer guards an open graphics state', async () => {
  const result = await addLayer(buildOpenState(), 'GUARDED');
  // The page leaves two open levels, so the guard adds one q and three Q.
  assert.match(await lastStream(result.bytes), /^Q\nQ\nQ\nq\nBT\n/);
  assert.equal(result.verified, true);
});

test('addLayer works on a page with inherited resources', async () => {
  const result = await addLayer(buildInherited(), LATIN);
  assert.equal(result.verified, true);
  const document = await PDFDocument.load(result.bytes);
  const fonts = document.getPages()[0].node.Resources()!.lookup(PDFName.of('Font')) as PDFDict;
  assert.ok(fonts.has(PDFName.of('F1')));
  assert.ok(fonts.has(PDFName.of('ITL0')));
});

test('addLayer rejects an empty text', async () => {
  await assert.rejects(() => addLayer(buildSample(1), ''), InvisibleTextLayerError);
});

test('addLayer shrinks a long text to fit', async () => {
  const result = await addLayer(buildSample(1), 'word '.repeat(4000), { fontSize: 8 });
  assert.ok(result.fontSize < 8);
  assert.equal(result.overflow, false);
  assert.equal(result.verified, true);
});
