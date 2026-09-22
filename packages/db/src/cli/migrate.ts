import { createDb } from "../client";
import { migrate } from "../migrate";

// Migrations and seeds run as the owner role (MIGRATE_DATABASE_URL), never as the application role.
const handle = await createDb({ databaseUrl: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? null, pgliteDir: process.env.PGLITE_DIR ?? "./.data/pglite" });
const applied = await migrate(handle, { log: (s) => console.log(s) });
console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
await handle.close();
