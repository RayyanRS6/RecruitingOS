import { createDb } from "../client";
import { migrate } from "../migrate";
import { seedPlatform } from "../seed";

// Migrations and seeds run as the owner role (MIGRATE_DATABASE_URL), never as the application role.
const handle = await createDb({ databaseUrl: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? null, pgliteDir: process.env.PGLITE_DIR ?? "./.data/pglite" });
await migrate(handle);
await seedPlatform(handle.db);
console.log("seeded plans and playbooks");
await handle.close();
