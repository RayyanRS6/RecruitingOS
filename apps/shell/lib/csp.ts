/**
 * Content-security policy for the authenticated application (21 Sep, item 6). Dependency-free so the Next.js middleware
 * can use it. A per-request nonce covers the scripts Next.js emits and any script the shell adds. No outside origin at
 * all: the fonts are served from this deployment's own /fonts/ folder (app/fonts.css). Report-only until the staging
 * reports have been reviewed (docs/readiness/18).
 */
export type AppCspMode = "report-only" | "enforce";

export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function buildAppCsp(input: { nonce: string; dev: boolean; reportPath?: string }): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `style-src 'self' 'nonce-${input.nonce}'`,
    "style-src-attr 'unsafe-inline'",
    // 'unsafe-eval' only in development: the dev server's module runtime needs it; production builds do not.
    `script-src 'self' 'nonce-${input.nonce}' 'strict-dynamic'${input.dev ? " 'unsafe-eval'" : ""}`,
    `connect-src 'self'${input.dev ? " ws: wss:" : ""}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...(input.dev ? [] : ["upgrade-insecure-requests"]),
    ...(input.reportPath ? [`report-uri ${input.reportPath}`] : []),
  ].join("; ");
}

export function cspMode(value: string | undefined): AppCspMode {
  return value === "enforce" ? "enforce" : "report-only";
}

export function cspHeaderName(mode: AppCspMode): string {
  return mode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}
