/**
 * What a résumé file must be before it is kept (founder decision 2, 22 September 2026): a PDF, a Word document
 * (.docx) or plain text, identified by its bytes and not only by its name or declared type; not executable, not
 * encrypted, not malformed, not empty, not over the limit. Everything here is pure and synchronous so the API, the
 * worker and the tests all apply exactly the same rule. Malware scanning is a separate step (the scanner adapter).
 */
export const MAX_RESUME_BYTES = 8 * 1024 * 1024;

export type ResumeKind = "pdf" | "docx" | "text";

export type FileInspection =
  | { ok: true; kind: ResumeKind; mime: string; extension: "pdf" | "docx" | "txt" | "md" }
  | { ok: false; reason: FileRejection; detail: string };

export type FileRejection = "empty" | "too_large" | "unsupported_type" | "type_mismatch" | "executable" | "encrypted" | "macros" | "malformed";

const MIME_BY_KIND: Record<ResumeKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  text: "text/plain",
};

const DECLARED: Record<string, ResumeKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "text",
  "text/markdown": "text",
};

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

function indexOfAscii(bytes: Uint8Array, needle: string, from = 0, to = bytes.length): number {
  const n = needle.length;
  const end = Math.min(to, bytes.length) - n;
  outer: for (let i = from; i <= end; i++) {
    for (let j = 0; j < n; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

const EXECUTABLE_SIGNATURES: Array<{ sig: number[]; name: string }> = [
  { sig: [0x4d, 0x5a], name: "Windows executable" },
  { sig: [0x7f, 0x45, 0x4c, 0x46], name: "ELF executable" },
  { sig: [0xca, 0xfe, 0xba, 0xbe], name: "Mach-O universal binary or Java class" },
  { sig: [0xcf, 0xfa, 0xed, 0xfe], name: "Mach-O executable" },
  { sig: [0xce, 0xfa, 0xed, 0xfe], name: "Mach-O executable" },
  { sig: [0xfe, 0xed, 0xfa, 0xcf], name: "Mach-O executable" },
  { sig: [0xfe, 0xed, 0xfa, 0xce], name: "Mach-O executable" },
  { sig: [0x23, 0x21], name: "script with a shebang line" },
  { sig: [0x25, 0x21, 0x50, 0x53], name: "PostScript program" },
];

/** The kind the bytes say they are, or null when no supported kind matches. */
export function sniffKind(bytes: Uint8Array): ResumeKind | "ole" | "zip" | "executable" | null {
  for (const e of EXECUTABLE_SIGNATURES) if (startsWith(bytes, e.sig)) return "executable";
  // A PDF header may follow a few bytes of preamble (the specification allows up to 1024).
  const pdfAt = indexOfAscii(bytes, "%PDF-", 0, 1024 + 5);
  if (pdfAt !== -1) return "pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    const head = bytes.subarray(0, Math.min(bytes.length, 4096));
    if (indexOfAscii(head, "word/") !== -1 || indexOfAscii(head, "[Content_Types].xml") !== -1) return "docx";
    return "zip";
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  return null;
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 65536));
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) control++;
  }
  if (control > sample.length / 100) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspects an uploaded file against the declared type and name. The declared type may be wrong (browsers guess from the
 * extension); the bytes decide. A mismatch between a claimed PDF and, say, a Word document is refused rather than
 * silently reclassified, because the person meant to send one thing and something else arrived.
 */
