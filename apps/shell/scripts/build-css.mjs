// Builds the application's stylesheet the way Next.js does (Tailwind CSS v4 through PostCSS) and prints its size, so a
// change to packages/ui/src/styles.css or to the classes the pages use can be checked without starting the app. The entry is apps/shell/app/globals.css.
// Usage, from the repository root: node apps/shell/scripts/build-css.mjs [out.css]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import tailwind from "@tailwindcss/postcss";
import postcss from "postcss";

const shell = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(shell, "app/globals.css");
const result = await postcss([tailwind({ base: shell, optimize: { minify: true } })]).process(readFileSync(entry, "utf8"), { from: entry });
for (const w of result.warnings()) console.warn(`warning: ${w.text}`);
const css = result.css;
const out = process.argv[2];
if (out) writeFileSync(out, css);
console.log(`styles.css built: ${css.length} bytes, ${gzipSync(css, { level: 9 }).length} bytes gzipped`);
