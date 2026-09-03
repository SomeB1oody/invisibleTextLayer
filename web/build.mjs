/**
 * Bundle the page into one file.
 *
 * dist/index.html is a complete document for a web server or a local file.
 * dist/artifact.html holds the same page without the document wrapper.
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const result = await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  write: false,
});

const script = result.outputFiles[0].text;
const template = readFileSync('index.html', 'utf8');
const body = template.replace('<!--SCRIPT-->', `<script>\n${script}\n</script>`);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/artifact.html', body);
writeFileSync(
  'dist/index.html',
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<style>*{box-sizing:border-box}body{margin:0}</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`,
);

const size = Buffer.byteLength(body) / 1024;
console.log(`dist/index.html and dist/artifact.html written (${size.toFixed(0)} KB)`);
