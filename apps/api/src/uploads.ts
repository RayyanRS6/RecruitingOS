import { createHmac, timingSafeEqual } from "node:crypto";
import { MAX_RESUME_BYTES } from "@ros/contracts";

/**
 * Direct-to-storage résumé uploads (founder decision 2). The browser asks for an upload authorization, sends the file
 * straight to storage under a quarantine key, and hands the application form a sealed grant naming that key. The
 * grant is what lets the form attach the file: it is bound to the company and role, to one key, one declared type and
 * one size, and it expires. Nothing here trusts the browser's description of the file; the worker inspects the bytes.
 */
export const UPLOAD_GRANT_TTL_SECONDS = 15 * 60;
/** How long the presigned PUT itself stays valid: enough for a slow connection on an 8 MB file, not more. */
export const UPLOAD_URL_TTL_SECONDS = 5 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 2 * 60;

export type ResumeExtension = "pdf" | "docx" | "txt" | "md";
const MIME_BY_EXT: Record<ResumeExtension, string> = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", txt: "text/plain", md: "text/markdown" };
const EXT_BY_MIME: Record<string, ResumeExtension> = { "application/pdf": "pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "text/plain": "txt", "text/markdown": "md" };

export type UploadIntent = { filename: string; size: number; type: string };

/** Accepts or refuses an intent from its declared name, size and type only. The bytes are judged later, in quarantine. */
export function checkUploadIntent(input: unknown): { ok: true; filename: string; size: number; mime: string; extension: ResumeExtension } | { ok: false; error: string } {
  const i = (input ?? {}) as Partial<UploadIntent>;
  const filename = typeof i.filename === "string" ? i.filename.trim().slice(0, 200) : "";
  const size = typeof i.size === "number" && Number.isFinite(i.size) ? Math.floor(i.size) : -1;
  const type = typeof i.type === "string" ? i.type.split(";")[0].trim().toLowerCase() : "";
  if (!filename) return { ok: false, error: "The file has no name." };
  if (size <= 0) return { ok: false, error: "The file is empty." };
  if (size > MAX_RESUME_BYTES) return { ok: false, error: "Resume files must be under 8 MB." };
  const ext = (filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "") as ResumeExtension | "";
  const extension: ResumeExtension | undefined = EXT_BY_MIME[type] ?? (ext === "pdf" || ext === "docx" || ext === "txt" || ext === "md" ? ext : undefined);
  if (!extension) return { ok: false, error: "Please upload a PDF, Word (.docx), or text file." };
  return { ok: true, filename, size, mime: MIME_BY_EXT[extension], extension };
}

export function quarantineKey(companyId: string, roleId: string, uploadId: string, extension: ResumeExtension): string {
  return `quarantine/${companyId}/${roleId}/${uploadId}.${extension}`;
}

export type UploadGrantPayload = { v: 1; companyId: string; roleId: string; uploadId: string; key: string; filename: string; mime: string; size: number; exp: number };

/** Seals and opens upload grants with a key derived from the session secret. The payload is signed, not encrypted: it holds no secret. */
export class UploadGrants {
  private key: Buffer;
  constructor(secret: string) {
    this.key = createHmac("sha256", "ros-upload-grant").update(secret).digest();
  }
  seal(payload: UploadGrantPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${createHmac("sha256", this.key).update(body).digest("base64url")}`;
  }
  open(token: string | undefined | null, now: Date = new Date()): UploadGrantPayload | null {
    if (!token || typeof token !== "string") return null;
    const [body, mac] = token.split(".");
    if (!body || !mac) return null;
    const expected = createHmac("sha256", this.key).update(body).digest();
    const given = Buffer.from(mac, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as UploadGrantPayload;
      if (p.v !== 1 || typeof p.key !== "string" || typeof p.exp !== "number" || p.exp * 1000 < now.getTime()) return null;
      return p;
    } catch {
      return null;
    }
  }
}

/** A filename safe for a Content-Disposition header and for display: printable ASCII, no quotes, bounded. */
export function safeFilename(name: string, fallback = "resume"): string {
  const cleaned = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\/]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  return cleaned || fallback;
}
