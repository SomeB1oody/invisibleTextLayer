# invisible_text_layer

Add an invisible text layer to a PDF file. The output file has the same page
count as the input file.

## What the tool does

The tool writes the text into the content stream of a page that already
exists. The text uses PDF text rendering mode 3. A viewer draws nothing for
this mode. A text extractor, a copy operation, a search index and an
accessibility reader still read the characters.

The tool appends the layer after the original content of the page. The text
therefore comes last in the extracted text of that page. The default target is
the last page, so the text lands at the end of the document.

The tool does not touch the original content streams. It adds new objects and
puts them after the existing ones.

## Two tools, one behavior

| | Where it runs | Best for |
| :--- | :--- | :--- |
| `invisible_text_layer.py` | The command line, with Python. | Batch work and scripts. |
| `web/` | The browser, with no install. | Sharing a link. |

Both write the same content stream. `web/tools/crosscheck.mjs` runs the two on
the same input and compares the bytes. The rest of this file covers the command
line tool. `web/README.md` covers the page.

## Install

The tool needs Python 3.9 or later and pypdf.

```bash
pip install -r requirements.txt
```

## Use

```bash
# The text goes on the last page. The output is report.invisible.pdf.
python3 invisible_text_layer.py report.pdf --text "internal reference 2026-09-02"

# Read the text from a UTF-8 file and name the output.
python3 invisible_text_layer.py report.pdf -f note.txt -o tagged.pdf

# Put the text on every page.
python3 invisible_text_layer.py report.pdf -t "confidential" --pages all

# Read the text from stdin.
echo "hidden note" | python3 invisible_text_layer.py report.pdf -o out.pdf
```

The tool prints the target pages, the font, the font size and the line count.
After the write, the tool reads the output file back and searches for the
text. The exit code is 0 after a successful check.

## Options

| Option | Default | Description |
| :--- | :--- | :--- |
| `-o`, `--output` | `INPUT.invisible.pdf` | The output file. |
| `-t`, `--text` | | The text of the layer. |
| `-f`, `--text-file` | | A UTF-8 file with the text. `-` reads stdin. |
| `-p`, `--pages` | `last` | The target pages. See below. |
| `--font` | `auto` | `auto`, `latin` or `unicode`. |
| `--font-size` | `0.5` | The start font size in points. 0.5 is also the minimum. |
| `--margin` | `18` | The page margin in points. |
| `--position` | `bottom` | The anchor of the text block: `bottom` or `top`. |
| `--password` | | The password of an encrypted input file. |
| `--no-compress` | off | Write the new content stream without compression. |
| `--no-verify` | off | Skip the extraction check. |
| `--force` | off | Overwrite the output file. |

The `--pages` value is a comma separated list. An item is `all`, `first`,
`last`, a 1 based page number such as `3`, a negative number that counts from
the end such as `-1`, or a range such as `2-5`.

## Fonts

The `auto` mode selects the font from the text.

- `latin` uses Helvetica with WinAnsiEncoding. Every viewer has this font. The
  font covers the code page 1252 character set only.
- `unicode` uses a composite font with Identity-H encoding and a ToUnicode
  map. This font covers the full Unicode range, which includes Chinese,
  Japanese, Korean and emoji. The font descriptor holds no font program,
  because rendering mode 3 needs no glyph.

## Layout

The layer uses the smallest font size by default, which is 0.5 points. The
size does not change the look of the page, because the layer is invisible at
every size. A small size holds more text on one page and gives a small
selection area. A page of 612 x 792 points holds more than one million Latin
characters at this size. The tool rejects a smaller size, because an unknown
extractor can drop text below this limit.

The tool breaks the text into lines that fit the page. A `\n` in the text
starts a new line. If the lines do not fit, the tool reduces the font size
down to the 0.5 point limit. If the lines still do not fit, the tool reduces
the line spacing and prints a warning. The lines then overlap. A text
extractor still reads the lines in order.

## Python API

```python
from pathlib import Path
from invisible_text_layer import process

result = process(
    Path("report.pdf"),
    Path("tagged.pdf"),
    "internal reference 2026-09-02",
    pages="last",
)
print(result.pages, result.font, result.verified)
```

## Limits

- The tool removes the encryption of an encrypted input file. The output file
  has no password.
- A digital signature on the input file becomes invalid, because the tool
  rewrites the file.
- The tool does not hide the text from a text extractor. Anybody who opens the
  file with an extractor, or who selects the page area and copies it, reads the
  text.

## Tests

```bash
python3 -m unittest discover -s tests -v
```

The tests cover the page count, the extraction result, the page selection, the
line layout, pages without a content stream, pages with inherited resources,
pages with an open graphics state, and encrypted input files.
