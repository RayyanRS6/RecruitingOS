import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The repository is public (docs/runbooks/production-setup.md). The release review (11 November 2026, L5-6): an example of a
 * typed name passing for one of ours put a full personal name beside an address at ITS's own domain into source comments,
 * docs and tests. Examples use an obviously fictional name on a reserved domain instead ("Pat Example <pat@its.example>").
 * This guard finds a first and last name written beside an address at ITS's domain, in any text file the repository holds.
 */
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", ".data", "dist", "results", "playwright-report", "test-results", "report", ".git", "coverage", ".turbo"]);
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|sql|yml|yaml|css|html|txt|toml|sh|ps1)$/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.size <= 1_000_000 && TEXT.test(name) && !name.endsWith("pnpm-lock.yaml")) out.push(p);
  }
  return out;
}

/** "First Last <someone@…>" or "First Last someone@…" at ITS's domain: a real-looking person beside a real-looking address. */
const NAME_BESIDE_ITS_ADDRESS = /\b[A-Z][a-z]+ [A-Z][a-z]+ <?[a-z0-9._%+-]+@identifiedtalent\.com\b/;

describe("the public repository", () => {
  it("never writes a full personal name beside an address at ITS's own domain", () => {
    const files = walk(ROOT);
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((line, i) => (NAME_BESIDE_ITS_ADDRESS.test(line) ? [`${relative(ROOT, f)}:${i + 1}`] : [])));
    expect(found).toEqual([]);
  });
});
