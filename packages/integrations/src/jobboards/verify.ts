/**
 * Public URL verification (docs/spec/20 item 12): a posting is never called live until its public URL answered with
 * the job. The real verifier fetches the page like a browser would, follows redirects, reads a bounded amount of it
 * and looks for the job title, case- and whitespace-insensitively. The fake answers from a script so tests can play
 * reachable, wrong-title and unreachable. Neither ever posts anything, and neither reads a board's API.
 *
 * The address comes from a customer, and the worker that fetches it sits inside a private network, so the real
 * verifier fetches only public addresses: every hop (redirects are followed by hand) must use https (http only after a
 * redirect), the standard port and a host whose every address is public, and the connection goes to the address that
 * was checked. A refused target reads "the address could not be reached", whatever the reason.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
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

/** Redirects followed by hand, each hop checked like the first. */
export const LINK_CHECK_MAX_REDIRECTS = 5;
/** What a refused or unreachable internal target reads as: the same words whatever the reason, so nothing is learned about the network behind the worker. */
export const LINK_CHECK_REFUSED_DETAIL = "the address could not be reached";

/** Resolves a host name to every address it has, as the connection would. */
export type HostResolver = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

const defaultResolver: HostResolver = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

function ipv4Octets(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255) ? octets : null;
}

function privateIpv4(o: number[]): boolean {
  const [a, b, c] = o;
  return (
    a === 0 || a === 10 || a === 127 || // "this network", private, loopback
    (a === 100 && b >= 64 && b <= 127) || // shared address space (CGNAT)
    (a === 169 && b === 254) || // link-local, including the cloud metadata address
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments, documentation
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Sixteen bytes of an IPv6 address (a zone suffix and an embedded IPv4 tail allowed), or null when it is not one. */
function ipv6Bytes(address: string): number[] | null {
  let s = address.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  let tail: number[] = [];
  const v4 = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const o = ipv4Octets(v4[2]);
    if (!o) return null;
    tail = o;
    s = `${v4[1]}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const words = (part: string) => (part ? part.split(":") : []);
  const head = words(halves[0]);
  const rest = halves.length === 2 ? words(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array.from({ length: fill }, () => "0"), ...rest];
  if (all.length !== 8 || !all.every((w) => /^[0-9a-f]{1,4}$/.test(w))) return null;
  const bytes = all.flatMap((w) => { const n = Number.parseInt(w, 16); return [n >> 8, n & 0xff]; });
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/**
 * True for an address the link check must never reach: loopback, private, link-local (the cloud metadata address
 * among them), unique-local, shared (CGNAT), unspecified, multicast, documentation and reserved ranges, and the same
 * addresses wrapped in IPv6 (mapped, compatible, NAT64). Anything that is not an address at all counts as refused.
 */
export function isNonPublicAddress(address: string): boolean {
  const v4 = ipv4Octets(address);
  if (v4) return privateIpv4(v4);
  const b = ipv6Bytes(address);
  if (!b) return true;
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 16)) return true; // ::
  if (zeros(0, 15) && b[15] === 1) return true; // ::1
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return privateIpv4(b.slice(12)); // ::ffff:a.b.c.d
  if (zeros(0, 12)) return true; // ::a.b.c.d, deprecated
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return privateIpv4(b.slice(12)); // 64:ff9b::/96
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local, deprecated
  if (b[0] === 0xff) return true; // multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  return false;
}

/** Host names that only mean something inside a network: a single label, localhost, and the internal suffixes. */
function internalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".")) return true;
  return /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|corp)$/.test(h);
}

type Hop = { url: URL; address: { address: string; family: 4 | 6 } };

/**
 * One hop's gate: an allowed scheme, the standard port, a public host name, and every address it resolves to public.
 * Null when refused. The first hop must be https (the route asks for an https address); a board may redirect to http.
 */
async function admit(url: URL, first: boolean, resolve: HostResolver): Promise<Hop | null> {
  if (url.protocol !== "https:" && (first || url.protocol !== "http:")) return null;
  if (url.username || url.password) return null;
  if (url.port && !((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80"))) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string; family: 4 | 6 }>;
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
  else {
    if (internalHostname(host)) return null;
    try {
      addresses = await resolve(host);
    } catch {
      return null;
    }
  }
  if (!addresses.length || addresses.some((a) => isNonPublicAddress(a.address))) return null;
  return { url, address: addresses[0] };
}

/**
 * The default fetch: the connection goes to the address that was checked, never to a second DNS answer (a host that
 * resolves to a public address for the check and a private one for the connection gets nowhere). No redirect is
 * followed here; the verifier follows them itself, checking each hop.
 */
function pinnedFetch(hop: Hop, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<Response> {
  const request = hop.url.protocol === "https:" ? httpsRequest : httpRequest;
  const lookup = ((_host: string, options: { all?: boolean } | number | undefined, callback: (...args: unknown[]) => void) => {
    if (typeof options === "object" && options?.all) callback(null, [{ address: hop.address.address, family: hop.address.family }]);
    else callback(null, hop.address.address, hop.address.family);
  }) as unknown as LookupFunction;
  return new Promise<Response>((resolveResponse, reject) => {
    const req = request(hop.url, { method: "GET", headers: init.headers, signal: init.signal, lookup }, (res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const status = res.statusCode ?? 502;
      if (status < 200 || status > 599 || [204, 205, 304].includes(status)) {
        res.resume();
        resolveResponse(new Response(null, { status: status >= 200 && status <= 599 ? status : 502, headers }));
        return;
      }
      resolveResponse(new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, { status, headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

export class RealUrlVerifier implements UrlVerifier {
  readonly id = "http_fetch";
  readonly status = "live" as const;
  private readonly resolve: HostResolver;
  /**
   * `fetchFn` replaces the pinned connection (tests script pages with it); `resolveHost` replaces DNS. Whatever is
   * injected, every hop is still checked before it is fetched.
   */
  constructor(private readonly fetchFn?: typeof fetch, opts: { resolveHost?: HostResolver } = {}) {
    this.resolve = opts.resolveHost ?? defaultResolver;
  }

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
    const headers = { "user-agent": LINK_CHECK_USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" };
    try {
      for (let hop = 0; hop <= LINK_CHECK_MAX_REDIRECTS; hop++) {
        const admitted = await admit(target, hop === 0, this.resolve);
        // A private, internal or odd target is refused before any connection, in words that say nothing about why.
        if (!admitted) return { ok: false, reason: "unreachable", detail: LINK_CHECK_REFUSED_DETAIL };
        const res = this.fetchFn
          ? await this.fetchFn(target.toString(), { method: "GET", redirect: "manual", signal: controller.signal, headers })
          : await pinnedFetch(admitted, { headers, signal: controller.signal });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
          await res.body?.cancel().catch(() => undefined);
          try {
            target = new URL(res.headers.get("location")!, target);
          } catch {
            return { ok: false, reason: "unreachable", detail: LINK_CHECK_REFUSED_DETAIL };
          }
          continue;
        }
        if (res.status < 200 || res.status >= 300) return { ok: false, reason: "status", detail: `the page answered with HTTP ${res.status}` };
        const text = await readBounded(res, LINK_CHECK_MAX_BYTES);
        if (!titleMatches(text, opts.expectedTitle)) return { ok: false, reason: "title_mismatch", detail: `the page did not contain the job title "${opts.expectedTitle}"` };
        return { ok: true };
      }
      return { ok: false, reason: "unreachable", detail: `more than ${LINK_CHECK_MAX_REDIRECTS} redirects` };
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
