import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StorageAdapter } from "../types";

export class LocalStorageAdapter implements StorageAdapter {
  readonly id = "local";
  constructor(private dir: string) {}
  async put(key: string, bytes: Uint8Array): Promise<{ key: string }> {
    const path = join(this.dir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return { key };
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(join(this.dir, key)));
    } catch {
      return null;
    }
  }
  async delete(key: string): Promise<void> {
    await rm(join(this.dir, key), { force: true });
  }
}

export class MemoryStorageAdapter implements StorageAdapter {
  readonly id = "memory";
  private files = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array): Promise<{ key: string }> {
    this.files.set(key, bytes);
    return { key };
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.files.get(key) ?? null;
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
  /** Test helper. */
  has(key: string): boolean {
    return this.files.has(key);
  }
}
