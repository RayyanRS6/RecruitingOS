import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { DownloadGrant, StorageAdapter, StoredObjectInfo, UploadGrant } from "../types";
import { GrantSigner } from "./grants";

function safeJoin(dir: string, key: string): string {
  const path = resolve(dir, key);
  if (!path.startsWith(resolve(dir) + sep)) throw new Error("storage key escapes the storage directory");
  return path;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (!e.name.endsWith(".meta")) out.push(p);
  }
  return out;
}

/** Development only: files under a directory, content types in sidecar files, grants served by the application itself. */
export class LocalStorageAdapter implements StorageAdapter {
  readonly id = "local";
  readonly status = "fake" as const;
  constructor(private dir: string, private signer: GrantSigner) {}
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<{ key: string }> {
    const path = safeJoin(this.dir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    await writeFile(`${path}.meta`, contentType);
    return { key };
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(safeJoin(this.dir, key)));
    } catch {
      return null;
    }
  }
  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const path = safeJoin(this.dir, key);
      const st = await stat(path);
      const contentType = await readFile(`${path}.meta`, "utf8").catch(() => null);
      return { size: st.size, contentType };
    } catch {
      return null;
    }
  }
  async delete(key: string): Promise<void> {
    const path = safeJoin(this.dir, key);
    await rm(path, { force: true });
    await rm(`${path}.meta`, { force: true });
  }
  async list(prefix: string): Promise<string[]> {
    const files = await walk(resolve(this.dir));
    return files.map((f) => relative(resolve(this.dir), f).split(sep).join("/")).filter((k) => k.startsWith(prefix)).sort();
  }
  async createUploadUrl(key: string, opts: { contentType: string; expiresSeconds: number }): Promise<UploadGrant> {
    const exp = Math.floor(Date.now() / 1000) + opts.expiresSeconds;
    return { url: this.signer.url("put", this.signer.sign({ k: key, m: "PUT", ct: opts.contentType, exp })), method: "PUT", headers: { "content-type": opts.contentType }, expiresAt: new Date(exp * 1000).toISOString() };
  }
  async createDownloadUrl(key: string, opts: { expiresSeconds: number; filename: string; contentType: string }): Promise<DownloadGrant> {
    const exp = Math.floor(Date.now() / 1000) + opts.expiresSeconds;
    return { url: this.signer.url("get", this.signer.sign({ k: key, m: "GET", ct: opts.contentType, exp, fn: opts.filename })), expiresAt: new Date(exp * 1000).toISOString() };
  }
  browserOrigins(): string[] {
    return [];
  }
  /** The application's file routes verify grants with this. */
  get grants(): GrantSigner {
    return this.signer;
  }
}

/** Tests and CI: the same contract, in a Map. */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly id = "memory";
  readonly status = "fake" as const;
  private files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  constructor(private signer: GrantSigner = new GrantSigner("dev-only-memory-storage", "http://localhost:3000")) {}
  async put(key: string, bytes: Uint8Array, contentType: string): Promise<{ key: string }> {
    this.files.set(key, { bytes, contentType });
    return { key };
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.files.get(key)?.bytes ?? null;
  }
  async head(key: string): Promise<StoredObjectInfo | null> {
    const f = this.files.get(key);
    return f ? { size: f.bytes.byteLength, contentType: f.contentType } : null;
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.files.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async createUploadUrl(key: string, opts: { contentType: string; expiresSeconds: number }): Promise<UploadGrant> {
    const exp = Math.floor(Date.now() / 1000) + opts.expiresSeconds;
    return { url: this.signer.url("put", this.signer.sign({ k: key, m: "PUT", ct: opts.contentType, exp })), method: "PUT", headers: { "content-type": opts.contentType }, expiresAt: new Date(exp * 1000).toISOString() };
  }
  async createDownloadUrl(key: string, opts: { expiresSeconds: number; filename: string; contentType: string }): Promise<DownloadGrant> {
    const exp = Math.floor(Date.now() / 1000) + opts.expiresSeconds;
    return { url: this.signer.url("get", this.signer.sign({ k: key, m: "GET", ct: opts.contentType, exp, fn: opts.filename })), expiresAt: new Date(exp * 1000).toISOString() };
  }
  browserOrigins(): string[] {
    return [];
  }
  get grants(): GrantSigner {
    return this.signer;
  }
  /** Test helper. */
  has(key: string): boolean {
    return this.files.has(key);
  }
}
