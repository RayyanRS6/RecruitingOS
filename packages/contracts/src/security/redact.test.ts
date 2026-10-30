import { describe, expect, it } from "vitest";
import { redactDatabaseValues, redactObject, redactText, withoutDatabaseValues } from "./redact";

/**
 * Audit OPS-2: the values a failed query carries (a candidate's name and address in drizzle's "params:" list, the key
 * or the row a constraint names) never reach a log line, an error report, a job's or a step's last error, an alert or
 * an event. The statement and the database's reason stay, so the fault can still be found and fixed.
 */
describe("database values in error text", () => {
  const NAME = "Nia Brooks";
  const EMAIL = "nia.brooks@example.com";
  const PERSON = /Nia Brooks|nia\.brooks@example\.com/;
  const SQL = 'insert into "candidates" ("first_name", "email") values ($1, $2)';
  const REASON = 'duplicate key value violates unique constraint "candidates_company_email_key"';

  /** What drizzle-orm 0.45 throws for a failed query (DrizzleQueryError: query, params, the driver's error as its cause). */
  function failedQuery(): Error {
    const cause = Object.assign(new Error(REASON), { code: "23505", constraint: "candidates_company_email_key", detail: `Key (company_id, email)=(0192a6b2-0000-7aaa-8bbb-000000000001, ${EMAIL}) already exists.` });
    return Object.assign(new Error(`Failed query: ${SQL}\nparams: ${[NAME, EMAIL]}`, { cause }), { query: SQL, params: [NAME, EMAIL] });
  }

  it("cuts drizzle's parameter list and keeps the statement", () => {
    expect(redactDatabaseValues(`Failed query: ${SQL}\nparams: ${NAME},${EMAIL}`)).toBe(`Failed query: ${SQL}\nparams: [redacted]`);
    // in a stack the list runs to the first frame: a value over several lines goes too, even one shaped like a frame
    const frames = "\n    at PgPreparedQuery.queryWithCache (file:///app/node_modules/drizzle-orm/pg-core/session.js:41:15)\n    at async runClaimed (file:///app/packages/workflows/src/engine.ts:312:9)";
    expect(redactDatabaseValues(`Error: Failed query: ${SQL}\nparams: ${NAME},Dental assistant\n    at Harbor Dental (2019-2024)\n${EMAIL}${frames}`)).toBe(`Error: Failed query: ${SQL}\nparams: [redacted]${frames}`);
  });

  it("cuts the values Postgres names in a detail or a message, and keeps the reason", () => {
    expect(redactDatabaseValues(`Key (email)=(${EMAIL}) already exists.`)).toBe("Key (email)=([redacted]) already exists.");
    expect(redactDatabaseValues(`Key (company_id, lower(email::text))=(0192a6b2-0000-7aaa-8bbb-000000000001, ${NAME} (Nia)) already exists.`)).toBe("Key (company_id, lower(email::text))=([redacted]) already exists.");
    expect(redactDatabaseValues('Key (candidate_id)=(0192a6b2-0000-7aaa-8bbb-000000000001) is not present in table "candidates".')).toBe('Key (candidate_id)=([redacted]) is not present in table "candidates".');
    expect(redactDatabaseValues(`Key (email)=(${EMAIL}) conflicts with existing key (email)=(${EMAIL.toUpperCase()}).`)).toBe("Key (email)=([redacted]) conflicts with existing key (email)=([redacted]).");
    expect(redactDatabaseValues(`Failing row contains (0192a6b2-0000-7aaa-8bbb-000000000001, ${NAME} (Nia), ${EMAIL}, null).`)).toBe("Failing row contains ([redacted]).");
    expect(redactDatabaseValues(`${REASON}: Failing row contains (${NAME}, a note\nover two lines (really)). Check the form.`)).toBe(`${REASON}: Failing row contains ([redacted]). Check the form.`);
    expect(redactDatabaseValues(`invalid input syntax for type uuid: "${EMAIL}"`)).toBe('invalid input syntax for type uuid: "[redacted]"');
    expect(redactDatabaseValues(`invalid input value for enum application_stage: "${NAME}"`)).toBe('invalid input value for enum application_stage: "[redacted]"');
    expect(redactDatabaseValues('value "5551234567" is out of range for type integer')).toBe('value "[redacted]" is out of range for type integer');
  });

  it("leaves other text alone, and cutting twice changes nothing", () => {
    for (const text of [
      "job 42 for run 883953f4-6105-42a2-a16a-77a8eac79483 at 2026-09-30T12:00:00Z timed out",
      'provider error: 529 {"type":"overloaded_error"}',
      REASON,
      "a primary key (id) on jobs",
      "this worker build does not know workflow screen",
    ]) expect(redactDatabaseValues(text)).toBe(text);
    const once = redactDatabaseValues(`Failed query: ${SQL}\nparams: ${NAME}\nKey (email)=(${EMAIL}) already exists.`);
    expect(once).not.toMatch(PERSON);
    expect(redactDatabaseValues(once)).toBe(once);
  });

  it("copies an error without its values: the name, the statement, the stack's frames and the database's reason stay", () => {
    const err = failedQuery();
    const copy = withoutDatabaseValues(err) as Error;
    expect(copy).not.toBe(err);
    expect(copy.name).toBe("Error");
    expect(copy.message).toBe(`Failed query: ${SQL}\nparams: [redacted]`);
    expect(copy.stack).toContain(`Failed query: ${SQL}\nparams: [redacted]\n    at `);
    expect(copy.stack).toContain("redact.test.ts"); // the frames stay
    const cause = copy.cause as Error;
    expect(cause.message).toBe(REASON);
    // nothing else is copied: not drizzle's list, not the driver's detail
    expect("params" in copy).toBe(false);
    expect("query" in copy).toBe(false);
    expect("detail" in cause).toBe(false);
    expect(`${copy.message}${copy.stack}${cause.message}${cause.stack}`).not.toMatch(PERSON);
    // the error itself is left as it was
    expect(err.message).toContain(EMAIL);
    // a name a reporter groups by is kept; a text comes back cut; anything else as it is
    class DeliberateTestError extends Error {
      name = "DeliberateTestError";
    }
    expect((withoutDatabaseValues(new DeliberateTestError("boom")) as Error).name).toBe("DeliberateTestError");
    expect(withoutDatabaseValues(`Failed query: select $1\nparams: ${EMAIL}`)).toBe("Failed query: select $1\nparams: [redacted]");
    expect(withoutDatabaseValues(42)).toBe(42);
  });

  it("the shared scrubber cuts them too, and a scrubbed error keeps its cause", () => {
    const logged = redactObject(failedQuery()) as { name: string; message: string; stack?: string; cause?: { message: string } };
    expect(logged.message).toBe(`Failed query: ${SQL}\nparams: [redacted]`);
    expect(logged.cause?.message).toBe(REASON);
    expect(JSON.stringify(logged)).not.toMatch(PERSON);
    expect(redactText(`Key (email)=(${EMAIL}) already exists. token sk-ant-api03-DELIBERATE-TEST-VALUE-0000000000000000`)).toBe("Key (email)=([redacted]) already exists. token [redacted]");
  });
});
