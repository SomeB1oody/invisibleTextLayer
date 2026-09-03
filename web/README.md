# You Can't See Me

A web page that adds an invisible text layer to a PDF file. The page does the
work in the browser. The file does not leave the device.

This is a port of the Python tool in the parent directory. Both write the same
content stream. `tools/crosscheck.mjs` compares them.

## Use the page

Open `dist/index.html` in a browser, or put the file on any static web server.
The file is self contained. It needs no server code and no build step at run
time. The page loads IBM Plex from Google Fonts and falls back to a system font
without a network.

1. Drop a PDF file on the drop area.
2. Type the text of the layer.
3. Click **Add the layer**.

The page writes the layer on the last page and offers the result as
`<name>.invisible.pdf`.

## Build

```bash
npm install
npm run build      # writes dist/index.html and dist/artifact.html
npm test           # 29 tests, no browser needed
npm run typecheck
node tools/crosscheck.mjs   # compares the output with the Python tool
```

`dist/index.html` is a complete document for a web server or a local file.
`dist/artifact.html` holds the same page without the document wrapper, for a
host that supplies one.

## Deploy to GitHub Pages

`.github/workflows/pages.yml` builds the page and deploys it. The workflow runs
on a push to `main` and on a manual start. It runs the type check and the tests
first, so a broken build never reaches the site.

The repository needs one setting before the first run:

1. Open **Settings** then **Pages** in the repository.
2. Set **Source** to **GitHub Actions**.

The site then serves `dist/index.html` at the root of the Pages URL. The
workflow builds from `src/`, so the site always matches the source.

## How the layer works

The layer uses PDF text rendering mode 3. A viewer draws nothing for this mode.
A text extractor, a copy operation and a search index read the characters.

- The page appends a content stream to a page that already exists, so the page
  count does not change. The original streams stay as they are.
- Text in WinAnsiEncoding uses Helvetica. Other text uses a composite font with
  Identity-H encoding and a ToUnicode map. Mode 3 needs no glyph, so the file
  carries no font program. Chinese, Japanese, Korean and emoji add no bytes for
  a font.
- The page counts the q and Q operators of the original content and adds a
  matching guard, so an open graphics state cannot move the new text.
- The default size is 0.5 points, which is the smallest size the tool accepts.
- After the write, the page reads the file back through the ToUnicode map that
  the file holds, and reports the result.

## Files

| Path | Content |
| :--- | :--- |
| `src/core.ts` | The PDF work. No DOM. |
| `src/main.ts` | The page: drop area, text box, save. |
| `index.html` | The markup and the styles. |
| `build.mjs` | The bundle step. |
| `test/` | The tests and the test PDF files. |
| `tools/crosscheck.mjs` | The comparison with the Python tool. |

## Limits

- A page that the browser cannot open as a PDF gives an error message.
- The tool removes the encryption of an encrypted input file.
- A digital signature on the input file becomes invalid.
- The layer is not a secret. Anybody who opens the file with a text extractor,
  or who selects the page and copies it, reads the text.