export function inspectResumeFile(bytes: Uint8Array, declared: { mime?: string | null; filename?: string | null }, maxBytes = MAX_RESUME_BYTES): FileInspection {
  if (bytes.length === 0) return { ok: false, reason: "empty", detail: "the file is empty" };
  if (bytes.length > maxBytes) return { ok: false, reason: "too_large", detail: `the file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB` };
  const name = (declared.filename ?? "").toLowerCase();
  const ext = name.match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const declaredMime = (declared.mime ?? "").split(";")[0].trim().toLowerCase();
  const expected: ResumeKind | null = DECLARED[declaredMime] ?? (ext === "pdf" ? "pdf" : ext === "docx" ? "docx" : ext === "txt" || ext === "md" ? "text" : null);
  const sniffed = sniffKind(bytes);

  if (sniffed === "executable") return { ok: false, reason: "executable", detail: "the file is a program, not a document" };
  if (sniffed === "ole") return { ok: false, reason: "encrypted", detail: "the file is an older or password-protected Office file; save it as .docx without a password, or as a PDF" };
  if (sniffed === "zip") return { ok: false, reason: "unsupported_type", detail: "the file is an archive, not a document" };

  if (sniffed === "pdf") {
    if (expected && expected !== "pdf") return { ok: false, reason: "type_mismatch", detail: `the file is a PDF but was sent as ${expected}` };
    if (indexOfAscii(bytes, "%%EOF", Math.max(0, bytes.length - 2048)) === -1) return { ok: false, reason: "malformed", detail: "the PDF is incomplete (no end-of-file marker)" };
    if (indexOfAscii(bytes, "/Encrypt") !== -1) return { ok: false, reason: "encrypted", detail: "the PDF is password-protected or encrypted; save an unprotected copy" };
    if (indexOfAscii(bytes, "/JavaScript") !== -1 || indexOfAscii(bytes, "/JS ") !== -1 || indexOfAscii(bytes, "/JS<") !== -1) return { ok: false, reason: "executable", detail: "the PDF contains scripts" };
    if (indexOfAscii(bytes, "/Launch") !== -1) return { ok: false, reason: "executable", detail: "the PDF contains a launch action" };
    return { ok: true, kind: "pdf", mime: MIME_BY_KIND.pdf, extension: "pdf" };
  }
  if (sniffed === "docx") {
    if (expected && expected !== "docx") return { ok: false, reason: "type_mismatch", detail: `the file is a Word document but was sent as ${expected}` };
    if (indexOfAscii(bytes, "vbaProject.bin") !== -1) return { ok: false, reason: "macros", detail: "the Word document contains macros; save it as .docx without macros, or as a PDF" };
    if (indexOfAscii(bytes, "EncryptedPackage") !== -1 || indexOfAscii(bytes, "EncryptionInfo") !== -1) return { ok: false, reason: "encrypted", detail: "the Word document is password-protected" };
    // The central directory ends with the end-of-central-directory record; without it the archive cannot be read.
    if (indexOfAscii(bytes, "PK\x05\x06", Math.max(0, bytes.length - 66_000)) === -1) return { ok: false, reason: "malformed", detail: "the Word document is incomplete" };
    if (indexOfAscii(bytes, "word/document.xml") === -1) return { ok: false, reason: "malformed", detail: "the Word document has no body" };
    return { ok: true, kind: "docx", mime: MIME_BY_KIND.docx, extension: "docx" };
  }
  // No binary signature: text is acceptable only when it was declared or named as text and reads as UTF-8.
  if (expected === "text" || (!expected && !declaredMime)) {
    if (!looksLikeText(bytes)) return { ok: false, reason: "malformed", detail: "the file is not readable text" };
    if (expected === null) return { ok: false, reason: "unsupported_type", detail: "unknown file type; send a PDF, a Word document (.docx) or a text file" };
    return { ok: true, kind: "text", mime: ext === "md" ? "text/markdown" : MIME_BY_KIND.text, extension: ext === "md" ? "md" : "txt" };
  }
  if (expected === "pdf") return { ok: false, reason: "malformed", detail: "the file was sent as a PDF but is not one" };
  if (expected === "docx") return { ok: false, reason: "malformed", detail: "the file was sent as a Word document but is not one" };
  return { ok: false, reason: "unsupported_type", detail: "send a PDF, a Word document (.docx) or a text file" };
}

/** A storage-safe file extension for the kind, never taken from the person's filename. */
export function extensionFor(kind: ResumeKind, filename?: string | null): "pdf" | "docx" | "txt" | "md" {
  if (kind === "pdf") return "pdf";
  if (kind === "docx") return "docx";
  return (filename ?? "").toLowerCase().endsWith(".md") ? "md" : "txt";
}
