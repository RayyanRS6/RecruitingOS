import { ConnectionStringError, fillPassword } from "./connection-string";

/**
 * Used by scripts/staging-db-setup.sh only. The connection string with its placeholder arrives in ROS_OWNER_URI (it
 * holds no secret); the password arrives on standard input, never on a command line or in an environment variable;
 * the completed connection string goes to standard output for the calling shell to capture. Nothing is logged.
 */
const uri = process.env.ROS_OWNER_URI;
if (!uri) {
  console.error("fill-password: ROS_OWNER_URI must be set by scripts/staging-db-setup.sh.");
  process.exit(2);
}
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const password = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
try {
  process.stdout.write(fillPassword(uri, password));
} catch (error) {
  console.error(`fill-password: ${error instanceof ConnectionStringError ? error.message : "could not complete the connection string."}`);
  process.exit(1);
}
