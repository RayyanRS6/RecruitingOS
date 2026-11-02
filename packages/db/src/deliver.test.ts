import { describe, expect, it } from "vitest";
import { deliverToClipboard, type DeliveryIo, type DeliveryTarget, windowsClipboardArgs } from "./cli/deliver";
import { dbEnvironmentFrom } from "./cli/environment";

/** answers: a string is a typed line; "EOF" ends the input; null never answers (timeout). */
function fakeIo(answers: Array<string | null>, opts: { timeoutMs?: number; failCopyAt?: number; notes?: DeliveryIo["notes"] } = {}) {
  const copies: string[] = [];
  const said: string[] = [];
  let clears = 0;
  let closes = 0;
  let i = 0;
  const io: DeliveryIo = {
    copy: async (t) => { if (opts.failCopyAt === copies.length) throw new Error("pbcopy exited with 1"); copies.push(t); },
    clear: async () => { clears++; },
    ask: () => { const a = answers[i++]; return a === null ? new Promise<string | null>(() => undefined) : a === "EOF" ? Promise.resolve(null) : Promise.resolve(a ?? ""); },
    say: (l) => { said.push(l); },
    close: () => { closes++; },
    timeoutMs: opts.timeoutMs ?? 50,
    notes: opts.notes,
  };
  return { io, copies, said, clears: () => clears, closes: () => closes };
}
const VALUES = [
  { name: "DATABASE_URL", value: "postgresql://ros_app.ref:pass@h.example.com:5432/postgres", where: "It goes into Vercel later." },
  { name: "WORKER_DATABASE_URL", value: "postgresql://ros_worker.ref:pass@h.example.com:5432/postgres", where: "It goes into Railway later." },
];
const noValueSaid = (said: string[]) => { for (const line of said) for (const v of VALUES) expect(line).not.toContain(v.value); };
function target(env: Record<string, string>): DeliveryTarget {
  const r = dbEnvironmentFrom(env);
  if (!r.ok) throw new Error(r.error);
  return r.target;
}
const STAGING = target({ ROS_DB_ENV: "staging" });
const PRODUCTION = target({ ROS_DB_ENV: "production", ROS_DB_PROJECT_REF: "abcdefghijklmnopqrst" });

