import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { connectionConfig, tlsOptionsFromEnv } from "./client";
import { smallPool } from "./cli/provisioning";

/** A real, public certificate (the authority the staging pooler presents on 22 Sep 2026), used only to prove PEM handling; the application trusts what the founder downloads. */
const PEM = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----`;
/** What the driver receives: the certificate normalised to one trailing newline. */
const NORM = `${PEM.trim()}\n`;
const TRUST = { ca: NORM, rejectUnauthorized: true as const };
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
    expect(cfg.ssl).toEqual(TRUST);
    expect(sslSeenByPg(cfg)).toEqual(TRUST);
    const pool = smallPool(URL_MODE, { DATABASE_SSL_CA: PEM });
    expect((pool as unknown as { options: { ssl?: unknown } }).options.ssl).toEqual(TRUST);
    void pool.end();
  });
  it("reads DATABASE_SSL_CA_FILE and DATABASE_SSL_CA, and an sslrootcert named in the string", () => {
    const dir = mkdtempSync(join(tmpdir(), "ros-tls-"));
    const file = join(dir, "ca.crt");
    writeFileSync(file, PEM);
    expect(tlsOptionsFromEnv({ DATABASE_SSL_CA_FILE: file })).toEqual(TRUST);
    expect(tlsOptionsFromEnv({ DATABASE_SSL_CA: PEM })).toEqual(TRUST);
    expect(tlsOptionsFromEnv({})).toBeUndefined();
    const cfg = connectionConfig(`${URL_MODE}&sslrootcert=${encodeURIComponent(file)}`, undefined);
    expect(cfg.ssl).toEqual(TRUST);
    expect(cfg.connectionString).not.toContain("sslrootcert");
  });
  it("without a certificate the string is left alone, and every way of switching TLS off is refused, certificate or not", () => {
    expect(connectionConfig(URL_MODE, undefined)).toEqual({ connectionString: URL_MODE });
    for (const bad of ["sslmode=disable", "sslmode=no-verify", "ssl=0", "ssl=false", "ssl=no-verify", "uselibpqcompat=true&sslmode=require"]) {
      expect(() => connectionConfig(`postgresql://u:pass@h.example.com/db?${bad}`, { ca: PEM, rejectUnauthorized: true })).toThrow(/not allowed/);
      expect(() => connectionConfig(`postgresql://u:pass@h.example.com/db?${bad}`, undefined)).toThrow(/not allowed/);
    }
  });
  it("the driver's own ssl parameter cannot override the certificate either", () => {
    for (const q of ["ssl=true", "ssl=1", "sslmode=verify-full&ssl=true"]) {
      const cfg = connectionConfig(`postgresql://u:pass@h.example.com/db?${q}`, { ca: PEM, rejectUnauthorized: true });
      expect(cfg.connectionString).not.toMatch(/ssl/);
      expect(sslSeenByPg(cfg)).toEqual(TRUST);
    }
  });
  it("an explicit certificate wins over sslrootcert unless the two differ, and a bad string never leaks the password", () => {
    const dir = mkdtempSync(join(tmpdir(), "ros-tls-"));
    const same = join(dir, "same.crt");
    writeFileSync(same, PEM);
    expect(connectionConfig(`${URL_MODE}&sslrootcert=${encodeURIComponent(same)}`, { ca: PEM, rejectUnauthorized: true }).ssl).toEqual(TRUST);
    expect(() => connectionConfig(`${URL_MODE}&sslrootcert=${encodeURIComponent(join(dir, "missing.crt"))}`, undefined)).toThrow(/could not be read/);
    let message = "";
    try {
      connectionConfig("postgresql://u:s3cret-pass@h.example.com:54a32/db", undefined);
    } catch (e) {
      message = `${(e as Error).message} ${JSON.stringify(e)}`;
    }
    expect(message).toContain("not a valid URL");
    expect(message).not.toContain("s3cret");
  });
  it("normalises a pasted certificate: Windows line endings, a trailing newline, or a one-line value with literal backslash-n", () => {
    const crlf = PEM.replace(/\n/g, "\r\n");
    const oneLine = PEM.trim().replace(/\n/g, "\\n");
    for (const shape of [PEM, `${PEM}\n\n`, crlf, oneLine]) {
      const t = tlsOptionsFromEnv({ DATABASE_SSL_CA: shape });
      expect(t?.ca).toBe(NORM);
      expect(sslSeenByPg(connectionConfig(URL_MODE, t))).toEqual(TRUST);
    }
    expect(() => tlsOptionsFromEnv({ DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" })).toThrow(/not a certificate this runtime can parse/);
    expect(() => tlsOptionsFromEnv({ DATABASE_SSL_CA: "hello" })).toThrow(/not a PEM certificate/);
  });
});
