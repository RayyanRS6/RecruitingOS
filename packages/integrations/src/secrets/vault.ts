import type { SecretStore, SqlExecutor } from "./types";

/**
 * Supabase Vault: secrets are encrypted at rest with keys Supabase manages (libsodium via pgsodium); the database
 * never stores the key. `vault.decrypted_secrets` is readable only by roles granted it (the worker), see
 * packages/db/scripts/vault-grants.sql. Every call is a parameterised statement; values are never logged.
 */
export class SupabaseVaultSecretStore implements SecretStore {
  readonly id = "supabase_vault";
  readonly status = "live" as const;
  constructor(private exec: SqlExecutor) {}

  async put(name: string, value: string, description = ""): Promise<{ ref: string }> {
    const rows = await this.exec("select vault.create_secret($1, $2, $3) as id", [value, name, description]);
    const id = rows[0]?.id;
    if (typeof id !== "string") throw new Error("vault.create_secret returned no id");
    return { ref: id };
  }

  async get(ref: string): Promise<string | null> {
    const rows = await this.exec("select decrypted_secret from vault.decrypted_secrets where id = $1", [ref]);
    const v = rows[0]?.decrypted_secret;
    return typeof v === "string" ? v : null;
  }

  async rotate(ref: string, value: string): Promise<void> {
    await this.exec("select vault.update_secret($1, $2)", [ref, value]);
  }

  async delete(ref: string): Promise<void> {
    await this.exec("delete from vault.secrets where id = $1", [ref]);
  }
}
