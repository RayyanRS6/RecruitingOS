import { getShell } from "./container";

/** Every mounted path hands the request to Hono unchanged; the API, webhooks and candidate pages keep their own routing, headers and errors. */
export const honoHandler = async (req: Request): Promise<Response> => (await getShell()).handler(req);
