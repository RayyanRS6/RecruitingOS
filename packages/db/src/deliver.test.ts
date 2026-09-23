import { describe, expect, it } from "vitest";
import { deliverToClipboard, type DeliveryIo } from "./cli/deliver";

function fakeIo(answers: Array<string | null>, timeoutMs = 50) {
  const copies: string[] = [];
  const said: string[] = [];
  let clears = 0;
  let i = 0;
  const io: DeliveryIo = {
    copy: async (t) => { copies.push(t); },
    clear: async () => { clears++; },
    ask: () => { const a = answers[i++]; return a === null ? new Promise<string | null>(() => undefined) : a === "EOF" ? Promise.resolve(null) : Promise.resolve(a ?? ""); },
    say: (l) => { said.push(l); },
    timeoutMs,
  };
  return { io, copies, said, clears: () => clears };
}
const VALUES = [
  { name: "DATABASE_URL", value: "postgresql://ros_app.ref:pass@h.example.com:5432/postgres", where: "It goes into Vercel later." },
  { name: "WORKER_DATABASE_URL", value: "postgresql://ros_worker.ref:pass@h.example.com:5432/postgres", where: "It goes into Railway later." },
];

describe("clipboard delivery of secrets", () => {
  it("copies each value in turn, waits for the person, clears at the end, and never says a value", async () => {
    const f = fakeIo(["", ""]);
    const r = await deliverToClipboard(VALUES, f.io);
    expect(r).toEqual({ delivered: ["DATABASE_URL", "WORKER_DATABASE_URL"], timedOut: false });
    expect(f.copies).toEqual(VALUES.map((v) => v.value));
    expect(f.clears()).toBe(1);
    for (const line of f.said) for (const v of VALUES) expect(line).not.toContain(v.value);
    expect(f.said.some((l) => l.includes("DATABASE_URL is on the clipboard"))).toBe(true);
    expect(f.said.at(-1)).toContain("Clipboard cleared");
  });
  it("clears the clipboard and stops when nobody answers", async () => {
    const f = fakeIo(["", null]);
    const r = await deliverToClipboard(VALUES, f.io);
    expect(r).toEqual({ delivered: ["DATABASE_URL"], timedOut: true });
    expect(f.clears()).toBe(1);
    expect(f.said.at(-1)).toContain("clipboard was cleared");
    for (const line of f.said) for (const v of VALUES) expect(line).not.toContain(v.value);
  });
  it("treats the input ending (window closed) as no answer", async () => {
    const f = fakeIo(["EOF"]);
    const r = await deliverToClipboard(VALUES, f.io);
    expect(r).toEqual({ delivered: [], timedOut: true });
    expect(f.clears()).toBe(1);
  });
});
