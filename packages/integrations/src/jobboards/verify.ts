/**
 * Public URL verification (docs/spec/20 item 12): a posting is never called live until its public URL answered with
 * the job. The real verifier fetches the page like a browser would, follows redirects, reads a bounded amount of it
 * and looks for the job title, case- and whitespace-insensitively. The fake answers from a script so tests can play
 * reachable, wrong-title and unreachable. Neither ever posts anything, and neither reads a board's API.
 */
export type VerifyResult = { ok: true } | { ok: false; reason: "unreachable" | "status" | "title_mismatch"; detail: string };

export interface UrlVerifier {
  readonly id: string;
  readonly status: "live" | "fake";
  verify(url: string, opts: { expectedTitle: string }): Promise<VerifyResult>;
}

export const LINK_CHECK_USER_AGENT = "RecruitingOS-LinkCheck/1.0";
export const LINK_CHECK_TIMEOUT_MS = 10_000;
export const LINK_CHECK_MAX_BYTES = 512 * 1024;

/** Letters and digits only, lower-cased: "Registered  Dental Hygienist" and "registered dental hygienist" are the same title. */
export function normalizeForTitleMatch(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function titleMatches(pageText: string, expectedTitle: string): boolean {
  const title = normalizeForTitleMatch(expectedTitle);
  if (!title) return false;
  return normalizeForTitleMatch(pageText).includes(title);
}

export class RealUrlVerifier implements UrlVerifier {
  readonly id = "http_fetch";
  readonly status = "live" as const;
  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async verify(url: string, opts: { expectedTitle: string }): Promise<VerifyResult> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { ok: false, reason: "unreachable", detail: "not a valid URL" };
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") return { ok: false, reason: "unreachable", detail: `unsupported scheme ${target.protocol}` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINK_CHECK_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(target.toString(), { method: "GET", redirect: "follow", signal: controller.signal, headers: { "user-agent": LINK_CHECK_USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" } });
      if (res.status < 200 || res.status >= 300) return { ok: false, reason: "status", detail: `the page answered with HTTP ${res.status}` };
      const text = await readBounded(res, LINK_CHECK_MAX_BYTES);
      if (!titleMatches(text, opts.expectedTitle)) return { ok: false, reason: "title_mismatch", detail: `the page did not contain the job title "${opts.expectedTitle}"` };
      return { ok: true };
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return { ok: false, reason: "unreachable", detail: aborted ? `no answer within ${LINK_CHECK_TIMEOUT_MS / 1000} seconds` : err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Reads at most `max` bytes of the body; a page longer than that is judged on its first part. */
async function readBounded(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(Math.min(total, max));
  let offset = 0;
  for (const c of chunks) {
    const slice = c.subarray(0, Math.max(0, Math.min(c.byteLength, all.byteLength - offset)));
    all.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= all.byteLength) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

/** A scripted page (judged by title) or a scripted verdict. */
export type FakeAnswer = VerifyResult | { pageText: string; status?: number };

/**
 * The development and test verifier. `set(url, answer)` scripts one URL: a page text (ok when it contains the title,
 * otherwise a title mismatch; a non-2xx status wins), or a ready verdict. URLs that were never scripted answer ok, so
 * a locally published careers page reads as verified; pass `{ unknownUrls: "unreachable" }` to make them fail instead.
 */
export class FakeUrlVerifier implements UrlVerifier {
  readonly id = "fake";
  readonly status = "fake" as const;
  readonly calls: Array<{ url: string; expectedTitle: string }> = [];
  private answers = new Map<string, FakeAnswer>();
  constructor(private readonly opts: { unknownUrls?: "ok" | "unreachable" } = {}) {}

  set(url: string, answer: FakeAnswer): void {
    this.answers.set(url, answer);
  }
  clear(): void {
    this.answers.clear();
    this.calls.length = 0;
  }

  async verify(url: string, opts: { expectedTitle: string }): Promise<VerifyResult> {
    this.calls.push({ url, expectedTitle: opts.expectedTitle });
    const answer = this.answers.get(url);
    if (!answer) return this.opts.unknownUrls === "unreachable" ? { ok: false, reason: "unreachable", detail: "no scripted answer for this URL" } : { ok: true };
    if ("ok" in answer) return answer;
    if (answer.status !== undefined && (answer.status < 200 || answer.status >= 300)) return { ok: false, reason: "status", detail: `the page answered with HTTP ${answer.status}` };
    return titleMatches(answer.pageText, opts.expectedTitle) ? { ok: true } : { ok: false, reason: "title_mismatch", detail: `the page did not contain the job title "${opts.expectedTitle}"` };
  }
}
