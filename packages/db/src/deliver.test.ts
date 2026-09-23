import { describe, expect, it } from "vitest";
import { deliverToClipboard, type DeliveryIo } from "./cli/deliver";

/** answers: a string is a typed line; "EOF" ends the input; null never answers (timeout). */
function fakeIo(answers: Array<string | null>, opts: { timeoutMs?: number; failCopyAt?: number } = {}) {
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
  };
  return { io, copies, said, clears: () => clears, closes: () => closes };
}
const VALUES = [
  { name: "DATABASE_URL", value: "postgresql://ros_app.ref:pass@h.example.com:5432/postgres", where: "It goes into Vercel later." },
  { name: "WORKER_DATABASE_URL", value: "postgresql://ros_worker.ref:pass@h.example.com:5432/postgres", where: "It goes into Railway later." },
];
const noValueSaid = (said: string[]) => { for (const line of said) for (const v of VALUES) expect(line).not.toContain(v.value); };

describe("clipboard delivery of secrets", () => {
  it("copies each value in turn, accepts only the confirmation word, clears once at the end, releases the input, and never says a value", async () => {
    const f = fakeIo(["", "PASTED", "no", "pasted "]);
    const r = await deliverToClipboard(VALUES, f.io);
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
  it("clears the clipboard and stops when nobody confirms in time", async () => {
    const f = fakeIo(["pasted", null]);
    const r = await deliverToClipboard(VALUES, f.io);
    expect(r).toEqual({ delivered: ["DATABASE_URL"], timedOut: true });
    expect(f.clears()).toBe(1);
    expect(f.closes()).toBe(1);
    expect(f.said.at(-1)).toContain("clipboard was cleared");
    noValueSaid(f.said);
  });
  it("treats the input ending (window closed) as no confirmation", async () => {
    const f = fakeIo(["EOF"]);
    const r = await deliverToClipboard(VALUES, f.io);
    expect(r).toEqual({ delivered: [], timedOut: true });
    expect(f.clears()).toBe(1);
    expect(f.closes()).toBe(1);
  });
  it("a failing copy still clears the clipboard and releases the input, and the error carries no value", async () => {
    const f = fakeIo(["pasted"], { failCopyAt: 1 });
    let message = "";
    try {
      await deliverToClipboard(VALUES, f.io);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("pbcopy exited with 1");
    expect(f.clears()).toBe(1);
    expect(f.closes()).toBe(1);
    noValueSaid(f.said);
  });
});