describe("clipboard delivery of secrets", () => {
  it("copies each value in turn, accepts only the confirmation word, clears once at the end, releases the input, and never says a value", async () => {
    const f = fakeIo(["", "PASTED", "no", "pasted "]);
    const r = await deliverToClipboard(VALUES, f.io, STAGING);
    expect(r).toEqual({ delivered: ["DATABASE_URL", "WORKER_DATABASE_URL"], timedOut: false });
    expect(f.copies).toEqual(VALUES.map((v) => v.value));
    expect(f.clears()).toBe(1);
    expect(f.closes()).toBe(1);
    noValueSaid(f.said);
    expect(f.said.filter((l) => l.startsWith("Not yet")).length).toBe(2);
    expect(f.said.some((l) => l.includes("DATABASE_URL is on the clipboard"))).toBe(true);
    expect(f.said.at(-1)).toContain("Clipboard cleared");
    expect(f.said.at(-1)).not.toContain("only in 1Password");
  });
  it("answers a value pasted into the window by mistake without repeating it, and still waits for the confirmation", async () => {
    const f = fakeIo([VALUES[0].value, "pasted", "pasted"]);
    const r = await deliverToClipboard(VALUES, f.io, STAGING);
    expect(r).toEqual({ delivered: ["DATABASE_URL", "WORKER_DATABASE_URL"], timedOut: false });
    expect(f.said.filter((l) => l.startsWith("Not yet: that was not pasted. If it was DATABASE_URL itself, this window shows it now: take no screenshot"))).toHaveLength(1);
    noValueSaid(f.said);
  });
  it("clears the clipboard and stops when nobody confirms in time", async () => {
    const f = fakeIo(["pasted", null]);
    const r = await deliverToClipboard(VALUES, f.io, STAGING);
    expect(r).toEqual({ delivered: ["DATABASE_URL"], timedOut: true });
    expect(f.clears()).toBe(1);
    expect(f.closes()).toBe(1);
    expect(f.said.at(-1)).toContain("clipboard was cleared");
    noValueSaid(f.said);
  });
  it("treats the input ending (window closed) as no confirmation", async () => {
    const f = fakeIo(["EOF"]);
    const r = await deliverToClipboard(VALUES, f.io, STAGING);
    expect(r).toEqual({ delivered: [], timedOut: true });
    expect(f.clears()).toBe(1);
    expect(f.closes()).toBe(1);
  });
  it("a failing copy still clears the clipboard and releases the input, and the error carries no value", async () => {
    const f = fakeIo(["pasted"], { failCopyAt: 1 });
    let message = "";
    try {
      await deliverToClipboard(VALUES, f.io, STAGING);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("pbcopy exited with 1");
    expect(f.clears()).toBe(1);
    expect(f.closes()).toBe(1);
    noValueSaid(f.said);
  });
});

/** Audit GATE-V3 (29 Oct 2026): production strings must never be steered into the staging vault or item. */
describe("where the delivery says to paste", () => {
  it("staging names the staging vault and item, as before", async () => {
    const f = fakeIo(["pasted", "pasted"]);
    await deliverToClipboard(VALUES, f.io, STAGING);
    expect(f.said).toContain('DATABASE_URL is on the clipboard. In 1Password (vault: Recruiting OS Staging), paste it into the field DATABASE_URL of the item "Recruiting OS staging database". It goes into Vercel later.');
  });
  it("production names the production vault and item, and never staging", async () => {
    const f = fakeIo(["pasted", "pasted"]);
    const r = await deliverToClipboard(VALUES, f.io, PRODUCTION);
    expect(r.delivered).toEqual(["DATABASE_URL", "WORKER_DATABASE_URL"]);
    expect(f.said.filter((l) => l.includes('In 1Password (vault: Recruiting OS Production), paste it into the field') && l.includes('of the item "Recruiting OS production database"'))).toHaveLength(2);
    for (const line of f.said) expect(line).not.toMatch(/staging/i);
  });
  it("refuses to deliver without an environment: nothing is copied, the clipboard is cleared and the input released", async () => {
    const f = fakeIo(["pasted", "pasted"]);
    await expect(deliverToClipboard(VALUES, f.io, undefined as unknown as DeliveryTarget)).rejects.toThrow(/ROS_DB_ENV/);
    expect(f.copies).toEqual([]);
    expect(f.clears()).toBe(1);
    expect(f.closes()).toBe(1);
  });
  it("says what this computer's clipboard does besides the paste, before the first copy and after the clear", async () => {
    const f = fakeIo(["pasted", "pasted"], { notes: { before: "Kept out of clipboard history.", after: "Check Win+V." } });
    await deliverToClipboard(VALUES, f.io, PRODUCTION);
    expect(f.said[0]).toBe("Each value is placed on the clipboard in turn, never shown. Kept out of clipboard history.");
    expect(f.said.at(-1)).toBe("Clipboard cleared. Nothing was printed. Check Win+V.");
  });
});

describe("the Windows clipboard helper's command", () => {
  const decode = (args: string[]) => Buffer.from(args.at(-1)!, "base64").toString("utf16le");
  it("runs scripts/lib/clipboard.ps1 in Windows PowerShell's single-threaded apartment, and the value travels on standard input, never in the command", () => {
    const set = windowsClipboardArgs("set", "C:\\repo's copy\\scripts\\lib\\clipboard.ps1");
    expect(set.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    const command = decode(set);
    expect(command).toContain(". 'C:\\repo''s copy\\scripts\\lib\\clipboard.ps1'");
    expect(command).toContain("Set-SecretClipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())))");
    expect(command).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(command).toContain("[Console]::Error.WriteLine('clipboard: ' + $_.Exception.Message); exit 1");
    expect(decode(windowsClipboardArgs("clear", "C:\\x\\clipboard.ps1"))).toContain("Clear-SecretClipboard");
    expect(decode(windowsClipboardArgs("clear", "C:\\x\\clipboard.ps1"))).not.toContain("Set-SecretClipboard");
  });
});
