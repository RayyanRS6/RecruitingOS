# Route inventory

The maintained inventory lives in `docs/spec/16-route-inventory.md` (every Next.js route with its authentication requirement, permission, loading, empty, error, mobile, accessibility and browser-test coverage, plus the Hono-served mounts). Status: **Built with mocks**; the same routes are re-verified on the staging URL by `pnpm e2e` with `E2E_BASE_URL` set (`docs/readiness/03` §8).
