import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 for S3-compatible object stores, written here so the application carries no cloud SDK.
 * Two shapes: a signed request (Authorization header, for server-side calls) and a presigned URL (query string, for a
 * browser to upload or download one object for a short time). Both follow the S3 rules: path-style bucket, each path
 * segment URI-encoded with `/` kept, query names and values encoded and sorted, UNSIGNED-PAYLOAD unless a body hash is
 * given. Checked against the worked examples in the S3 documentation (see sigv4.test.ts).
 */
export type SigV4Credentials = { accessKeyId: string; secretAccessKey: string; region: string; service?: string };

export type SignInput = {
  method: "GET" | "PUT" | "DELETE" | "HEAD" | "POST";
  /** Absolute URL of the object or listing, query string allowed. */
  url: string;
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body; omitted means UNSIGNED-PAYLOAD. */
  payloadHash?: string;
  now?: Date;
};

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/** RFC 3986 encoding with uppercase hex, as SigV4 requires; `/` is kept only when asked. */
export function awsEncode(value: string, keepSlash = false): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (UNRESERVED.test(ch) || (keepSlash && ch === "/")) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

export function amzDate(now: Date): { amz: string; day: string } {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return { amz: iso, day: iso.slice(0, 8) };
}

function canonicalQuery(params: Array<[string, string]>): string {
  return params
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function canonicalPath(pathname: string): string {
  // The path arrives already percent-encoded by URL; decode once, then encode each segment the SigV4 way.
  return pathname.split("/").map((seg) => awsEncode(decodeURIComponent(seg))).join("/") || "/";
}

function signingKey(secret: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), "aws4_request");
}

function parseQuery(search: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of new URLSearchParams(search)) out.push([k, v]);
  return out;
}

/** Signs a request for immediate use: returns the headers to send, including Authorization, x-amz-date and x-amz-content-sha256. */
export function signRequest(creds: SigV4Credentials, input: SignInput): Record<string, string> {
  const service = creds.service ?? "s3";
  const url = new URL(input.url);
  const { amz, day } = amzDate(input.now ?? new Date());
  const payloadHash = input.payloadHash ?? "UNSIGNED-PAYLOAD";
  const headers: Record<string, string> = { ...(input.headers ?? {}), host: url.host, "x-amz-date": amz, "x-amz-content-sha256": payloadHash };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => `${h}:${String(headers[h] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [input.method, canonicalPath(url.pathname), canonicalQuery(parseQuery(url.search)), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${creds.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amz, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(creds.secretAccessKey, day, creds.region, service), stringToSign).toString("hex");
  const { host: _host, ...rest } = headers;
  return { ...rest, Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/** A URL that authorizes exactly one method on one object for `expiresSeconds` (at most seven days) with no other credential. */
export function presignUrl(creds: SigV4Credentials, input: { method: "GET" | "PUT" | "DELETE" | "HEAD"; url: string; expiresSeconds: number; now?: Date; signedHeaders?: Record<string, string> }): string {
  const service = creds.service ?? "s3";
  const url = new URL(input.url);
  const { amz, day } = amzDate(input.now ?? new Date());
  const expires = Math.max(1, Math.min(604800, Math.floor(input.expiresSeconds)));
  const scope = `${day}/${creds.region}/${service}/aws4_request`;
  const headers: Record<string, string> = { ...(input.signedHeaders ?? {}), host: url.host };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const signedHeaders = names.join(";");
  const params: Array<[string, string]> = [
    ...parseQuery(url.search),
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${creds.accessKeyId}/${scope}`],
    ["X-Amz-Date", amz],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ];
  const canonicalHeaders = names.map((h) => `${h}:${String(headers[h] ?? headers[Object.keys(headers).find((k) => k.toLowerCase() === h)!]).trim().replace(/\s+/g, " ")}\n`).join("");
  const canonicalRequest = [input.method, canonicalPath(url.pathname), canonicalQuery(params), canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amz, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(creds.secretAccessKey, day, creds.region, service), stringToSign).toString("hex");
  const query = canonicalQuery(params) + `&X-Amz-Signature=${signature}`;
  return `${url.origin}${canonicalPath(url.pathname)}?${query}`;
}

export const sha256HexOf = sha256Hex;
