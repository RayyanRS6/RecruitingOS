import { describe, expect, it } from "vitest";
import { LOGO_FILE, LOGO_MAX_BYTES, inspectLogo, logoFileName, logoKey } from "./logo";

/** The first bytes of each kind of image, enough for the header checks: the pixels themselves are never read. */
function png(width: number, height: number, pad = 0): Uint8Array {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}
function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment of 16 bytes, then SOF0 with the size
  const b = new Uint8Array(2 + 18 + 19);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
  new DataView(b.buffer).setUint16(25, height);
  new DataView(b.buffer).setUint16(27, width);
  return b;
}
function webp(kind: "VP8X" | "VP8 " | "VP8L", width: number, height: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
  b.set([..."WEBP"].map((c) => c.charCodeAt(0)), 8);
  b.set([...kind].map((c) => c.charCodeAt(0)), 12);
  const v = new DataView(b.buffer);
  if (kind === "VP8X") {
    v.setUint16(24, (width - 1) & 0xffff, true); b[26] = ((width - 1) >> 16) & 0xff;
    v.setUint16(27, (height - 1) & 0xffff, true); b[29] = ((height - 1) >> 16) & 0xff;
  } else if (kind === "VP8 ") {
    b.set([0x9d, 0x01, 0x2a], 23);
    v.setUint16(26, width, true);
    v.setUint16(28, height, true);
  } else {
    b[20] = 0x2f;
    v.setUint32(21, ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), true);
  }
  return b;
}

describe("logo files", () => {
  it("knows PNG, JPEG and WebP by their bytes and reads the size from the header", () => {
    expect(inspectLogo(png(400, 120))).toEqual({ ok: true, mime: "image/png", extension: "png", width: 400, height: 120 });
    expect(inspectLogo(jpeg(640, 200))).toEqual({ ok: true, mime: "image/jpeg", extension: "jpg", width: 640, height: 200 });
    expect(inspectLogo(webp("VP8X", 512, 256))).toEqual({ ok: true, mime: "image/webp", extension: "webp", width: 512, height: 256 });
    expect(inspectLogo(webp("VP8 ", 300, 100))).toMatchObject({ ok: true, width: 300, height: 100 });
    expect(inspectLogo(webp("VP8L", 128, 64))).toMatchObject({ ok: true, width: 128, height: 64 });
  });

  it("refuses SVG, GIF, HTML dressed as an image, empty files, files over 2 MB and sizes that are not a logo", () => {
    const text = (s: string) => new TextEncoder().encode(s);
    expect(inspectLogo(text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toMatchObject({ ok: false, reason: "unsupported_type" });
    expect(inspectLogo(text("GIF89a\u0001\u0000\u0001\u0000"))).toMatchObject({ ok: false, reason: "unsupported_type" });
    expect(inspectLogo(text("<html><body>not a png</body></html>"))).toMatchObject({ ok: false, reason: "unsupported_type" });
    expect(inspectLogo(new Uint8Array())).toMatchObject({ ok: false, reason: "empty" });
    expect(inspectLogo(png(400, 120, LOGO_MAX_BYTES))).toMatchObject({ ok: false, reason: "too_large", message: "The logo must be under 2 MB. Save it smaller and try again." });
    expect(inspectLogo(png(16, 16))).toMatchObject({ ok: false, reason: "too_small" });
    expect(inspectLogo(png(5000, 300))).toMatchObject({ ok: false, reason: "too_big" });
  });

  it("names the stored file by a fresh id, and only such a name may be served", () => {
    const file = logoFileName("0192f0c4-1c2d-7a3b-8c4d-5e6f708192a3", "png");
    expect(file).toBe("0192f0c4-1c2d-7a3b-8c4d-5e6f708192a3.png");
    expect(logoKey("company-1", file)).toBe("logos/company-1/0192f0c4-1c2d-7a3b-8c4d-5e6f708192a3.png");
    expect(LOGO_FILE.test(file)).toBe(true);
    for (const bad of ["../secret.png", "x.svg", "0192f0c4-1c2d-7a3b-8c4d-5e6f708192a3.png/..", "0192F0C4-1c2d-7a3b-8c4d-5e6f708192a3.html"]) expect(LOGO_FILE.test(bad), bad).toBe(false);
  });
});
