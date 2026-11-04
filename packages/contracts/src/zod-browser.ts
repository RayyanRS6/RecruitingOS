import { z } from "zod";

/**
 * Loaded first in the browser (`apps/shell/instrumentation-client.ts`), never on the server, which keeps zod's compiled
 * parsers. Zod tries `new Function("")` when the first object schema is built, to see whether it may compile them.
 * Under report-only (production today) the try succeeds and is reported, on every page; under enforce it is refused,
 * zod catches that, and it is still reported. "jitless" skips the try, and zod interprets its parsers, as it would
 * under enforce anyway.
 */
z.config({ jitless: true });
