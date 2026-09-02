#!/usr/bin/env python3
"""Build a small PDF for the tests. The pages hold visible Helvetica text."""

import sys
from pathlib import Path


def build(path: Path, page_count: int = 3) -> None:
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    page_ids: list[int] = []
    content_ids: list[int] = []
    for number in range(1, page_count + 1):
        text = f"Visible page {number} of {page_count}".encode("ascii")
        stream = b"BT /F1 24 Tf 72 700 Td (" + text + b") Tj ET\n"
        content_ids.append(
            add(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream")
        )
        page_ids.append(add(b""))  # placeholder, filled below

    pages_id = add(b"")
    catalog_id = add(b"")

    for index, page_id in enumerate(page_ids):
        objects[page_id - 1] = (
            b"<< /Type /Page /Parent " + str(pages_id).encode() + b" 0 R "
            b"/MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 " + str(font).encode() + b" 0 R >> >> "
            b"/Contents " + str(content_ids[index]).encode() + b" 0 R >>"
        )
    kids = b" ".join(str(pid).encode() + b" 0 R" for pid in page_ids)
    objects[pages_id - 1] = (
        b"<< /Type /Pages /Count " + str(page_count).encode() + b" /Kids [" + kids + b"] >>"
    )
    objects[catalog_id - 1] = b"<< /Type /Catalog /Pages " + str(pages_id).encode() + b" 0 R >>"

    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += str(number).encode() + b" 0 obj\n" + body + b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 " + str(len(objects) + 1).encode() + b"\n"
    out += b"0000000000 65535 f \n"
    for offset in offsets[1:]:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        b"trailer\n<< /Size " + str(len(objects) + 1).encode()
        + b" /Root " + str(catalog_id).encode() + b" 0 R >>\nstartxref\n"
        + str(xref_at).encode() + b"\n%%EOF\n"
    )
    path.write_bytes(bytes(out))


if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "sample.pdf")
    build(target, int(sys.argv[2]) if len(sys.argv) > 2 else 3)
    print(f"wrote {target}")
