import { getShellForRequest } from "./container";

/**
 * Every mounted path hands the request to Hono unchanged; the API, webhooks and candidate pages keep their own routing,
 * headers and errors. Each one keeps its invocation alive until the pool's idle connections have closed.
 */
export const honoHandler = async (req: Request): Promise<Response> => (await getShellForRequest()).handler(req);
