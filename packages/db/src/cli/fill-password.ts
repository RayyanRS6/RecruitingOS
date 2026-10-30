import { ConnectionStringError, fillPassword, passwordFromStdin } from "./connection-string";
import { checkProjectRef, dbEnvironmentFrom } from "./environment";

/**
 * Used by the setup and status scripts only (scripts/db-setup.ps1, scripts/db-status.ps1 and the staging bash
 * scripts). The connection string with its placeholder arrives in ROS_OWNER_URI (it holds no secret); the password
 * arrives on standard input, never on a command line or in an environment variable; the completed connection string
 * goes to standard output for the calling script to capture. Nothing is logged. The string must belong to the
 * project of the environment the script named (ROS_DB_ENV, environment.ts), so a string copied from the wrong project
 * is refused before any step uses it.
 */
const uri = process.env.ROS_OWNER_URI;
if (!uri) {
  console.error("fill-password: ROS_OWNER_URI must be set by the setup script (scripts/db-setup.ps1 or scripts/staging-db-setup.sh).");
  process.exit(2);
}
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const environment = dbEnvironmentFrom(process.env);
if (!environment.ok) {
  console.error(`fill-password: ${environment.error}.`);
  process.exit(2);
}
const project = checkProjectRef(environment.target, uri);
if (!project.ok) {
  console.error(`fill-password: ${project.error}.`);
  process.exit(2);
}
try {
  process.stdout.write(fillPassword(uri, passwordFromStdin(raw)));
} catch (error) {
  console.error(`fill-password: ${error instanceof ConnectionStringError ? error.message : "could not complete the connection string."}`);
  process.exit(1);
}
