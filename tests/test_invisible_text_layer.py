"""Tests for invisible_text_layer. Run with: python3 -m unittest discover tests"""

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pypdf import PdfReader, PdfWriter  # noqa: E402
from pypdf.generic import ArrayObject, NameObject  # noqa: E402

import invisible_text_layer as itl  # noqa: E402
from make_sample import build as build_sample  # noqa: E402

LATIN = "Hidden note: contract 2026-09-02, approved."
CJK = "隐藏文本层：不可见的中文内容 ✅ mixed 123."


def raw_page_content(pdf_path: Path, index: int) -> bytes:
    page = PdfReader(str(pdf_path)).pages[index]
    contents = page.raw_get("/Contents").get_object()
    if isinstance(contents, ArrayObject):
        return b"\n".join(item.get_object().get_data() for item in contents)
    return contents.get_data()


def flat(text: str) -> str:
    return "".join(text.split())


class TempCase(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.sample = self.dir / "sample.pdf"
        build_sample(self.sample, 3)

    def run_tool(self, name: str, text: str, **kwargs) -> itl.Result:
        return itl.process(self.sample, self.dir / name, text, **kwargs)


class TestBasics(TempCase):
    def test_page_count_stays_the_same(self):
        result = self.run_tool("out.pdf", LATIN)
        self.assertEqual(len(PdfReader(str(result.output)).pages), 3)

    def test_last_page_holds_the_text(self):
        result = self.run_tool("out.pdf", LATIN)
        pages = PdfReader(str(result.output)).pages
        self.assertIn(flat(LATIN), flat(pages[2].extract_text()))
        self.assertNotIn(flat(LATIN), flat(pages[0].extract_text()))

    def test_text_comes_after_the_original_text(self):
        result = self.run_tool("out.pdf", LATIN)
        page = PdfReader(str(result.output)).pages[2].extract_text()
        self.assertLess(page.index("Visible page 3"), page.index("Hidden note"))

    def test_other_pages_stay_the_same(self):
        result = self.run_tool("out.pdf", LATIN)
        before = PdfReader(str(self.sample)).pages
        after = PdfReader(str(result.output)).pages
        for index in (0, 1):
            self.assertEqual(before[index].extract_text(), after[index].extract_text())

    def test_original_content_stream_stays_the_same(self):
        result = self.run_tool("out.pdf", LATIN)
        original = raw_page_content(self.sample, 2)
        self.assertIn(original.strip(), raw_page_content(result.output, 2))

    def test_render_mode_three(self):
        result = self.run_tool("out.pdf", LATIN, compress=False)
        self.assertIn(b"3 Tr", raw_page_content(result.output, 2))

    def test_unicode_text(self):
        result = self.run_tool("out.pdf", CJK)
        self.assertEqual(result.font, "unicode")
        self.assertIn(flat(CJK), flat(PdfReader(str(result.output)).pages[2].extract_text()))

    def test_latin_font_for_ascii(self):
        self.assertEqual(self.run_tool("out.pdf", LATIN).font, "latin")

    def test_latin_mode_rejects_other_characters(self):
        with self.assertRaises(itl.InvisibleTextLayerError):
            self.run_tool("out.pdf", CJK, font_mode="latin")

    def test_unicode_mode_accepts_ascii(self):
        result = self.run_tool("out.pdf", LATIN, font_mode="unicode")
        self.assertIn(flat(LATIN), flat(PdfReader(str(result.output)).pages[2].extract_text()))

    def test_empty_text_fails(self):
        with self.assertRaises(itl.InvisibleTextLayerError):
            self.run_tool("out.pdf", "")

    def test_verification_reports_success(self):
        self.assertIs(self.run_tool("out.pdf", CJK).verified, True)


class TestPageSelection(TempCase):
    def test_all_pages(self):
        result = self.run_tool("out.pdf", LATIN, pages="all")
        self.assertEqual(result.pages, [1, 2, 3])
        for page in PdfReader(str(result.output)).pages:
            self.assertIn(flat(LATIN), flat(page.extract_text()))

    def test_range_and_list(self):
        self.assertEqual(itl.parse_pages("1,3", 3), [0, 2])
        self.assertEqual(itl.parse_pages("2-4", 5), [1, 2, 3])
        self.assertEqual(itl.parse_pages("4-2", 5), [3, 2, 1])
        self.assertEqual(itl.parse_pages("-1", 5), [4])
        self.assertEqual(itl.parse_pages("first,last", 5), [0, 4])
        self.assertEqual(itl.parse_pages("1,1,1", 5), [0])

    def test_bad_selection(self):
        for spec in ("9", "0", "abc", ""):
            with self.assertRaises(itl.InvisibleTextLayerError):
                itl.parse_pages(spec, 3)


class TestLayout(unittest.TestCase):
    def test_wrap_keeps_lines_inside_the_width(self):
        font = itl.LatinFont()
        lines = itl.wrap_text("alpha beta gamma delta epsilon", 10.0, font.width_em)
        for line in lines:
            self.assertLessEqual(sum(font.width_em(c) for c in line), 10.0)
        self.assertEqual("alpha beta gamma delta epsilon", " ".join(lines))

    def test_hard_line_breaks(self):
        lines = itl.wrap_text("a\n\nb", 100.0, itl.LatinFont().width_em)
        self.assertEqual(lines, ["a", "", "b"])

    def test_text_without_spaces_breaks_between_characters(self):
        lines = itl.wrap_text("x" * 20, 5.0, lambda c: 1.0)
        self.assertTrue(all(len(line) <= 5 for line in lines))
        self.assertEqual("".join(lines), "x" * 20)

    def test_long_text_reduces_the_font_size(self):
        layout = itl.plan_layout(
            "word " * 4000, itl.LatinFont(), (0, 0, 612, 792), 8.0, 18.0, "bottom"
        )
        self.assertLess(layout.font_size, 8.0)
        self.assertFalse(layout.overflow)

    def test_block_stays_inside_the_page(self):
        layout = itl.plan_layout(
            "word " * 500, itl.LatinFont(), (0, 0, 612, 792), 8.0, 18.0, "bottom"
        )
        top = layout.y + layout.font_size
        bottom = layout.y - (len(layout.lines) - 1) * layout.leading
        self.assertLessEqual(top, 792 - 18 + 1)
        self.assertGreaterEqual(bottom, 18 - 1)

    def test_margin_too_large(self):
        with self.assertRaises(itl.InvisibleTextLayerError):
            itl.plan_layout("x", itl.LatinFont(), (0, 0, 100, 100), 8.0, 60.0, "bottom")


class TestStackBalance(unittest.TestCase):
    def test_balanced(self):
        self.assertEqual(itl.content_stack_balance(b"q 1 0 0 1 0 0 cm Q"), (0, 0))

    def test_open_levels(self):
        self.assertEqual(itl.content_stack_balance(b"q q q"), (0, 3))

    def test_extra_close(self):
        self.assertEqual(itl.content_stack_balance(b"Q Q q"), (-2, -1))

    def test_ignores_strings_names_and_comments(self):
        self.assertEqual(itl.content_stack_balance(b"BT (q q Q) Tj ET"), (0, 0))
        self.assertEqual(itl.content_stack_balance(b"/Q gs"), (0, 0))
        self.assertEqual(itl.content_stack_balance(b"% q q q\n"), (0, 0))
        self.assertEqual(itl.content_stack_balance(b"<0071> Tj"), (0, 0))

    def test_ignores_inline_image_data(self):
        data = b"BI /W 2 /H 2 /BPC 8 /CS /G ID qQqQ\nEI Q"
        self.assertEqual(itl.content_stack_balance(data), (-1, -1))


class TestDifficultPages(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)

    def _write(self, objects: list[bytes], root: int, name: str) -> Path:
        out = bytearray(b"%PDF-1.7\n")
        offsets = []
        for number, body in enumerate(objects, start=1):
            offsets.append(len(out))
            out += str(number).encode() + b" 0 obj\n" + body + b"\nendobj\n"
        start = len(out)
        out += b"xref\n0 " + str(len(objects) + 1).encode() + b"\n0000000000 65535 f \n"
        for offset in offsets:
            out += f"{offset:010d} 00000 n \n".encode()
        out += (
            b"trailer\n<< /Size " + str(len(objects) + 1).encode()
            + b" /Root " + str(root).encode() + b" 0 R >>\nstartxref\n"
            + str(start).encode() + b"\n%%EOF\n"
        )
        path = self.dir / name
        path.write_bytes(bytes(out))
        return path

    def test_page_without_contents(self):
        writer = PdfWriter()
        writer.add_blank_page(width=200, height=200)
        source = self.dir / "blank.pdf"
        with source.open("wb") as handle:
            writer.write(handle)
        result = itl.process(source, self.dir / "out.pdf", LATIN, margin=5.0)
        self.assertIn(flat(LATIN), flat(PdfReader(str(result.output)).pages[0].extract_text()))

    def test_inherited_resources(self):
        stream = b"BT /F1 12 Tf 20 100 Td (inherited) Tj ET\n"
        source = self._write(
            [
                b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
                b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream",
                b"<< /Type /Page /Parent 4 0 R /Contents 2 0 R >>",
                b"<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] "
                b"/Resources << /Font << /F1 1 0 R >> >> >>",
                b"<< /Type /Catalog /Pages 4 0 R >>",
            ],
            root=5,
            name="inherited.pdf",
        )
        result = itl.process(source, self.dir / "out.pdf", LATIN)
        page = PdfReader(str(result.output)).pages[0]
        self.assertIn("inherited", page.extract_text())
        self.assertIn(flat(LATIN), flat(page.extract_text()))
        fonts = page["/Resources"]["/Font"]
        self.assertIn("/F1", fonts)
        self.assertIn("/ITL0", fonts)

    def test_open_graphics_state_does_not_move_the_text(self):
        stream = b"q 3 0 0 3 0 0 cm q 1 0 0 1 10 10 cm BT /F1 8 Tf 10 200 Td (open) Tj ET\n"
        source = self._write(
            [
                b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
                b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream",
                b"<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] "
                b"/Resources << /Font << /F1 1 0 R >> >> /Contents 2 0 R >>",
                b"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
                b"<< /Type /Catalog /Pages 4 0 R >>",
            ],
            root=5,
            name="open_state.pdf",
        )
        result = itl.process(source, self.dir / "out.pdf", "GUARDED", margin=18.0)
        seen: list[tuple] = []

        def visit(text, cm, tm, font, size):
            if "GUARDED" in text:
                seen.append((cm[0], cm[3], tm[4], tm[5]))

        PdfReader(str(result.output)).pages[0].extract_text(visitor_text=visit)
        self.assertTrue(seen)
        scale_x, scale_y, x, y = seen[0]
        self.assertAlmostEqual(scale_x, 1.0, places=6)
        self.assertAlmostEqual(scale_y, 1.0, places=6)
        self.assertAlmostEqual(x, 18.0, places=3)
        self.assertLess(y, 40.0)

    def test_encrypted_input(self):
        writer = PdfWriter(clone_from=str(self._sample()))
        writer.encrypt("secret")
        source = self.dir / "locked.pdf"
        with source.open("wb") as handle:
            writer.write(handle)
        with self.assertRaises(itl.InvisibleTextLayerError):
            itl.process(source, self.dir / "a.pdf", LATIN)
        result = itl.process(source, self.dir / "b.pdf", LATIN, password="secret")
        self.assertIs(result.verified, True)

    def _sample(self) -> Path:
        path = self.dir / "sample.pdf"
        build_sample(path, 2)
        return path


class TestCommandLine(TempCase):
    def test_writes_the_default_output_name(self):
        code = itl.main([str(self.sample), "-t", LATIN])
        self.assertEqual(code, 0)
        self.assertTrue((self.dir / "sample.invisible.pdf").is_file())

    def test_missing_input(self):
        self.assertEqual(itl.main([str(self.dir / "none.pdf"), "-t", "x"]), 2)

    def test_output_must_differ_from_input(self):
        self.assertEqual(itl.main([str(self.sample), "-o", str(self.sample), "-t", "x"]), 2)

    def test_refuses_to_overwrite(self):
        target = self.dir / "out.pdf"
        target.write_bytes(b"placeholder")
        self.assertEqual(itl.main([str(self.sample), "-o", str(target), "-t", "x"]), 2)
        self.assertEqual(itl.main([str(self.sample), "-o", str(target), "-t", "x", "--force"]), 0)

    def test_text_file(self):
        source = self.dir / "text.txt"
        source.write_text(CJK, encoding="utf-8")
        target = self.dir / "out.pdf"
        self.assertEqual(itl.main([str(self.sample), "-o", str(target), "-f", str(source)]), 0)
        self.assertIn(flat(CJK), flat(PdfReader(str(target)).pages[2].extract_text()))


if __name__ == "__main__":
    unittest.main()
