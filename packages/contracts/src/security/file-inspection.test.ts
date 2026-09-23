import { describe, expect, it } from "vitest";
import { inspectResumeFile, MAX_RESUME_BYTES, sniffKind } from "./file-inspection";

const enc = (s: string) => new TextEncoder().encode(s);
const bytes = (...parts: Array<string | number[]>) => new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...enc(p)] : p)));

/** Minimal but structurally valid fixtures. */
const PDF = bytes("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const PDF_ENCRYPTED = bytes("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF\n");
const PDF_JS = bytes("%PDF-1.7\n1 0 obj << /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF\n");
const PDF_TRUNCATED = bytes("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n");
const DOCX = bytes([0x50, 0x4b, 0x03, 0x04], "\x14\x00\x00\x00\x08\x00", "[Content_Types].xml...word/document.xml<w:document/>", [0x50, 0x4b, 0x05, 0x06], "\x00".repeat(18));
const DOCX_MACROS = bytes([0x50, 0x4b, 0x03, 0x04], "\x14\x00", "[Content_Types].xml word/document.xml word/vbaProject.bin", [0x50, 0x4b, 0x05, 0x06], "\x00".repeat(18));
const DOCX_NO_BODY = bytes([0x50, 0x4b, 0x03, 0x04], "\x14\x00", "[Content_Types].xml word/styles.xml", [0x50, 0x4b, 0x05, 0x06], "\x00".repeat(18));
const DOCX_TRUNCATED = bytes([0x50, 0x4b, 0x03, 0x04], "\x14\x00", "[Content_Types].xml word/document.xml");
const ZIP = bytes([0x50, 0x4b, 0x03, 0x04], "\x14\x00\x00\x00\x08\x00", "photos/holiday.jpg", [0x50, 0x4b, 0x05, 0x06], "\x00".repeat(18));
const OLE = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], "\x00".repeat(64));
const EXE = bytes([0x4d, 0x5a, 0x90, 0x00], "\x00".repeat(60), "This program cannot be run in DOS mode");
const ELF = bytes([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
const MACHO = bytes([0xcf, 0xfa, 0xed, 0xfe], "\x00".repeat(16));
const SHEBANG = bytes("#!/bin/sh\nrm -rf /\n");
const TEXT = bytes("Dana Example\nRegistered nurse, 6 years in acute care.\n");
const MARKDOWN = bytes("# Dana Example\n\n- RN, 6 years\n");
const BINARY_TEXT = bytes("Dana", [0x00, 0x00, 0x01, 0x02], "Example");
const LATIN1 = new Uint8Array([0x52, 0xe9, 0x73, 0x75, 0x6d, 0xe9]); // "Résumé" in Latin-1: not UTF-8

describe("sniffKind", () => {
  it("recognises each supported kind and each refused family by bytes alone", () => {
    expect(sniffKind(PDF)).toBe("pdf");
    expect(sniffKind(bytes("\xef\xbb\xbfjunk\n", "%PDF-1.5\n%%EOF"))).toBe("pdf");
    expect(sniffKind(DOCX)).toBe("docx");
    expect(sniffKind(ZIP)).toBe("zip");
    expect(sniffKind(OLE)).toBe("ole");
    for (const x of [EXE, ELF, MACHO, SHEBANG]) expect(sniffKind(x)).toBe("executable");
    expect(sniffKind(TEXT)).toBeNull();
  });
});

describe("inspectResumeFile", () => {
  it("accepts a PDF, a Word document, plain text and markdown, whatever the browser declared", () => {
    expect(inspectResumeFile(PDF, { mime: "application/pdf", filename: "cv.pdf" })).toEqual({ ok: true, kind: "pdf", mime: "application/pdf", extension: "pdf" });
    expect(inspectResumeFile(PDF, { mime: "application/octet-stream", filename: "cv.PDF" })).toMatchObject({ ok: true, kind: "pdf" });
    expect(inspectResumeFile(PDF, { mime: "", filename: "" })).toMatchObject({ ok: true, kind: "pdf" });
    expect(inspectResumeFile(DOCX, { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "cv.docx" })).toMatchObject({ ok: true, kind: "docx", extension: "docx" });
    expect(inspectResumeFile(DOCX, { mime: "application/octet-stream", filename: "cv.docx" })).toMatchObject({ ok: true, kind: "docx" });
    expect(inspectResumeFile(TEXT, { mime: "text/plain", filename: "cv.txt" })).toEqual({ ok: true, kind: "text", mime: "text/plain", extension: "txt" });
    expect(inspectResumeFile(MARKDOWN, { mime: "text/markdown", filename: "cv.md" })).toEqual({ ok: true, kind: "text", mime: "text/markdown", extension: "md" });
    expect(inspectResumeFile(MARKDOWN, { mime: "", filename: "cv.md" })).toMatchObject({ ok: true, extension: "md" });
  });

  it("refuses programs however they are named", () => {
    expect(inspectResumeFile(EXE, { mime: "application/pdf", filename: "cv.pdf" })).toMatchObject({ ok: false, reason: "executable" });
    expect(inspectResumeFile(ELF, { mime: "text/plain", filename: "cv.txt" })).toMatchObject({ ok: false, reason: "executable" });
    expect(inspectResumeFile(MACHO, { mime: "", filename: "cv.docx" })).toMatchObject({ ok: false, reason: "executable" });
    expect(inspectResumeFile(SHEBANG, { mime: "text/plain", filename: "cv.txt" })).toMatchObject({ ok: false, reason: "executable" });
    expect(inspectResumeFile(PDF_JS, { mime: "application/pdf", filename: "cv.pdf" })).toMatchObject({ ok: false, reason: "executable" });
  });

  it("refuses encrypted and macro-bearing documents", () => {
    expect(inspectResumeFile(PDF_ENCRYPTED, { mime: "application/pdf", filename: "cv.pdf" })).toMatchObject({ ok: false, reason: "encrypted" });
    expect(inspectResumeFile(OLE, { mime: "application/msword", filename: "cv.doc" })).toMatchObject({ ok: false, reason: "encrypted" });
    expect(inspectResumeFile(DOCX_MACROS, { mime: "", filename: "cv.docm" })).toMatchObject({ ok: false, reason: "macros" });
  });

  it("refuses malformed, mismatched, empty, oversized and unsupported files", () => {
    expect(inspectResumeFile(PDF_TRUNCATED, { mime: "application/pdf", filename: "cv.pdf" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(inspectResumeFile(DOCX_TRUNCATED, { mime: "", filename: "cv.docx" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(inspectResumeFile(DOCX_NO_BODY, { mime: "", filename: "cv.docx" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(inspectResumeFile(TEXT, { mime: "application/pdf", filename: "cv.pdf" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(inspectResumeFile(PDF, { mime: "text/plain", filename: "cv.txt" })).toMatchObject({ ok: false, reason: "type_mismatch" });
    expect(inspectResumeFile(DOCX, { mime: "application/pdf", filename: "cv.pdf" })).toMatchObject({ ok: false, reason: "type_mismatch" });
    expect(inspectResumeFile(BINARY_TEXT, { mime: "text/plain", filename: "cv.txt" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(inspectResumeFile(LATIN1, { mime: "text/plain", filename: "cv.txt" })).toMatchObject({ ok: false, reason: "malformed" });
    expect(inspectResumeFile(new Uint8Array(0), { mime: "application/pdf", filename: "cv.pdf" })).toMatchObject({ ok: false, reason: "empty" });
    expect(inspectResumeFile(new Uint8Array(MAX_RESUME_BYTES + 1), { mime: "application/pdf", filename: "cv.pdf" })).toMatchObject({ ok: false, reason: "too_large" });
    expect(inspectResumeFile(ZIP, { mime: "application/zip", filename: "cv.zip" })).toMatchObject({ ok: false, reason: "unsupported_type" });
    expect(inspectResumeFile(TEXT, { mime: "image/png", filename: "cv.png" })).toMatchObject({ ok: false, reason: "unsupported_type" });
    expect(inspectResumeFile(TEXT, { mime: "", filename: "cv" })).toMatchObject({ ok: false, reason: "unsupported_type" });
  });

  it("never echoes the file's contents in a rejection detail", () => {
    const secret = bytes("#!/bin/sh\necho SECRET-CONTENT-123\n");
    const out = inspectResumeFile(secret, { mime: "text/plain", filename: "cv.txt" });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("SECRET-CONTENT-123");
  });
});
