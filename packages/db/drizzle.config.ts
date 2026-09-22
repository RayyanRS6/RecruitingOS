import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  driver: "pglite",
  dbCredentials: { url: "./.data/drizzle-kit-scratch" },
  strict: true,
  verbose: true,
});
