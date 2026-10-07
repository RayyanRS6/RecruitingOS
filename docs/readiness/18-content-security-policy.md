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
covers them and no font host learns who opened a job page (`apps/api/src/candidate-look.test.ts`). **Not done yet:** the
font files themselves are not in the repository. Until someone runs `scripts/fetch-fonts.ts` (with approval, since it
downloads files), reviews the files and the lock it writes (`apps/api/src/pages/fonts.lock.json`: exact versions and a
SHA-256 per file) and commits them, candidate pages show the device's own sans-serif. The policy is the same either way.

**The application** (every Next.js page; set in `apps/shell/middleware.ts`, built by `apps/shell/lib/csp.ts`):

```
default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none';
img-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com;
style-src 'self' 'nonce-…' https://fonts.googleapis.com; style-src-attr 'unsafe-inline';
script-src 'self' 'nonce-…' 'strict-dynamic' ('unsafe-eval' in development only);
connect-src 'self' (ws: wss: in development only); worker-src 'self' blob:; manifest-src 'self';
upgrade-insecure-requests (production only); report-uri /api/csp-report
```

The two font hosts are the only external origins. Next.js reads the nonce from the policy header on the request and
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

## Tests

- `apps/api/src/csp.test.ts`: every candidate page receives the policy; one nonce per request on the style and the
  structured data; no inline handlers; no external origin; `CSP_MODE` switches the header; reports are accepted in both
  formats, de-duplicated, stripped, listed and reviewed.
- `apps/shell/lib/csp.test.ts`: the application policy names only the two font hosts, uses nonce + `strict-dynamic`,
  never `unsafe-inline` for scripts, and `unsafe-eval` only in development.
- `tests/e2e/specs/routes.spec.ts`: the application responds with the report-only header carrying a nonce, and every
  script the shell emits carries that nonce.
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
