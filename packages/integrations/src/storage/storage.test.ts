import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GrantSigner } from "./grants";
import { MemoryStorageAdapter } from "./local";
import { type StorageError, SupabaseStorageAdapter } from "./supabase";
import { createIntegrations } from "../registry";

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const cfg = { endpoint: "https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3", region: "us-west-2", bucket: "resumes", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: SECRET };

type Seen = { method: string; url: string; headers: Record<string, string>; body: Uint8Array | null };
function fakeFetch(handler: (req: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const body = init?.body ? new Uint8Array(init.body as Uint8Array) : null;
    const req = { method: init?.method ?? "GET", url: String(input), headers, body };
    seen.push(req);
    return handler(req);
  }) as unknown as typeof fetch;
  return { fetch: f, seen };
}

describe("memory adapter and same-origin grants", () => {
  it("stores, reads, heads, lists by tenant prefix and deletes idempotently", async () => {
    const s = new MemoryStorageAdapter();
    await s.put("companyA/app1/x.pdf", new Uint8Array([1, 2, 3]), "application/pdf");
    await s.put("companyA/app2/y.docx", new Uint8Array([4]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    await s.put("companyB/app3/z.pdf", new Uint8Array([5, 6]), "application/pdf");
    expect(await s.head("companyA/app1/x.pdf")).toEqual({ size: 3, contentType: "application/pdf" });
    expect(await s.list("companyA/")).toEqual(["companyA/app1/x.pdf", "companyA/app2/y.docx"]);
    expect(await s.list("companyB/")).toEqual(["companyB/app3/z.pdf"]);
    await s.delete("companyA/app1/x.pdf");
    await s.delete("companyA/app1/x.pdf");
    expect(await s.get("companyA/app1/x.pdf")).toBeNull();
    expect(await s.head("companyA/app1/x.pdf")).toBeNull();
    expect(s.browserOrigins()).toEqual([]);
  });

  it("issues single-object, single-method, expiring grants that refuse tampering", async () => {
    const signer = new GrantSigner("test-secret", "http://localhost:3001");
    const s = new MemoryStorageAdapter(signer);
    const up = await s.createUploadUrl("companyA/app1/q.pdf", { contentType: "application/pdf", expiresSeconds: 300 });
    expect(up.method).toBe("PUT");
    expect(up.headers["content-type"]).toBe("application/pdf");
    expect(up.url.startsWith("http://localhost:3001/files/put/")).toBe(true);
    const token = up.url.split("/files/put/")[1]!;
    const payload = signer.verify(token);
    expect(payload).toMatchObject({ k: "companyA/app1/q.pdf", m: "PUT", ct: "application/pdf" });
    // tampered body, tampered signature, wrong method for the route, expired
    const [body, mac] = token.split(".");
    expect(signer.verify(`${Buffer.from(JSON.stringify({ k: "companyB/other", m: "PUT", ct: "application/pdf", exp: payload!.exp })).toString("base64url")}.${mac}`)).toBeNull();
    expect(signer.verify(`${body}.${mac!.slice(0, -2)}AA`)).toBeNull();
    expect(signer.verify(token, new Date(Date.now() + 301_000))).toBeNull();
    expect(new GrantSigner("another-secret", "http://localhost:3001").verify(token)).toBeNull();
    const down = await s.createDownloadUrl("companyA/app1/q.pdf", { expiresSeconds: 120, filename: "résumé.pdf", contentType: "application/pdf" });
    expect(signer.verify(down.url.split("/files/get/")[1]!)).toMatchObject({ m: "GET", fn: "résumé.pdf" });
  });

  it("refuses the types a real bucket would refuse once told its list (opt-in; off, every type is taken as before)", async () => {
    // the résumé types of docs/runbooks/resume-storage.md
    const resumeTypes = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "text/markdown"];
    const open = new MemoryStorageAdapter();
    await open.put("quarantine/co/role/u1.read.json", new Uint8Array([123, 125]), "application/json");
    await open.put("co/logo/logo.png", new Uint8Array([1]), "image/png");
    expect(open.has("quarantine/co/role/u1.read.json") && open.has("co/logo/logo.png")).toBe(true);
    const s = new MemoryStorageAdapter().allowTypes(resumeTypes);
    for (const t of [...resumeTypes, "text/plain; charset=utf-8", "Application/PDF"]) await s.put(`co/${t.length}.x`, new Uint8Array([1]), t);
    for (const t of ["application/json", "image/png", "application/octet-stream", "application/msword"]) {
      const err = (await s.put("co/refused", new Uint8Array([1]), t).then(() => null, (e: unknown) => e)) as StorageError | null;
      expect(err?.httpStatus, t).toBe(415);
      expect(err?.message).toBe("storage put failed with HTTP 415");
    }
    expect(s.has("co/refused")).toBe(false);
    // the list can be lifted again
    await s.allowTypes(null).put("co/refused", new Uint8Array([1]), "application/json");
    expect(s.has("co/refused")).toBe(true);
  });
});

describe("Supabase storage adapter (S3 protocol)", () => {
  it("puts with a signed request, the body hash and the content type, path-style, and never sends the secret", async () => {
    const { fetch, seen } = fakeFetch(() => new Response("", { status: 200 }));
    const s = new SupabaseStorageAdapter({ ...cfg, fetch });
    expect(s.status).toBe("awaiting_verification");
    const body = new TextEncoder().encode("%PDF-1.4 hello %%EOF");
    await s.put("companyA/app1/f.pdf", body, "application/pdf");
    expect(s.status).toBe("live");
    const req = seen[0]!;
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3/resumes/companyA/app1/f.pdf");
    expect(req.headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(body).digest("hex"));
    expect(req.headers["content-type"]).toBe("application/pdf");
    expect(req.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-west-2\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(JSON.stringify(req)).not.toContain(SECRET);
  });

  it("reads, heads and deletes; a missing object is null or a no-op, other failures name the operation and status only", async () => {
    const { fetch } = fakeFetch((req) => {
      if (req.url.endsWith("/missing.pdf")) return new Response("", { status: 404 });
      if (req.url.endsWith("/broken.pdf")) return new Response("", { status: 500 });
      if (req.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "42", "content-type": "application/pdf" } });
      if (req.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(new Uint8Array([9, 9]), { status: 200 });
    });
    const s = new SupabaseStorageAdapter({ ...cfg, fetch });
    expect(await s.get("a/missing.pdf")).toBeNull();
    expect(await s.head("a/missing.pdf")).toBeNull();
    await expect(s.delete("a/missing.pdf")).resolves.toBeUndefined();
    expect(await s.head("a/there.pdf")).toEqual({ size: 42, contentType: "application/pdf" });
    expect([...(await s.get("a/there.pdf"))!]).toEqual([9, 9]);
    await expect(s.get("a/broken.pdf")).rejects.toMatchObject({ operation: "get", httpStatus: 500 });
    let message = "";
    try {
      await s.put("a/broken.pdf", new Uint8Array([1]), "application/pdf");
    } catch (e) {
      message = (e as StorageError).message;
    }
    expect(message).toBe("storage put failed with HTTP 500");
  });

  it("asks for an uncompressed head, and reads the size from the first byte's range when a proxy drops the length", async () => {
    const sizes: Record<string, number> = { "a/notes.txt": 838, "a/empty.txt": 0 };
    const { fetch, seen } = fakeFetch((req) => {
      const name = new URL(req.url).pathname.split("/resumes/")[1]!;
      if (req.method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "text/plain" } });
      if (name === "a/whole.txt") return new Response(new Uint8Array(17), { status: 200 });
      if (name === "a/gone.txt") return new Response("", { status: 404 });
      const size = sizes[name]!;
      if (size === 0) return new Response("", { status: 416 });
      return new Response(new Uint8Array(1), { status: 206, headers: { "content-range": `bytes 0-0/${size}` } });
    });
    const s = new SupabaseStorageAdapter({ ...cfg, fetch });
    expect(await s.head("a/notes.txt")).toEqual({ size: 838, contentType: "text/plain" });
    expect(seen[0]!.headers["accept-encoding"]).toBe("identity");
    expect(seen[0]!.headers.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date,");
    expect(seen[1]!).toMatchObject({ method: "GET", headers: { range: "bytes=0-0", "accept-encoding": "identity" } });
    expect(seen[1]!.headers.authorization).toContain("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,");
    expect(await s.head("a/empty.txt")).toEqual({ size: 0, contentType: "text/plain" });
    expect(await s.head("a/whole.txt")).toEqual({ size: 17, contentType: "text/plain" });
    expect(await s.head("a/gone.txt")).toBeNull();
  });

  it("lists a prefix across continuation pages and decodes XML-escaped keys", async () => {
    const { fetch, seen } = fakeFetch((req) => {
      const u = new URL(req.url);
      expect(u.searchParams.get("list-type")).toBe("2");
      expect(u.searchParams.get("prefix")).toBe("companyA/");
      if (!u.searchParams.get("continuation-token")) return new Response(`<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;1</NextContinuationToken><Contents><Key>companyA/a&amp;b.pdf</Key></Contents><Contents><Key>companyA/c.docx</Key></Contents></ListBucketResult>`);
      expect(u.searchParams.get("continuation-token")).toBe("tok&1");
      return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>companyA/d.txt</Key></Contents></ListBucketResult>`);
    });
    const s = new SupabaseStorageAdapter({ ...cfg, fetch });
    expect(await s.list("companyA/")).toEqual(["companyA/a&b.pdf", "companyA/c.docx", "companyA/d.txt"]);
    expect(seen.length).toBe(2);
    expect(seen[0]!.url.startsWith("https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3/resumes/?")).toBe(true);
  });

  it("issues presigned single-object URLs: PUT pinned to a content type for minutes, GET as a named attachment", async () => {
    const s = new SupabaseStorageAdapter(cfg);
    const up = await s.createUploadUrl("companyA/app1/q.pdf", { contentType: "application/pdf", expiresSeconds: 300 });
    const u = new URL(up.url);
    expect(u.origin).toBe("https://abcdefghijklmnopqrst.storage.supabase.co");
    expect(u.pathname).toBe("/storage/v1/s3/resumes/companyA/app1/q.pdf");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(u.searchParams.get("X-Amz-Credential")).toMatch(/^AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-west-2\/s3\/aws4_request$/);
    expect(up.headers).toEqual({ "content-type": "application/pdf" });
    expect(up.url).not.toContain(SECRET);
    expect(Date.parse(up.expiresAt) - Date.now()).toBeGreaterThan(290_000);
    const down = await s.createDownloadUrl("companyA/app1/q.pdf", { expiresSeconds: 120, filename: 'Dana "Example" résumé.pdf', contentType: "application/pdf" });
    const d = new URL(down.url);
    expect(d.searchParams.get("response-content-disposition")).toBe('attachment; filename="Dana _Example_ r_sum_.pdf"');
    expect(d.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(d.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(s.browserOrigins()).toEqual(["https://abcdefghijklmnopqrst.storage.supabase.co"]);
  });

  it("refuses to start without every setting, naming the variable and never a value", () => {
    expect(() => new SupabaseStorageAdapter({ ...cfg, secretAccessKey: "" })).toThrow(/secretAccessKey is not configured/);
    expect(() => createIntegrations({ STORAGE_PROVIDER: "supabase", STORAGE_S3_ENDPOINT: cfg.endpoint })).toThrow(/STORAGE_S3_REGION, STORAGE_BUCKET, STORAGE_S3_ACCESS_KEY_ID, STORAGE_S3_SECRET_ACCESS_KEY/);
    expect(() => createIntegrations({ STORAGE_PROVIDER: "s3" })).toThrow(/not a known storage provider/);
  });

  it("is wired by STORAGE_PROVIDER and reports its own status, and the scanner reports fake", () => {
    const i = createIntegrations({ STORAGE_PROVIDER: "supabase", STORAGE_S3_ENDPOINT: cfg.endpoint, STORAGE_S3_REGION: cfg.region, STORAGE_BUCKET: cfg.bucket, STORAGE_S3_ACCESS_KEY_ID: cfg.accessKeyId, STORAGE_S3_SECRET_ACCESS_KEY: cfg.secretAccessKey });
    expect(i.storage.id).toBe("supabase_storage");
    expect(i.statuses().find((s) => s.kind === "storage")).toEqual({ kind: "storage", provider: "supabase_storage", status: "awaiting_verification" });
    expect(i.statuses().find((s) => s.kind === "scanner")).toEqual({ kind: "scanner", provider: "fake_scanner", status: "fake" });
    const m = createIntegrations({ STORAGE_PROVIDER: "memory" });
    expect(m.statuses().find((s) => s.kind === "storage")).toEqual({ kind: "storage", provider: "memory", status: "fake" });
  });
});
