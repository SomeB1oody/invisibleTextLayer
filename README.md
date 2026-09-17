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

## It is online!

View [GitHub Pages](https://someb1oody.github.io/invisibleTextLayer/). All process is local.

## Install

The tool needs Python 3.9 or later and pypdf.

```bash
pip install -r requirements.txt
```

## Use

```bash
# The text goes on the last page. The output is report.invisible.pdf
python3 invisible_text_layer.py report.pdf --text "internal reference 2026-09-02"

# Read the text from a UTF-8 file and name the output
python3 invisible_text_layer.py report.pdf -f note.txt -o tagged.pdf

# Put the text on every page
python3 invisible_text_layer.py report.pdf -t "confidential" --pages all

# Read the text from stdin
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
