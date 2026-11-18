import type { MeResponse, PlanLimitDetails } from "@ros/contracts";

/**
 * The pages' way to the API. It is served by the same deployment as the pages, so every path is relative and the session
 * travels in a cookie. The shapes of what it takes and answers live in @ros/contracts; a page names the one it reads.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}), ...((init.headers as Record<string, string>) ?? {}) };
  const res = await fetch(path, { method, credentials: "include", headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), ...init });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (json as { error?: { code: string; message: string; details?: unknown } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "error", err?.message ?? `Request failed (${res.status})`, err?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string, init?: RequestInit) => request<T>("GET", path, undefined, init),
  post: <T>(path: string, body?: unknown, init?: RequestInit) => request<T>("POST", path, body ?? {}, init),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

/** The signed-in person, exactly as GET /api/v1/auth/me answers. */
export type Me = MeResponse;

type Failure = { status?: unknown; code?: unknown; message?: unknown; details?: unknown };

/** What to say when a request fails: the API's own plain sentence, or a line about the connection when there is none. */
export function errorWords(err: unknown, fallback = "That did not go through. Check your connection and try again."): string {
  const e = err as Failure | null | undefined;
  return typeof e?.status === "number" && typeof e.message === "string" && e.message.trim() ? e.message : fallback;
}

/** The code of a refusal from the API ("stale_version", "packet_flags"), or null for any other failure. */
export function errorCode(err: unknown): string | null {
  const e = err as Failure | null | undefined;
  return typeof e?.status === "number" && typeof e.code === "string" ? e.code : null;
}

/** Someone past the plan's candidates per job: a state to draw, never a failure to retry. */
export function isCandidateLocked(err: unknown): boolean {
  return errorCode(err) === "candidate_locked";
}

/**
 * What a refusal by the plan (402) carries: the request about the plan to offer with its message, when this person may
 * ask. Null for any other failure.
 */
export function planLimitOf(err: unknown): PlanLimitDetails | null {
  const e = err as Failure | null | undefined;
  if (e?.status !== 402) return null;
  const d = (e.details ?? {}) as Partial<PlanLimitDetails>;
  const ask = d.ask && typeof d.ask.label === "string" && typeof d.ask.reason === "string" ? { label: d.ask.label, reason: d.ask.reason } : null;
  return { upgrade: d.upgrade === true, ask, ...(d.room ? { room: d.room } : {}) };
}
