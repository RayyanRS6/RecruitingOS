import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectResumeFile } from "@ros/contracts";
import { documentToText } from "./documents";
import { RESUME_LINES, buildResumeDocx, buildResumePdf, buildScannedPdf } from "./fixtures/build";

/**
 * Résumé text extraction on real file formats: the checked-in
 * PDF and Word fixtures yield their text, a scanned PDF with no text layer yields nothing, and a broken file yields
 * nothing without throwing, so the application always continues (the workflow records `resume.extraction_failed`).
 */
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

describe("documentToText", () => {
  it("the PDF fixture is a valid résumé file and its text layer comes out with the words in order", async () => {
    const bytes = fixture("resume.pdf");
    expect(inspectResumeFile(bytes, { mime: "application/pdf", filename: "resume.pdf" })).toMatchObject({ ok: true, kind: "pdf" });
    const text = await documentToText(bytes, "application/pdf", "resume.pdf");
    expect(words(text)).toBeGreaterThanOrEqual(40);
    for (const line of RESUME_LINES) expect(flat(text)).toContain(flat(line));
    expect(flat(text).indexOf("Jordan Rivera")).toBeLessThan(flat(text).indexOf("Harbor Point Dental"));
  });

  it("the Word fixture is a valid résumé file and every paragraph is extracted", async () => {
    const bytes = fixture("resume.docx");
    expect(inspectResumeFile(bytes, { mime: DOCX, filename: "resume.docx" })).toMatchObject({ ok: true, kind: "docx" });
    const text = await documentToText(bytes, DOCX, "resume.docx");
    expect(words(text)).toBeGreaterThanOrEqual(40);
    for (const line of RESUME_LINES) expect(flat(text)).toContain(flat(line));
  });

  it("the builders that made the fixtures still produce files that extract the same way", async () => {
    expect(flat(await documentToText(buildResumePdf(), "application/pdf", "built.pdf"))).toContain("Registered Dental Hygienist at Harbor Point Dental");
    expect(flat(await documentToText(buildResumeDocx(), DOCX, "built.docx"))).toContain("Registered Dental Hygienist at Harbor Point Dental");
    // a one-line document extracts exactly its one line
    expect(flat(await documentToText(buildResumeDocx(["Only one line here"]), DOCX, "one.docx"))).toBe("Only one line here");
  });

  // The code check of 25 November 2026: a file's kind was decided twice, from its bytes when it was inspected and from
  // its name when it was read, so a Word file named "resume.pdf" came out as "Resume could not be read".
  it("reads a file as what the inspection found in its bytes, whatever its name says", async () => {
    /** The file as the worker reads it: inspected first, then read with the type the inspection gave it. */
    const read = async (bytes: Uint8Array, declared: { mime: string; filename: string }) => {
      const look = inspectResumeFile(bytes, declared);
      if (!look.ok) throw new Error(`the inspection refused the file: ${look.reason}`);
      return { kind: look.kind, text: flat(await documentToText(bytes, look.mime, declared.filename)) };
    };
    expect(await read(buildResumeDocx(["A Word file that was named as a PDF"]), { mime: DOCX, filename: "resume.pdf" })).toEqual({ kind: "docx", text: "A Word file that was named as a PDF" });
    expect(await read(buildResumePdf(["A PDF that was named as a Word file"]), { mime: "application/pdf", filename: "resume.docx" })).toEqual({ kind: "pdf", text: "A PDF that was named as a Word file" });
    expect(await read(new TextEncoder().encode("Plain words in a file named as a PDF"), { mime: "text/plain", filename: "resume.pdf" })).toEqual({ kind: "text", text: "Plain words in a file named as a PDF" });
    // a markdown file sent with no type of its own is still read by what the inspection says it is
    expect(await read(new TextEncoder().encode("# Dana"), { mime: "application/octet-stream", filename: "dana.md" })).toEqual({ kind: "text", text: "# Dana" });
    // and a file the inspection would not keep is never read by its name: Word bytes sent as plain text
    const wordSentAsText = buildResumeDocx(["Sent as plain text"]);
    expect(inspectResumeFile(wordSentAsText, { mime: "text/plain", filename: "resume.docx" })).toMatchObject({ ok: false, reason: "type_mismatch" });
    expect(await documentToText(wordSentAsText, "text/plain", "resume.docx")).toBe("");
  });

  it("a scanned PDF with no text layer is a valid file that yields no text", async () => {
    const bytes = fixture("scanned.pdf");
    expect(inspectResumeFile(bytes, { mime: "application/pdf", filename: "scan.pdf" })).toMatchObject({ ok: true, kind: "pdf" });
    expect(await documentToText(bytes, "application/pdf", "scan.pdf")).toBe("");
    expect(await documentToText(buildScannedPdf(), "application/pdf", "scan.pdf")).toBe("");
  });

  it("a corrupt PDF or Word file yields nothing and never throws", async () => {
    const corruptPdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\nxref\n0 1\ntrailer\n<< /Root 9 0 R >>\nstartxref\n999999\n%%EOF\n");
    await expect(documentToText(corruptPdf, "application/pdf", "broken.pdf")).resolves.toBe("");
    const truncatedDocx = buildResumeDocx().slice(0, 120);
    await expect(documentToText(truncatedDocx, DOCX, "broken.docx")).resolves.toBe("");
    const noise = new Uint8Array(256).map((_, i) => (i * 37) % 251);
    await expect(documentToText(noise, "application/pdf", "noise.pdf")).resolves.toBe("");
    await expect(documentToText(noise, DOCX, "noise.docx")).resolves.toBe("");
  });

  it("plain text and markdown pass through, and an unknown type yields nothing", async () => {
    expect(await documentToText(new TextEncoder().encode("  Dana Example, RDH\n"), "text/plain", "dana.txt")).toBe("Dana Example, RDH");
    expect(await documentToText(new TextEncoder().encode("# Dana"), "application/octet-stream", "dana.md")).toBe("# Dana");
    expect(await documentToText(new TextEncoder().encode("x"), "image/png", "photo.png")).toBe("");
  });
});
