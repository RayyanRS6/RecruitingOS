import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every model call a company makes goes through one gate, `runPromptDetached` (and its side-by-side form
 * `runPromptsDetached`), because that is where the AI credit holds its money before the model is asked
 * (packages/ai/src/runner.ts, packages/core/src/ai-credit.ts). `callPrompt` and `runPrompt` go straight to the model and
 * `recordRun` writes a run with no hold: outside the runner only the evaluation harness, which has no company, may use
 * them. A call that went round the gate would spend a company's money with nothing to stop it.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AROUND_THE_GATE = new Set(["callPrompt", "runPrompt", "recordRun"]);
const IMPORTS = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](?:@ros\/ai|[^"']*\/runner)["']|\{([^}]*)\}\s*=\s*await\s+import\(\s*["'](?:@ros\/ai|[^"']*\/runner)["']\s*\)/g;
const ASKS_THE_MODEL = /\.provider\.structured\(/;

/** The names a file takes from the AI package that go round the gate, and whether it asks a provider itself. */
function aroundTheGate(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(IMPORTS)) {
    for (const name of (m[1] ?? m[2] ?? "").split(",").map((n) => n.trim().split(/\s+as\s+/)[0]?.replace(/^type\s+/, ""))) if (name && AROUND_THE_GATE.has(name)) found.push(name);
  }
  if (ASKS_THE_MODEL.test(source)) found.push("provider.structured");
  return found;
}

describe("the one gate on the model", () => {
  it("no production code goes round it: not callPrompt, runPrompt or recordRun, and no provider asked directly", async () => {
    const found: string[] = [];
    for (const pattern of ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"]) {
      for await (const file of glob(pattern, { cwd: ROOT })) {
        const path = file.split("\\").join("/");
        if (path.includes("node_modules") || path.includes("/.next/") || /\.test\.tsx?$/.test(path)) continue;
        // the runner itself, and the evaluation harness, whose calls belong to no company
        if (path === "packages/ai/src/runner.ts" || path.startsWith("packages/evals/")) continue;
        const names = aroundTheGate(readFileSync(join(ROOT, file), "utf8"));
        if (names.length) found.push(`${path}: ${names.join(", ")}`);
      }
    }
    expect(found, `use runPromptDetached, which holds the AI credit first: ${found.join("; ")}`).toEqual([]);
  });

  it("the check catches what it is there to catch", () => {
    for (const source of ['import { callPrompt } from "@ros/ai";', 'import { runPromptDetached, runPrompt as go } from "@ros/ai";', 'import {\n  recordRun,\n} from "./runner";', 'const { callPrompt } = await import("@ros/ai");', "const r = await ctx.services.ai.provider.structured(req, model);"]) {
      expect(aroundTheGate(source), source).not.toEqual([]);
    }
    for (const source of ['import { runPromptDetached, runPromptsDetached, outOfCredit } from "@ros/ai";', 'import { callPrompt } from "./helpers";']) expect(aroundTheGate(source), source).toEqual([]);
  });
});
