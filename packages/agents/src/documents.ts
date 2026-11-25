/// <reference path="./pdf-parse.d.ts" />
import { inspectResumeFile } from "@ros/contracts";

/**
 * Turns an uploaded resume into text. PDF via pdf-parse, DOCX via mammoth, text/markdown as-is.
 * Which of the three a file is, is decided in one place, from its bytes: `inspectResumeFile` in @ros/contracts. The
 * worker hands over the type that inspection gave the file (`mime`), and the same inspection says here how to read it,
 * so the file's name never overrules it: a Word file named "resume.pdf" is read as the Word file it is. A file the
 * inspection would not keep yields no text.
 * Scanned PDFs with no text layer return an empty string; the workflow records `resume.extraction_failed`
 * and the application continues (the candidate can still be screened by their answers).
 */
export async function documentToText(bytes: Uint8Array, mime: string, filename: string): Promise<string> {
  const look = inspectResumeFile(bytes, { mime, filename });
  if (!look.ok) return "";
  try {
    if (look.kind === "pdf") {
      const mod = await import("pdf-parse/lib/pdf-parse.js");
      const pdfParse = (mod as unknown as { default?: (b: Uint8Array) => Promise<{ text: string }> }).default ?? (mod as unknown as (b: Uint8Array) => Promise<{ text: string }>);
      const res = await pdfParse(ownBytes(bytes));
      return (res.text ?? "").trim();
    }
    if (look.kind === "docx") {
      const mammoth = await import("mammoth");
      const res = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      return (res.value ?? "").trim();
    }
    return Buffer.from(bytes).toString("utf8").trim();
  } catch {
    return "";
  }
}

/**
 * A plain Uint8Array that owns exactly these bytes, never a Node Buffer. The pdf.js build inside pdf-parse reads its
 * sub-streams from the whole underlying ArrayBuffer of what it is handed, and copies a Buffer with the Buffer
 * constructor, which carves anything under 4 KB out of Node's shared pool; a short PDF was then read from the pool's
 * start and failed with "bad XRef entry" (or an empty page) depending on what had been allocated before it. A typed
 * array with its own ArrayBuffer is copied as a typed array and extracts the same way every time.
 */
function ownBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
