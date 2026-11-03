import { z } from "zod";

/**
 * Loaded first in the browser (`apps/shell/instrumentation-client.ts`), never on the server, which keeps zod's compiled
 * parsers. Zod tries `new Function("")` when the first object schema is built, to see whether it may compile them, and the
 * content-security policy reports that try on every page even though zod catches the refusal: "jitless" skips the try,
 * and zod parses the way it would have under the policy anyway.
 */
z.config({ jitless: true });
