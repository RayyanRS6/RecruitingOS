/**
 * A company's logo (plan D10, also 01/13's logo upload): stored by us in the same private bucket as everything else and
 * served from our own origin, so the candidate pages' policy stays `img-src 'self' data:` and no page ever loads an
 * image from another host. Only PNG, JPEG and WebP are taken, judged by their bytes (never by the name or the type the
 * browser claims); SVG is refused because it can carry script. The file name is a fresh id, so a public copy can be
 * cached for good and a new logo never shows the old one.
 */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
/** Smaller than this cannot be read on a job page; larger than this is not a logo. */
export const LOGO_MIN_SIDE = 32;
export const LOGO_MAX_SIDE = 4096;

export type LogoMime = "image/png" | "image/jpeg" | "image/webp";
export type LogoExtension = "png" | "jpg" | "webp";

const EXTENSION: Record<LogoMime, LogoExtension> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const LOGO_MIME_BY_EXTENSION: Record<LogoExtension, LogoMime> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export type LogoInspection =
  | { ok: true; mime: LogoMime; extension: LogoExtension; width: number | null; height: number | null }
  | { ok: false; reason: "empty" | "too_large" | "unsupported_type" | "too_small" | "too_big"; message: string };

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

function pngSize(b: Uint8Array): [number, number] | null {
  return b.length >= 24 && ascii(b, 12, 4) === "IHDR" ? [u32be(b, 16), u32be(b, 20)] : null;
}

/** The first frame header (SOF0 to SOF15, without the table markers DHT, JPG and DAC) carries the size. */
function jpegSize(b: Uint8Array): [number, number] | null {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) { at += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [u16be(b, at + 7), u16be(b, at + 5)];
    at += 2 + u16be(b, at + 2);
  }
  return null;
}

function webpSize(b: Uint8Array): [number, number] | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return [(b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff];
  if (chunk === "VP8L" && b[20] === 0x2f) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  return null;
}

/** What kind of image the bytes are, and its size when the header says; a refusal in plain words otherwise. */
export function inspectLogo(bytes: Uint8Array): LogoInspection {
  if (!bytes.length) return { ok: false, reason: "empty", message: "The file is empty." };
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, reason: "too_large", message: "The logo must be under 2 MB. Save it smaller and try again." };
  let mime: LogoMime | null = null;
  let size: [number, number] | null = null;
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    mime = "image/png";
    size = pngSize(bytes);
  } else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mime = "image/jpeg";
    size = jpegSize(bytes);
  } else if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    mime = "image/webp";
    size = webpSize(bytes);
  }
  if (!mime) return { ok: false, reason: "unsupported_type", message: "Please upload the logo as a PNG, JPEG or WebP image." };
  const [width, height] = size ?? [null, null];
  if (width !== null && height !== null) {
    if (width < LOGO_MIN_SIDE || height < LOGO_MIN_SIDE) return { ok: false, reason: "too_small", message: `The logo is too small to read on a job page. Use one at least ${LOGO_MIN_SIDE} pixels on each side.` };
    if (width > LOGO_MAX_SIDE || height > LOGO_MAX_SIDE) return { ok: false, reason: "too_big", message: `The logo is larger than it needs to be. Use one at most ${LOGO_MAX_SIDE} pixels on each side.` };
  }
  return { ok: true, mime, extension: EXTENSION[mime], width, height };
}

/** Where the bytes live in the bucket: one folder per company, the file named by a fresh id. */
export function logoKey(companyId: string, file: string): string {
  return `logos/${companyId}/${file}`;
}

/** The public file name of a logo: a fresh id and the extension of what was inspected. */
export function logoFileName(id: string, extension: LogoExtension): string {
  return `${id}.${extension}`;
}

/** A file name a logo route may serve: exactly what `logoFileName` makes, so no path can be smuggled in. */
export const LOGO_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;
