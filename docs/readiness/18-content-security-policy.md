# 18. Content-security policy: what is set, and how enforcement is earned

Status: implemented locally on 21 September 2026 (founder instruction, item 6). Report-only everywhere. No production
enforcement until staging reports have been reviewed.

## Two policies

**Candidate pages** (`/c/*`, `/careers/*`, `/privacy`; set in `apps/api/src/app.ts`, built by `packages/core/src/csp.ts`):

```
default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none';
img-src 'self' data:; style-src 'self' 'nonce-…'; style-src-attr 'unsafe-inline';
script-src 'nonce-…' 'strict-dynamic'; font-src 'self'; connect-src 'self'; manifest-src 'self';
upgrade-insecure-requests (production only); report-uri /api/csp-report
```

No external origin at all. The pages need no JavaScript; the only script is the structured-data block on the job page,
which carries the nonce and whose JSON is escaped so that nothing an owner types into a description can close the
element. Every inline `<style>` (the page stylesheet and the screening page's own) carries the nonce; the test checks
every style and script element on every candidate page, screening included. Inline event handlers were removed
(the time-zone picker has a button; withdrawing an application and cancelling an interview confirm with a required
checkbox instead of a `confirm()` dialog). The pages' stylesheet asks for their fonts (IBM Plex Sans, Bricolage
Grotesque) only from this deployment's own origin (`/fonts/`, served from `apps/shell/public/fonts`), so `font-src 'self'`
covers them and no font host learns who opened a job page (`apps/api/src/candidate-look.test.ts`). The files are in the
repository, written by `scripts/fetch-fonts.ts` with the lock it keeps (`apps/api/src/pages/fonts.lock.json`: exact
versions and a SHA-256 per file).

**The application** (every Next.js page; set in `apps/shell/middleware.ts`, built by `apps/shell/lib/csp.ts`):

```
default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none';
img-src 'self' data: blob:; font-src 'self';
style-src 'self' 'nonce-…'; style-src-attr 'unsafe-inline';
script-src 'self' 'nonce-…' 'strict-dynamic' ('unsafe-eval' in development only);
connect-src 'self' (ws: wss: in development only); worker-src 'self' blob:; manifest-src 'self';
upgrade-insecure-requests (production only); report-uri /api/csp-report
```

No external origin at all: since 8 October 2026 the application loads the same self-hosted fonts as the candidate pages
(`apps/shell/app/fonts.css`, written by `scripts/fetch-fonts.ts`; `apps/shell/lib/fonts.test.ts`), with IBM Plex Sans
500, Bricolage Grotesque 600 and 800 and IBM Plex Mono added for the application's own styles, so Google Fonts is no
longer contacted. Next.js reads the nonce from the policy header on the request and
stamps it on the scripts it emits. Analytics run server-side only (founder decision, correction 14) and never appear in
either policy.

## Why `style-src-attr 'unsafe-inline'`

Both surfaces set layout hints as `style="…"` attributes in server-rendered markup. Allowing inline *style attributes*
does not allow scripts, and anything a style could load (a background image, a font) is still bound by `img-src` and
`font-src`, which name no external origin. Inline `<style>` elements and stylesheets still need the nonce or an allowed
host. This is the documented secure approach in place of a nonce on every attribute.

## Modes

`CSP_MODE=report-only` (default everywhere) sends `Content-Security-Policy-Report-Only`; `CSP_MODE=enforce` sends
`Content-Security-Policy`. Nothing else changes between the two.

## Reports and the review process

Browsers post violations to `POST /api/csp-report` (both report formats). The server keeps the document path with the
candidate token removed, the violated directive, the blocked origin (origin only), the source origin, a line number, and
a truncated user agent; never a query string, a token, or candidate data. Identical violations are counted, not repeated.
Administrators see them in the console (Failures → Content-security violations) and mark each reviewed with a
disposition. A violation that recurs after its review shows up again for another look and keeps the earlier note.
Fields are bounded and the endpoint is rate-limited per address; identical reports arriving together become one row.

