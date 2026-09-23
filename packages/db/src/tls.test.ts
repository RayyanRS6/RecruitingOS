import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { connectionConfig, tlsOptionsFromEnv } from "./client";
import { smallPool } from "./cli/provisioning";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const URL_MODE = "postgresql://postgres.ref:pass@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=verify-full";

/** What the driver will actually use: node-postgres exposes the merged parameters on a Client. */
function sslSeenByPg(config: pg.ClientConfig): unknown {
  return (new pg.Client(config) as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl;
}

describe("TLS trust reaches the Postgres driver", () => {
  it("documents the driver behaviour that lost the certificate: sslmode in the string overrides an explicit ssl option", () => {
    expect(sslSeenByPg({ connectionString: URL_MODE, ssl: { ca: PEM, rejectUnauthorized: true } })).toEqual({});
  });
  it("with a certificate, the string loses its sslmode and the driver receives the certificate with full verification", () => {
    const cfg = connectionConfig(URL_MODE, { ca: PEM, rejectUnauthorized: true });
    expect(cfg.connectionString).not.toContain("sslmode");
    expect(cfg.ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
    expect(sslSeenByPg(cfg)).toEqual({ ca: PEM, rejectUnauthorized: true });
    const pool = smallPool(URL_MODE, { DATABASE_SSL_CA: PEM });
    expect((pool as unknown as { options: { ssl?: unknown } }).options.ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
    void pool.end();
  });
  it("reads DATABASE_SSL_CA_FILE and DATABASE_SSL_CA, and an sslrootcert named in the string", () => {
    const dir = mkdtempSync(join(tmpdir(), "ros-tls-"));
    const file = join(dir, "ca.crt");
    writeFileSync(file, PEM);
    expect(tlsOptionsFromEnv({ DATABASE_SSL_CA_FILE: file })).toEqual({ ca: PEM, rejectUnauthorized: true });
    expect(tlsOptionsFromEnv({ DATABASE_SSL_CA: PEM })).toEqual({ ca: PEM, rejectUnauthorized: true });
    expect(tlsOptionsFromEnv({ DATABASE_SSL_CA: "not a certificate" })).toBeUndefined();
    expect(tlsOptionsFromEnv({})).toBeUndefined();
    const cfg = connectionConfig(`${URL_MODE}&sslrootcert=${encodeURIComponent(file)}`, undefined);
    expect(cfg.ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
    expect(cfg.connectionString).not.toContain("sslrootcert");
  });
  it("without a certificate the string is left alone, and switching TLS off is refused", () => {
    expect(connectionConfig(URL_MODE, undefined)).toEqual({ connectionString: URL_MODE });
    expect(() => connectionConfig("postgresql://u:pass@h.example.com/db?sslmode=disable", { ca: PEM, rejectUnauthorized: true })).toThrow(/not allowed/);
    expect(() => connectionConfig("postgresql://u:pass@h.example.com/db?sslmode=disable", undefined)).toThrow(/not allowed/);
  });
});
