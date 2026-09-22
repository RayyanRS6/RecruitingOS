import pg from "pg";
import { describe, expect, it } from "vitest";
import { ConnectionStringError, countPlaceholders, fillPassword, PASSWORD_PLACEHOLDER, percentEncodePassword } from "./cli/connection-string";

const POOLER = "postgresql://postgres.abcdefghijklmnopqrst:[YOUR-PASSWORD]@aws-0-us-west-2.pooler.supabase.com:5432/postgres";

/** What a Postgres client will send as the password: the same parsing pg does when handed the connection string. */
function passwordSeenByPg(connectionString: string): string {
  return String(new pg.Client({ connectionString }).password);
}

describe("percentEncodePassword", () => {
  it("leaves unreserved characters alone", () => {
    expect(percentEncodePassword("AZaz09-._~")).toBe("AZaz09-._~");
  });
  it("encodes every reserved and special character as uppercase %XX", () => {
    expect(percentEncodePassword("@:/?#%&+= ")).toBe("%40%3A%2F%3F%23%25%26%2B%3D%20");
    expect(percentEncodePassword("[]!$'()*,;\"\\<>^`{|}")).toBe("%5B%5D%21%24%27%28%29%2A%2C%3B%22%5C%3C%3E%5E%60%7B%7C%7D");
  });
  it("encodes non-ASCII characters byte by byte as UTF-8", () => {
    expect(percentEncodePassword("é")).toBe("%C3%A9");
    expect(percentEncodePassword("pässwörd€")).toBe("p%C3%A4ssw%C3%B6rd%E2%82%AC");
  });
  it("round-trips through the URL decoder", () => {
    for (const pw of ["p@ss:w/ord?#%&+ ", "100%sure", "ünïcödé 🔐", "a[b]c{d}e", "tab\tand\"quote'"]) expect(decodeURIComponent(percentEncodePassword(pw))).toBe(pw);
  });
});

describe("countPlaceholders", () => {
  it("counts exact, case-sensitive occurrences only", () => {
    expect(countPlaceholders(POOLER)).toBe(1);
    expect(countPlaceholders(POOLER.replace(PASSWORD_PLACEHOLDER, "[your-password]"))).toBe(0);
    expect(countPlaceholders(POOLER.replace(PASSWORD_PLACEHOLDER, "YOUR-PASSWORD"))).toBe(0);
    expect(countPlaceholders(`${POOLER}?options=${PASSWORD_PLACEHOLDER}`)).toBe(2);
    expect(countPlaceholders("")).toBe(0);
  });
});

describe("fillPassword", () => {
  it("replaces the placeholder with the encoded password and nothing else", () => {
    const out = fillPassword(POOLER, "pass");
    expect(out).toBe("postgresql://postgres.abcdefghijklmnopqrst:pass@aws-0-us-west-2.pooler.supabase.com:5432/postgres");
  });

  it.each([
    ["at sign and colon", "p@ss:word"],
    ["slash, question mark and hash", "a/b?c#d"],
    ["percent, ampersand, plus and equals", "100%&+=done"],
    ["spaces", "two words here"],
    ["brackets, braces and quotes", "[x]{y}\"z'"],
    ["backslash, angle brackets and pipe", "a\\b<c>d|e"],
    ["accented letters", "pässwörd"],
    ["emoji", "lock🔐key"],
    ["the placeholder text itself", "[YOUR-PASSWORD]x"],
    ["a dollar-and-ampersand replacement pattern", "$&$1$$"],
    ["every printable ASCII symbol", "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"],
  ])("keeps a password with %s intact for the Postgres client", (_label, password) => {
    const out = fillPassword(POOLER, password);
    expect(countPlaceholders(out)).toBe(0);
    const url = new URL(out);
    expect(url.username).toBe("postgres.abcdefghijklmnopqrst");
    expect(url.hostname).toBe("aws-0-us-west-2.pooler.supabase.com");
    expect(url.port).toBe("5432");
    expect(url.pathname).toBe("/postgres");
    expect(decodeURIComponent(url.password)).toBe(password);
    expect(passwordSeenByPg(out)).toBe(password);
    // The raw password never appears when it holds a character that needs encoding.
    if (percentEncodePassword(password) !== password) expect(out).not.toContain(password);
  });

  it("trims surrounding whitespace from a pasted string", () => {
    expect(fillPassword(`  ${POOLER}\n`, "x")).toBe(POOLER.replace(PASSWORD_PLACEHOLDER, "x"));
  });

  it("accepts the postgres:// form and keeps query parameters", () => {
    const out = fillPassword("postgres://u:[YOUR-PASSWORD]@h.example.com:5432/db?sslmode=require", "p@ss");
    expect(out).toBe("postgres://u:p%40ss@h.example.com:5432/db?sslmode=require");
  });

  it("refuses a string without the placeholder", () => {
    expect(() => fillPassword(POOLER.replace(PASSWORD_PLACEHOLDER, "already-filled"), "x")).toThrow(ConnectionStringError);
    expect(() => fillPassword(POOLER.replace(PASSWORD_PLACEHOLDER, "[your-password]"), "x")).toThrow(/exactly once \(found 0\)/);
  });

  it("refuses a string with the placeholder more than once", () => {
    expect(() => fillPassword(`${POOLER}?application_name=${PASSWORD_PLACEHOLDER}`, "x")).toThrow(/exactly once \(found 2\)/);
  });

  it("refuses an empty password and a non-Postgres string", () => {
    expect(() => fillPassword(POOLER, "")).toThrow(/empty/);
    expect(() => fillPassword("mysql://u:[YOUR-PASSWORD]@h/db", "x")).toThrow(/postgresql:\/\//);
    expect(() => fillPassword("[YOUR-PASSWORD]", "x")).toThrow(/postgresql:\/\//);
  });

  it("never puts the password or the string into an error message", () => {
    const password = "s3cret@value";
    for (const uri of [POOLER.replace(PASSWORD_PLACEHOLDER, "gone"), `${POOLER}${PASSWORD_PLACEHOLDER}`, "postgresql://[YOUR-PASSWORD]"]) {
      let message = "";
      try {
        fillPassword(uri, password);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(password);
      expect(message).not.toContain("abcdefghijklmnopqrst");
    }
  });
});
