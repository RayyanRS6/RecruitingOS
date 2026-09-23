import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Same-origin upload and download grants for the local and in-memory adapters: the application itself plays the part
 * the object store plays in staging and production, so the browser flow (ask for a grant, PUT the file, submit the
 * form) is the same everywhere and is tested against the fakes. A grant names one key, one method, one content type
 * and an expiry, signed with a key derived from the session secret. Never used with the real store.
 */
export type GrantPayload = { k: string; m: "PUT" | "GET"; ct: string; exp: number; fn?: string };

const b64u = {
  encode: (b: Buffer | string) => Buffer.from(b).toString("base64url"),
  decode: (s: string) => Buffer.from(s, "base64url"),
};

export class GrantSigner {
  private key: Buffer;
  constructor(secret: string, private baseUrl: string) {
    this.key = createHmac("sha256", "ros-storage-grant").update(secret).digest();
  }
  sign(payload: GrantPayload): string {
    const body = b64u.encode(JSON.stringify(payload));
    const mac = createHmac("sha256", this.key).update(body).digest();
    return `${body}.${b64u.encode(mac)}`;
  }
  verify(token: string, now: Date = new Date()): GrantPayload | null {
    const [body, mac] = token.split(".");
    if (!body || !mac) return null;
    const expected = createHmac("sha256", this.key).update(body).digest();
    const given = b64u.decode(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const payload = JSON.parse(b64u.decode(body).toString("utf8")) as GrantPayload;
      if (typeof payload.k !== "string" || (payload.m !== "PUT" && payload.m !== "GET") || typeof payload.exp !== "number") return null;
      if (payload.exp * 1000 < now.getTime()) return null;
      return payload;
    } catch {
      return null;
    }
  }
  url(kind: "put" | "get", token: string): string {
    return `${this.baseUrl}/files/${kind}/${token}`;
  }
}