Before enforcement on staging:

1. Run staging in report-only for at least two weeks of normal use, including one full candidate journey and one full
   owner journey on a phone and a laptop.
2. Every report is reviewed with a disposition: *expected in development only*, *fix needed* (fixed and retested), or
   *policy change* (the policy is changed and this document updated). No unreviewed reports remain.
3. The founder sets `CSP_MODE=enforce` on staging and the same journeys are repeated.

Before enforcement in production: staging has run enforced for at least two weeks with no new reports of the kinds above.
The founder makes the production change; it is a configuration change, not a code change.

## Local rehearsal under enforce (12 October 2026)

Every browser journey (`tests/e2e`, 32 tests on Microsoft Edge against `next dev`) ran with `CSP_MODE=enforce` and
passed, and a one-off check recorded every violation the browser reported while an owner, a signed-out candidate and a
platform administrator used the staff pages (Today, Roles, a role and its report, Talent with the candidate panel and
the framed résumé, Setup, Interviews, the job builder, the queue, every admin tab), the candidate pages (careers, job,
apply, status, privacy), the job-page preview and the second-factor page. The reports reached `POST /api/csp-report`
and were listed in the console. Found and fixed:

- **The API's own pages under two mounts** (the second factor at `/api/v1/auth/mfa`, the invitation at
  `/api/v1/auth/invite`): `"/x/*"` also matches `"/x"`, so the policy middleware ran twice, the page was drawn with one
  nonce and the header named another, and every style on the page was blocked. One nonce per response now
  (`apps/api/src/app.ts`); `apps/api/src/csp.test.ts` and `apps/api/src/mfa.test.ts` compare the page's nonce with the
  header's.

Left, both in development only (disposition *expected in development only*):

- Next.js's development tools add about sixteen `<style>` elements without the nonce on every staff page. A production
  build has no development tools.
- With Turbopack, Next.js 15.5 writes the loading screen's script tag (`app/(app)/loading.tsx`) without the nonce
  (`next/dist/server/app-render/create-component-styles-and-scripts.js`), so `strict-dynamic` blocks it; the page
  itself is unaffected. The production build (`next build`, webpack) writes no such tag. Check again before a Next.js
  upgrade that builds with Turbopack.

Candidate pages, the job-page preview, the second-factor page after the fix, and the framed résumé reported nothing.

## Tests

- `apps/api/src/csp.test.ts`: every candidate page receives the policy; one nonce per request on the style and the
  structured data; no inline handlers; no external origin; `CSP_MODE` switches the header; reports are accepted in both
  formats, de-duplicated, stripped, listed and reviewed; the API's own pages (sign-in link, invitation) are drawn with
  the nonce their header names.
- `apps/shell/lib/csp.test.ts`: the application policy names only the two font hosts, uses nonce + `strict-dynamic`,
  never `unsafe-inline` for scripts, and `unsafe-eval` only in development.
- `tests/e2e/specs/routes.spec.ts`: the application responds with exactly one policy header (report-only or enforced,
  so the same run works against a staging that enforces) carrying a nonce, every script the shell emits carries that
  nonce, the pages send `X-Frame-Options: DENY`, and a candidate page keeps Hono's `SAMEORIGIN` and `no-referrer`.
- Meeting links pasted by owners must be `http(s)` addresses (contract and rendering), so no `javascript:` link ever
  reaches a candidate page.

## Dated record (gates 3.7 and 5.1 of `docs/readiness/16`)

| Step | Date | By | Evidence |
|---|---|---|---|
| Report-only started on staging | | | |
| Reports reviewed, none unreviewed | | | |
| Staging switched to enforce (`CSP_MODE=enforce`) | | | |
| Two weeks enforced on staging without new reports | | | |
| Production switched to enforce | | | |
