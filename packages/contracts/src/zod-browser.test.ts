import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The live smoke test of 4 Nov 2026 recorded a `script-src` violation with blocked origin `eval` on every signed-in page:
 * zod tries `new Function("")` when the first object schema is built, to see whether it may compile its parsers. Under
 * report-only (production today) the try succeeds and is reported; under enforce it is refused, zod catches that, and
 * it is still reported. The browser turns the try off; once the policy blocks instead of reporting, nothing changes for
 * anyone.
 *
 * A fresh Node process for each, because the try happens once per loaded copy of zod and this file's own is already
 * loaded. Every `new Function` is counted from before zod loads.
 */
const CONTRACTS = fileURLToPath(new URL("..", import.meta.url));
const run = (setup: string) => {
  const script = `
    const made = [];
    globalThis.Function = new Proxy(Function, { construct(target, args) { made.push(args); return Reflect.construct(target, args); } });
    ${setup}
    const { z } = await import("zod");
    const schema = z.object({ a: z.string(), b: z.object({ c: z.number() }) });
    const good = schema.safeParse({ a: "x", b: { c: 1 } });
    const bad = schema.safeParse({ a: 1, b: { c: "y" } });
    console.log(JSON.stringify({ made: made.length, good: good.data, bad: bad.error?.issues.map((i) => i.path.join(".")) }));
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: CONTRACTS, encoding: "utf8" })) as { made: number; good: unknown; bad: string[] };
};
const SAME_PARSING = { good: { a: "x", b: { c: 1 } }, bad: ["a", "b.c"] };

describe("zod in the browser", () => {
  it("left alone, zod tries new Function as soon as an object schema is built", () => {
    const r = run("");
    expect(r.made).toBeGreaterThan(0);
    expect(r).toMatchObject(SAME_PARSING);
  });

  it("with the browser's setting, zod never calls new Function, and parses the same", () => {
    const setting = new URL("./zod-browser.ts", import.meta.url).href;
    const r = run(`await import(${JSON.stringify(setting)});`);
    expect(r.made).toBe(0);
    expect(r).toMatchObject(SAME_PARSING);
  });

  it("the browser's first import is the setting, before any module that builds a schema; the server never loads it", () => {
    const client = readFileSync(new URL("../../../apps/shell/instrumentation-client.ts", import.meta.url), "utf8");
    expect(client.match(/^import\b.*$/m)?.[0]).toBe('import "@ros/contracts/zod-browser";');
    for (const server of ["../../../apps/shell/instrumentation.ts", "../../../apps/shell/instrumentation-node.ts", "./index.ts"]) {
      expect(readFileSync(new URL(server, import.meta.url), "utf8"), server).not.toContain("zod-browser");
    }
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };
    expect(manifest.exports["./zod-browser"]).toBe("./src/zod-browser.ts");
  });
});
