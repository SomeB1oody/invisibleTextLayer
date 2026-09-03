/**
 * Compare the output of the TypeScript port with the output of the Python
 * tool. Both run on the same input file and the same text. The script reports
 * a difference in the content stream that the tools append.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import { addLayer } from '../src/core.ts';
import { buildSample } from '../test/fixtures.ts';

const CASES = [
  ['ascii', 'Hidden note: contract 2026-09-02, approved by finance.'],
  ['cjk', '隐藏文本层：这是不可见的中文内容 ✅ mixed ASCII 123.'],
  ['emoji', 'tag 🔒🎯 unicode plane 1'],
  ['multiline', 'first line\nsecond line\n\nfourth line'],
  ['long', '这是一段很长的隐藏文本，用于测试自动换行。'.repeat(40)],
  ['latin1', 'café naïve — “quoted” … 90% ©2026'],
];

async function tailStream(bytes) {
  const document = await PDFDocument.load(bytes);
  const page = document.getPages().at(-1);
  const refs = page.node.Contents().asArray();
  const stream = document.context.lookup(refs[refs.length - 1]);
  return new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode());
}

const dir = mkdtempSync(join(tmpdir(), 'crosscheck-'));
const input = join(dir, 'sample.pdf');
writeFileSync(input, buildSample(3));

let failures = 0;
for (const [name, text] of CASES) {
  const jsResult = await addLayer(readFileSync(input), text);
  const jsStream = await tailStream(jsResult.bytes);

  const pyOut = join(dir, `${name}.py.pdf`);
  execFileSync(
    'python3',
    ['../invisible_text_layer.py', input, '-o', pyOut, '-t', text, '--force', '--no-compress'],
    { stdio: 'pipe' },
  );
  const pyStream = await tailStream(readFileSync(pyOut));

  const same = jsStream === pyStream;
  if (!same) failures += 1;
  const label = same ? 'same' : 'DIFFERENT';
  console.log(`${name.padEnd(10)} ${label.padEnd(10)} verified=${jsResult.verified} font=${jsResult.font} lines=${jsResult.lineCount}`);
  if (!same) {
    console.log('  js:', JSON.stringify(jsStream.slice(0, 200)));
    console.log('  py:', JSON.stringify(pyStream.slice(0, 200)));
  }
  writeFileSync(join(dir, `${name}.js.pdf`), jsResult.bytes);
}

console.log(`\ndirectory: ${dir}`);
process.exit(failures === 0 ? 0 : 1);
