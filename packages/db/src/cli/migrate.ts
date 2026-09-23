import { createDb } from "../client";
import { migrate, MigrationError } from "../migrate";
import { describeConnectionError } from "./db-errors";
import { withSsl } from "./provisioning";

// Migrations and seeds run as the owner role (MIGRATE_DATABASE_URL), never as the application role. The owner string
// always gets sslmode=verify-full (with the CA from DATABASE_SSL_CA_FILE or DATABASE_SSL_CA): the owner credential never
// crosses the network in the clear.
const raw = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? null;
const handle = await createDb({ databaseUrl: raw ? withSsl(raw).toString() : null, pgliteDir: process.env.PGLITE_DIR ?? "./.data/pglite" });
try {
  const applied = await migrate(handle, { log: (s) => console.log(s) });
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
} catch (err) {
  if (err instanceof MigrationError) console.error(`migrate: ${err.message}\nmigrate: the failed migration was rolled back whole; nothing from it was kept. Statement starts: ${err.statementHead}`);
  else console.error(`migrate: ${describeConnectionError(err)}`);
  await handle.close().catch(() => undefined);
  process.exit(1);
}
await handle.close();
