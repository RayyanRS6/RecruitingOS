import { describe, expect, it } from "vitest";
import { describeConnectionError, diagnoseConnectionError } from "./cli/db-errors";
import { applicationRoleOf, describeCertificate, formatStep, isTransientAuthAfterRotation, roleUrl, vaultGrantStatements, withSsl } from "./cli/provisioning";

const OWNER = "postgresql://postgres.abcdefghijklmnopqrst:pass@aws-0-us-west-2.pooler.supabase.com:5432/postgres";

describe("provisioning helpers", () => {
  it("adds verify-full unless the string already says how to handle TLS", () => {
    expect(withSsl(OWNER).searchParams.get("sslmode")).toBe("verify-full");
    expect(withSsl(`${OWNER}?sslmode=require`).searchParams.get("sslmode")).toBe("require");
    expect(withSsl(`${OWNER}?sslmode=verify-full&sslrootcert=/tmp/ca.crt`).searchParams.get("sslrootcert")).toBe("/tmp/ca.crt");
  });
  it("derives the application role strings: same host and Session pooler port, role in place of the owner, options kept", () => {
    const app = new URL(roleUrl(withSsl(OWNER), "ros_app", "AbC123xyz"));
    expect(app.username).toBe("ros_app.abcdefghijklmnopqrst");
    expect(app.password).toBe("AbC123xyz");
    expect(app.hostname).toBe("aws-0-us-west-2.pooler.supabase.com");
    expect(app.port).toBe("5432");
    expect(app.searchParams.get("sslmode")).toBe("verify-full");
    const worker = new URL(roleUrl(withSsl("postgresql://postgres:pass@db.example.com:5432/postgres"), "ros_worker", "Zz9"));
    expect(worker.username).toBe("ros_worker");
    expect(worker.port).toBe("5432");
  });
  it("reads the Vault grant statements, resolves function signatures at run time, and keeps the API role away from decrypted secrets", () => {
    const s = vaultGrantStatements();
    expect(s.length).toBe(5);
    expect(s.some((x) => /REVOKE SELECT ON vault\.decrypted_secrets FROM ros_app/.test(x))).toBe(true);
    expect(s.some((x) => /pg_proc/.test(x) && /create_secret/.test(x) && /update_secret/.test(x) && /GRANT EXECUTE ON FUNCTION %s/.test(x))).toBe(true);
    expect(s.every((x) => !x.startsWith("--") && !/create_secret\(text, text, text\)/.test(x))).toBe(true);
  });
  it("describes a certificate for the cross-check and recognises the pooler's short-lived refusal after a password change", () => {
    expect(describeCertificate("not a certificate")).toBeNull();
    expect(isTransientAuthAfterRotation({ code: "28P01" })).toBe(true);
    expect(isTransientAuthAfterRotation({ message: "Tenant or user not found" })).toBe(true);
    expect(isTransientAuthAfterRotation({ code: "ENOTFOUND" })).toBe(false);
  });
  it("recognises which application role a complete string is for, and refuses the owner's string and nonsense, without touching the password", () => {
    expect(applicationRoleOf("postgresql://ros_worker.abcdefghijklmnopqrst:pass@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=verify-full\n")).toEqual({ ok: true, role: "ros_worker", host: "aws-0-us-west-2.pooler.supabase.com", port: "5432" });
    expect(applicationRoleOf("postgres://ros_app:pass@db.example.com/postgres")).toEqual({ ok: true, role: "ros_app", host: "db.example.com", port: "5432" });
    expect(applicationRoleOf(OWNER.replace("pass", "x"))).toMatchObject({ ok: false, error: expect.stringMatching(/owner's string/) });
    expect(applicationRoleOf("postgresql://someone:pass@h.example.com/db")).toMatchObject({ ok: false, error: expect.stringMatching(/not an application role/) });
    expect(applicationRoleOf("postgresql://ros_worker.ref@h.example.com/db")).toMatchObject({ ok: false, error: expect.stringMatching(/no password/) });
    expect(applicationRoleOf("mysql://ros_app:pass@h.example.com/db")).toMatchObject({ ok: false, error: expect.stringMatching(/not a Postgres/) });
    expect(applicationRoleOf("not a url")).toMatchObject({ ok: false, error: expect.stringMatching(/not a valid/) });
  });
  it("formats step lines", () => {
    expect(formatStep({ step: "vault grants", state: "skipped", detail: "schema vault is not present" })).toBe("provision: vault grants: skipped (schema vault is not present)");
  });
});

describe("connection error diagnosis (never the string, never the password)", () => {
  const secret = "postgresql://postgres.ref:pass@host.example.com:5432/postgres";
  it.each([
    [{ code: "SELF_SIGNED_CERT_IN_CHAIN", message: "self signed certificate in certificate chain" }, "tls", /Download the CA certificate/],
    [{ code: "ERR_TLS_CERT_ALTNAME_INVALID", message: "Hostname/IP does not match" }, "tls", /Download the CA certificate/],
    [{ code: "28P01", message: `password authentication failed for user "postgres.ref"` }, "auth", /Check the database password/],
    [{ message: "Tenant or user not found" }, "pooler", /<role>\.<project-ref>/],
    [{ code: "ENOTFOUND", message: `getaddrinfo ENOTFOUND ${secret}` }, "network", /paused/],
    [{ code: "42501", message: "permission denied for schema vault" }, "permission", /project owner/],
    [{ code: "3D000", message: `database "nope" does not exist` }, "database", /postgres/],
    [{ code: "53300", message: "too many clients already" }, "pooler", /Wait a minute/],
    [{ message: "(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15" }, "pooler", /Wait a minute/],
    [{ message: "Connection terminated due to connection timeout" }, "pooler", /most likely full/],
    [{ message: "timeout exceeded when trying to connect" }, "pooler", /most likely full/],
    [{ message: "The server does not support SSL connections" }, "tls", /verify-full/],
    [{ code: "XX999", message: `something odd ${secret}` }, "unknown", /Paste the code/],
  ])("classifies %j as %s", (err, kind, advice) => {
    const d = diagnoseConnectionError(err);
    expect(d.kind).toBe(kind);
    expect(d.advice).toMatch(advice);
    expect(describeConnectionError(err)).not.toContain("pass@host");
    expect(describeConnectionError(err).length).toBeLessThan(600);
  });
});
