import { cache } from "react";
import { cookies } from "next/headers";
import type { SignupConfig } from "@ros/contracts";
import { getShellForRequest } from "./container";

/** Who may create a company (GATE-V2), and this person's own request if they sent one: the `signup` part of GET /api/v1/auth/config (apps/api/src/routes/auth.ts). */
export type Signup = SignupConfig;

/**
 * The sign-in page's public configuration, asked of the mounted API in-process with the person's cookies, as getMe asks
 * for the session (lib/session.ts), so `allowed` answers for this person. Cached per request. null when it cannot be
 * read: the company step then shows its form as before, and the API still refuses whoever it should.
 */
export const getSignup = cache(async (): Promise<Signup | null> => {
  const jar = await cookies();
  const cookie = jar.getAll().map((c) => `${c.name}=${c.value}`).join("; ");
  const { handler } = await getShellForRequest();
  const res = await handler(new Request("http://shell.local/api/v1/auth/config", { headers: cookie ? { cookie } : {} }));
  if (res.status !== 200) return null;
  return ((await res.json()) as { signup?: Signup }).signup ?? null;
});
