import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

/**
 * Builders for the résumé fixtures next to this file (docs/spec/21 section 7, P0 row "PDF and DOCX fixtures"). The
 * files are written once by `tsx packages/agents/src/fixtures/build.ts` and checked in; the tests read the files and
 * also run the builders, so both the fixtures and the way they were made are proven. No library is involved: the PDF is
 * hand-written PDF 1.4 with a correct cross-reference table, and the Word document is the smallest OOXML package that
 * Word and mammoth both open (three parts in a zip written with node:zlib). Everything in them is synthetic.
 */

/** A synthetic résumé, eight lines, well over forty words, no real person. */
export const RESUME_LINES = [
  "Jordan Rivera, RDH",
  "jordan.rivera@example.com | (555) 010-0199 | Irvine, CA",
  "Registered Dental Hygienist at Harbor Point Dental 2019 - present",
  "Dental Hygienist at Coastal Family Dentistry 2015 - 2019",
  "RDH license CA #RDH00000 active",
  "BLS/CPR certification current",
  "Skills: Dentrix, periodontal charting, scaling and root planing, digital radiography, patient education",
  "Summary: Six years of preventive care and periodontal therapy in busy family practices, with a calm chairside manner and a habit of explaining every step to nervous patients.",
];

const ascii = (s: string) => Buffer.from(s, "latin1");

/** Escapes a string for a PDF literal string: backslashes and parentheses. Text stays ASCII (the standard Helvetica encoding). */
function pdfString(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "?").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Assembles numbered objects into a PDF 1.4 file with a cross-reference table whose offsets are computed, not guessed. */
function assemblePdf(objects: string[]): Uint8Array {
  const parts: Buffer[] = [ascii("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  const offsets: number[] = [];
  let length = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = ascii(`${i + 1} 0 obj\n${body}\nendobj\n`);
    parts.push(chunk);
    length += chunk.length;
  });
  const xrefAt = length;
  const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n", ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(ascii(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

/** A one-page PDF whose text layer is the given lines, set in Helvetica, one line per text operator. */
export function buildResumePdf(lines: string[] = RESUME_LINES): Uint8Array {
  const content = ["BT", "/F1 11 Tf", "14 TL", "72 720 Td", ...lines.map((l, i) => `${i ? "T* " : ""}(${pdfString(l)}) Tj`), "ET"].join("\n");
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${ascii(content).length} >>\nstream\n${content}\nendstream`,
  ]);
}

/** A "scanned" one-page PDF: a page that is only an image, with no text layer at all (what a phone scan of a paper résumé produces). */
export function buildScannedPdf(): Uint8Array {
  const pixels = Buffer.from([0xf0, 0xf0, 0xf0, 0xf0]);
  const image = `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels.toString("latin1")}\nendstream`;
  const content = "q\n468 0 0 648 72 72 cm\n/Im1 Do\nQ";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
    image,
    `<< /Length ${ascii(content).length} >>\nstream\n${content}\nendstream`,
  ]);
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Writes a zip archive (deflated entries, a central directory and the end record) the way any archiver would. */
function zip(entries: Array<{ name: string; data: Buffer }>): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const deflated = deflateRawSync(e.data, { level: 6 });
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attributes
    cd.writeUInt32LE(0, 38); // external attributes
    cd.writeUInt32LE(offset, 42);
    locals.push(local, name, deflated);
    central.push(cd, name);
    offset += local.length + name.length + deflated.length;
  }
  const cdBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return new Uint8Array(Buffer.concat([...locals, cdBytes, end]));
}

/** A Word document (.docx) with one paragraph per line: the content types, the package relationships and the body, nothing else. */
export function buildResumeDocx(lines: string[] = RESUME_LINES): Uint8Array {
  const body = lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${xml(l)}</w:t></w:r></w:p>`).join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return zip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "word/document.xml", data: Buffer.from(document, "utf8") },
  ]);
}

/** Writes the three fixture files next to this script. */
export function writeFixtures(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const files: Array<[string, Uint8Array]> = [["resume.pdf", buildResumePdf()], ["resume.docx", buildResumeDocx()], ["scanned.pdf", buildScannedPdf()]];
  for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes);
  return files.map(([name]) => name);
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
})();
if (invokedDirectly) {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const name of writeFixtures(dir)) console.log(`wrote ${join(dir, name)}`);
}
