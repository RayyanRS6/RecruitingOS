import type { AdapterStatus } from "../types";

/**
 * Secrets (OAuth refresh tokens, integration credentials) live in a managed key-management service, never in
 * application-side cryptography (founder decision F1, D21). The application keeps only an opaque reference.
 * Reads are the worker's privilege; the API role can store and delete but cannot decrypt.
 */
export interface SecretStore {
  readonly id: string;
  readonly status: AdapterStatus;
  /** Stores a value; returns the reference the application keeps in its own tables. */
  put(name: string, value: string, description?: string): Promise<{ ref: string }>;
  /** Decrypts a value. Only the worker database role is granted this; the API role receives a permission error. */
  get(ref: string): Promise<string | null>;
  rotate(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

/** A parameterised SQL executor supplied by the application (the store never opens its own connection). */
export type SqlExecutor = (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
