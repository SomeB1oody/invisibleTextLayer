/** Builders for the test PDF files. buildSample matches tests/make_sample.py. */

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

/** Assemble numbered objects into a PDF file with a cross reference table. */
export function buildRaw(objects: string[], rootNumber: number): Uint8Array {
  const parts: Uint8Array[] = [bytes('%PDF-1.7\n%âãÏÓ\n')];
  let size = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(size);
    const chunk = bytes(`${index + 1} 0 obj\n${body}\nendobj\n`);
    parts.push(chunk);
    size += chunk.length;
  });
  const xrefAt = size;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, '0')} 00000 n \n`;
  table +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${rootNumber} 0 R >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`;
  parts.push(bytes(table));

  const out = new Uint8Array(size + parts[parts.length - 1].length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A PDF file with visible Helvetica text on every page. */
export function buildSample(pageCount = 3): Uint8Array {
  const objects: string[] = ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const contentNumbers: number[] = [];
  const pageNumbers: number[] = [];
  for (let number = 1; number <= pageCount; number += 1) {
    const stream = `BT /F1 24 Tf 72 700 Td (Visible page ${number} of ${pageCount}) Tj ET\n`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    contentNumbers.push(objects.length);
    objects.push('');
    pageNumbers.push(objects.length);
  }
  objects.push('');
  const pagesNumber = objects.length;
  objects.push('');
  const catalogNumber = objects.length;

  pageNumbers.forEach((pageNumber, index) => {
    objects[pageNumber - 1] =
      `<< /Type /Page /Parent ${pagesNumber} 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 1 0 R >> >> /Contents ${contentNumbers[index]} 0 R >>`;
  });
  objects[pagesNumber - 1] =
    `<< /Type /Pages /Count ${pageCount} /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(' ')}] >>`;
  objects[catalogNumber - 1] = `<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`;
  return buildRaw(objects, catalogNumber);
}

/** A one page PDF whose content leaves two open q levels and a 3x scale. */
export function buildOpenState(): Uint8Array {
  const stream = 'q 3 0 0 3 0 0 cm q 1 0 0 1 10 10 cm BT /F1 8 Tf 10 200 Td (open) Tj ET\n';
  return buildRaw(
    [
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
      '<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 1 0 R >> >> /Contents 2 0 R >>',
      '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
      '<< /Type /Catalog /Pages 4 0 R >>',
    ],
    5,
  );
}

/** A one page PDF whose page inherits /Resources and /MediaBox from the parent. */
export function buildInherited(): Uint8Array {
  const stream = 'BT /F1 12 Tf 20 100 Td (inherited) Tj ET\n';
  return buildRaw(
    [
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
      '<< /Type /Page /Parent 4 0 R /Contents 2 0 R >>',
      '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] ' +
        '/Resources << /Font << /F1 1 0 R >> >> >>',
      '<< /Type /Catalog /Pages 4 0 R >>',
    ],
    5,
  );
}
