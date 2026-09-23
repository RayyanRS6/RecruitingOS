import { randomBytes } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { cspReports, type Queryable } from "@ros/db";

/**
 * Content-security policy for candidate pages (founder instruction of 21 September 2026, item 6). Candidate pages are
 * server-rendered and need no JavaScript, so the policy allows nothing by default: no external origin at all, styles and
 * the structured-data script only with the per-request nonce, inline event handlers never. Analytics never widen this
 * policy; candidate pages load no analytics (founder decision, correction 14). Report-only first; enforcement waits for
 * a review of the reports (docs/readiness/18).
 */
export type CspMode = "report-only" | "enforce";

export function makeNonce(): string {
  return randomBytes(16).toString("base64");
}

/** `connectOrigins`: the object store a candidate's browser uploads a résumé to, when it is not this origin (decision 2). */
export function buildCandidateCsp(input: { nonce: string; production: boolean; reportPath?: string; connectOrigins?: string[] }): string {
  const directives = [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data:",
    `style-src 'self' 'nonce-${input.nonce}'`,
    // Inline style attributes (server-rendered layout hints) are allowed; loads from CSS stay bound by img-src and font-src.
    "style-src-attr 'unsafe-inline'",
    `script-src 'nonce-${input.nonce}' 'strict-dynamic'`,
    "font-src 'self'",
    `connect-src 'self'${(input.connectOrigins ?? []).map((o) => ` ${o}`).join("")}`,
    "manifest-src 'self'",
    ...(input.production ? ["upgrade-insecure-requests"] : []),
    ...(input.reportPath ? [`report-uri ${input.reportPath}`] : []),
  ];
  return directives.join("; ");
}

export function cspHeaderName(mode: CspMode): "Content-Security-Policy" | "Content-Security-Policy-Report-Only" {
  return mode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}

export type NormalizedCspReport = { mode: string; surface: "candidate" | "app"; documentPath: string; violatedDirective: string; effectiveDirective: string | null; blockedOrigin: string | null; sourceFile: string | null; lineNumber: number | null; userAgent: string | null };

const TOKEN_PATH = /\/c\/(status|screen|schedule)\/[^/?#]+/g;

/** A request path with every candidate link token replaced by `[token]`: safe for audit records, error reports and logs. */
export function maskTokenPath(path: string): string {
  return path.replace(TOKEN_PATH, "/c/$1/[token]");
}

function pathOnly(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const u = new URL(value, "http://placeholder.local");
    return u.pathname.replace(TOKEN_PATH, "/c/$1/[token]").slice(0, 300);
  } catch {
    return value.split("?")[0].replace(TOKEN_PATH, "/c/$1/[token]").slice(0, 300);
  }
}

function originOnly(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return value.slice(0, 40); // keywords such as inline, eval, data, blob
  try {
    const u = new URL(value);
    return (u.protocol === "data:" || u.protocol === "blob:" ? u.protocol : u.origin).slice(0, 200);
  } catch {
    return value.slice(0, 40);
  }
}

/** Accepts both report formats (the legacy `csp-report` object and the Reporting API array) and keeps paths and origins only. */
export function normalizeCspReports(body: unknown, userAgent: string | null | undefined): NormalizedCspReport[] {
  const items: Array<Record<string, unknown>> = [];
  if (Array.isArray(body)) {
    for (const r of body) if (r && typeof r === "object" && (r as { type?: string }).type === "csp-violation" && (r as { body?: unknown }).body) items.push((r as { body: Record<string, unknown> }).body);
  } else if (body && typeof body === "object" && (body as { "csp-report"?: unknown })["csp-report"]) {
    items.push((body as { "csp-report": Record<string, unknown> })["csp-report"]);
  } else if (body && typeof body === "object") {
    items.push(body as Record<string, unknown>);
  }
  const out: NormalizedCspReport[] = [];
  for (const r of items) {
    const documentPath = pathOnly(r["document-uri"] ?? r.documentURL ?? r["documentURL"]) ?? "/";
    const violated = String(r["violated-directive"] ?? r.violatedDirective ?? r["effective-directive"] ?? r.effectiveDirective ?? "").slice(0, 120);
    if (!violated) continue;
    out.push({
      mode: String(r.disposition ?? "report").toLowerCase() === "enforce" ? "enforce" : "report_only",
      surface: documentPath.startsWith("/c/") || documentPath.startsWith("/careers") || documentPath === "/privacy" ? "candidate" : "app",
      documentPath,
      violatedDirective: violated,
      effectiveDirective: r["effective-directive"] ?? r.effectiveDirective ? String(r["effective-directive"] ?? r.effectiveDirective).slice(0, 120) : null,
      blockedOrigin: originOnly(r["blocked-uri"] ?? r.blockedURL),
      sourceFile: originOnly(r["source-file"] ?? r.sourceFile),
      lineNumber: Number.isInteger(r["line-number"] ?? r.lineNumber) ? Number(r["line-number"] ?? r.lineNumber) : null,
      userAgent: userAgent ? userAgent.slice(0, 200) : null,
    });
  }
  return out;
}

/** Stores a report, counting repeats of the same violation instead of adding rows. */
export async function recordCspReport(q: Queryable, r: NormalizedCspReport, now: Date = new Date()): Promise<{ id: string; count: number }> {
  try { await (q as unknown as { execute: (s: unknown) => Promise<unknown> }).execute(sql`select pg_advisory_xact_lock(hashtext(${`csp:${r.surface}:${r.documentPath}:${r.violatedDirective}:${r.blockedOrigin ?? ""}:${r.sourceFile ?? ""}`}))`); } catch { /* outside a transaction: the select below still de-duplicates in the common case */ }
  const [existing] = await q.select({ id: cspReports.id, count: cspReports.count }).from(cspReports).where(and(eq(cspReports.surface, r.surface), eq(cspReports.documentPath, r.documentPath), eq(cspReports.violatedDirective, r.violatedDirective), r.blockedOrigin === null ? isNull(cspReports.blockedOrigin) : eq(cspReports.blockedOrigin, r.blockedOrigin), r.sourceFile === null ? isNull(cspReports.sourceFile) : eq(cspReports.sourceFile, r.sourceFile))).limit(1);
  if (existing) {
    // a recurrence needs another look, but the reviewer's earlier note stays with the row
    await q.update(cspReports).set({ count: sql`${cspReports.count} + 1`, lastAt: now.toISOString(), mode: r.mode, reviewedAt: null }).where(eq(cspReports.id, existing.id));
    return { id: existing.id, count: existing.count + 1 };
  }
  const [row] = await q.insert(cspReports).values({ ...r, firstAt: now.toISOString(), lastAt: now.toISOString() }).returning({ id: cspReports.id });
  return { id: row.id, count: 1 };
}

export async function listCspReports(q: Queryable, limit = 200) {
  return q.select().from(cspReports).orderBy(desc(cspReports.lastAt)).limit(limit);
}

export async function reviewCspReport(q: Queryable, input: { id: string; reviewedBy: string; disposition: string; now?: Date }): Promise<boolean> {
  const rows = await q.update(cspReports).set({ reviewedAt: (input.now ?? new Date()).toISOString(), reviewedBy: input.reviewedBy, disposition: input.disposition.slice(0, 200) }).where(eq(cspReports.id, input.id)).returning({ id: cspReports.id });
  return rows.length > 0;
}
