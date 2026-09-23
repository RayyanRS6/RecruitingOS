import type { AdapterStatus, DownloadGrant, StorageAdapter, StoredObjectInfo, UploadGrant } from "../types";
import { awsEncode, presignUrl, sha256HexOf, signRequest, type SigV4Credentials } from "./sigv4";

export type SupabaseStorageConfig = {
  /** `https://<project-ref>.storage.supabase.co/storage/v1/s3` (the direct storage hostname the documentation recommends). */
  endpoint: string;
  /** The project's region code, for example `us-west-2`. */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetch?: typeof fetch;
};

export class StorageError extends Error {
  constructor(public readonly operation: string, public readonly httpStatus: number) {
    super(`storage ${operation} failed with HTTP ${httpStatus}`);
  }
}

function decodeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return m;
  });
}

/**
 * Supabase Storage through its S3-compatible endpoint (founder decision 2), with the project's S3 access keys: a
 * storage-only credential (it cannot reach the database, Auth or Vault), never the service-role key. The keys are not
 * bucket-scoped at the provider, so a project holds exactly one bucket for this application. Path-style addressing,
 * signature version 4, presigned single-object URLs for the browser (PUT for a few minutes, GET for a couple of
 * minutes as an attachment). No cloud SDK. Errors carry the operation and the HTTP status, never the credential.
 */
export class SupabaseStorageAdapter implements StorageAdapter {
  readonly id = "supabase_storage";
  private verified = false;
  private creds: SigV4Credentials;
  private base: string;
  private fetchImpl: typeof fetch;
  constructor(private cfg: SupabaseStorageConfig) {
    for (const k of ["endpoint", "region", "bucket", "accessKeyId", "secretAccessKey"] as const) if (!cfg[k]) throw new Error(`Supabase storage: ${k} is not configured`);
    this.creds = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region, service: "s3" };
    this.base = cfg.endpoint.replace(/\/+$/, "");
    this.fetchImpl = cfg.fetch ?? fetch;
  }
  /** `awaiting_verification` until one call has succeeded against the real bucket; `live` after. Never `fake`. */
  get status(): AdapterStatus {
    return this.verified ? "live" : "awaiting_verification";
  }
  private objectUrl(key: string): string {
    return `${this.base}/${awsEncode(this.cfg.bucket)}/${key.split("/").map((s) => awsEncode(s)).join("/")}`;
  }
  private async call(operation: string, method: "GET" | "PUT" | "DELETE" | "HEAD", url: string, opts: { body?: Uint8Array; headers?: Record<string, string>; okStatuses: number[] }): Promise<Response> {
    const payloadHash = opts.body ? sha256HexOf(opts.body) : "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const headers = signRequest(this.creds, { method, url, headers: opts.headers, payloadHash });
    const res = await this.fetchImpl(url, { method, headers, body: opts.body ? new Uint8Array(opts.body) : undefined });
    if (!opts.okStatuses.includes(res.status)) throw new StorageError(operation, res.status);
    this.verified = true;
    return res;
  }
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<{ key: string }> {
    await this.call("put", "PUT", this.objectUrl(key), { body: bytes, headers: { "content-type": contentType }, okStatuses: [200] });
    return { key };
  }
  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.call("get", "GET", this.objectUrl(key), { okStatuses: [200, 404] });
    if (res.status === 404) return null;
    return new Uint8Array(await res.arrayBuffer());
  }
  async head(key: string): Promise<StoredObjectInfo | null> {
    const res = await this.call("head", "HEAD", this.objectUrl(key), { okStatuses: [200, 404] });
    if (res.status === 404) return null;
    return { size: Number(res.headers.get("content-length") ?? "0"), contentType: res.headers.get("content-type") };
  }
  async delete(key: string): Promise<void> {
    await this.call("delete", "DELETE", this.objectUrl(key), { okStatuses: [200, 204, 404] });
  }
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | null = null;
    for (let page = 0; page < 100; page++) {
      const u = new URL(`${this.base}/${awsEncode(this.cfg.bucket)}/`);
      u.searchParams.set("list-type", "2");
      u.searchParams.set("prefix", prefix);
      u.searchParams.set("max-keys", "1000");
      if (token) u.searchParams.set("continuation-token", token);
      const res = await this.call("list", "GET", u.toString(), { okStatuses: [200] });
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(decodeXml(m[1]!));
      const next = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      if (!truncated || !next) break;
      token = decodeXml(next[1]!);
    }
    return keys;
  }
  async createUploadUrl(key: string, opts: { contentType: string; expiresSeconds: number }): Promise<UploadGrant> {
    const now = new Date();
    const url = presignUrl(this.creds, { method: "PUT", url: this.objectUrl(key), expiresSeconds: opts.expiresSeconds, now, signedHeaders: { "content-type": opts.contentType } });
    return { url, method: "PUT", headers: { "content-type": opts.contentType }, expiresAt: new Date(now.getTime() + opts.expiresSeconds * 1000).toISOString() };
  }
  async createDownloadUrl(key: string, opts: { expiresSeconds: number; filename: string; contentType: string }): Promise<DownloadGrant> {
    const now = new Date();
    const u = new URL(this.objectUrl(key));
    const safeName = opts.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").slice(0, 120) || "file";
    u.searchParams.set("response-content-disposition", `attachment; filename="${safeName}"`);
    u.searchParams.set("response-content-type", opts.contentType);
    const url = presignUrl(this.creds, { method: "GET", url: u.toString(), expiresSeconds: opts.expiresSeconds, now });
    return { url, expiresAt: new Date(now.getTime() + opts.expiresSeconds * 1000).toISOString() };
  }
  browserOrigins(): string[] {
    return [new URL(this.base).origin];
  }
}
