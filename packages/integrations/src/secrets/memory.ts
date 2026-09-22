import { randomUUID } from "node:crypto";
import type { SecretStore } from "./types";

/** Development and tests only: values live in process memory and vanish on exit. Production refuses this store. */
export class MemorySecretStore implements SecretStore {
  readonly id = "memory";
  readonly status = "fake" as const;
  private values = new Map<string, { name: string; value: string }>();

  async put(name: string, value: string): Promise<{ ref: string }> {
    const ref = randomUUID();
    this.values.set(ref, { name, value });
    return { ref };
  }
  async get(ref: string): Promise<string | null> {
    return this.values.get(ref)?.value ?? null;
  }
  async rotate(ref: string, value: string): Promise<void> {
    const cur = this.values.get(ref);
    if (!cur) throw new Error("unknown secret reference");
    this.values.set(ref, { ...cur, value });
  }
  async delete(ref: string): Promise<void> {
    this.values.delete(ref);
  }
  /** Test helper: how many secrets are held. */
  get size(): number {
    return this.values.size;
  }
}
