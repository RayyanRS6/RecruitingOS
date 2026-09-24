# research-code-needs

Sources:
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/packages/integrations/src/identity/supabase.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/packages/integrations/src/identity/claims.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/packages/integrations/src/identity/jwt.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/packages/integrations/src/identity/types.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/packages/integrations/src/identity/fake.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/packages/integrations/src/registry.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/packages/core/src/identity.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/apps/api/src/routes/auth.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/apps/api/src/env.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/apps/api/src/container.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/apps/api/src/worker.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/apps/api/src/app.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/apps/api/src/middleware/session.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/apps/api/src/middleware/rate-limit.ts
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/apps/web/src/pages/Login.tsx
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/.env.example
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/docs/spec/13-account-creation-worksheet.md
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/docs/spec/19-external-account-inventory.md
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/docs/spec/17-staging-handoff.md
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/docs/readiness/03-staging-verification-checklist.md
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/docs/spec/00-decisions-and-risks.md
/Users/nadinemotaweh/Desktop/ITS Systems/ITS Systems - End to End Recruiting Tool/recruiting-os/docs/14-deployment-and-environment.md

FACTS:
1. ENV: AUTH_PROVIDER (non-secret). Must be exactly "supabase" in production or boot fails (apps/api/src/env.ts:134); selects SupabaseIdentityProvider (packages/integrations/src/registry.ts:63-65). Docs: Vercel and the worker environment (docs/spec/13-account-creation-worksheet.md:182; docs/spec/17-staging-handoff.md:14-15).

2. ENV: SUPABASE_URL (non-secret). Required in production (env.ts:135). The code derives the token issuer as `${SUPABASE_URL}/auth/v1` (supabase.ts:18-20) and checks the JWT `iss` claim equals it exactly (jwt.ts:55, supabase.ts:54), so the value must be the project API URL `https://<project-ref>.supabase.co` with no trailing path (.env.example:17). The same base is used for /authorize, /token and /.well-known/jwks.json (supabase.ts:26, 38, 47). Docs: Vercel, worker (13:178; 17:14-15).

3. ENV: SUPABASE_ANON_KEY (public/publishable, not secret per docs 13:179 and .env.example:18). Required in production (env.ts:135). Used only as the `apikey` header on the server-side PKCE token exchange POST `${SUPABASE_URL}/auth/v1/token?grant_type=pkce` (supabase.ts:36-38). Docs: entered by Nadine into Vercel, not sent to Claude (docs/spec/19-external-account-inventory.md:30).

4. ENV: SUPABASE_JWT_SECRET (SECRET, optional). Read only in registry.ts:64 (never in env.ts). If set, HS256 tokens are verified with it (jwt.ts:37-40); if absent, any HS256 token is refused with `unsupported_algorithm` (jwt.ts:38) and only RS256/ES256 tokens verified against the project JWKS at `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` (cached 10 min; supabase.ts:44-52, jwt.ts:41-48) are accepted. Docs: Vercel server (secret), entered directly by Nadine/Paul (13:181, 13:231); .env.example:19 calls it optional.

5. ENV: AUTH_SIGNIN_PROVIDERS (non-secret). Comma list, default `azure,google` (registry.ts:64; supabase.ts:22). Docs: `azure,google` (13:182; 17:34).

6. ENV: ITS_STAFF_EMAIL_DOMAINS (non-secret). Default `identifiedtalent.com` (env.ts:104); anyone on a listed domain is staff and must use Microsoft plus a second factor (auth.ts:52; packages/core/src/identity.ts:19-23, 29-30).

7. ENV: BOOTSTRAP_ADMIN_EMAILS (non-secret, one-time). Honoured only while no administrator exists (env.ts:46-51, 105; identity.ts:26-27, 66-70; container.ts:50-52). A listed address is treated as staff, so the bootstrap only completes on a Microsoft sign-in with aal2. Docs: Vercel, remove after first sign-in (17:24; docs/readiness/03:23).

8. ENV: MAGIC_LINK_ENABLED (non-secret). Defaults to false when NODE_ENV=production (env.ts:106); docs say `false` in production (13:182; 17:34). Staff can never use the email link regardless (auth.ts:156-158).

9. ENV: APP_BASE_URL and WEB_BASE_URL (both non-secret, both still read separately). APP_BASE_URL builds the redirect_to (auth.ts:72) and the magic-link consume URL (auth.ts:24); WEB_BASE_URL is where the callback sends the browser afterwards (`/` or `/setup/company` on success, `/login?error=<code>` on failure; auth.ts:79, 92). Defaults http://localhost:3001 and http://localhost:5173 (env.ts:97-98). Docs 17:24 say set both to the same host (staging: the Vercel preview URL).

10. ENV: COOKIE_DOMAIN (non-secret, optional). Only needed when the API and the web app are on different hosts of one site (auth.ts:34; .env.example:29-30). The PKCE verifier cookie `ros_pkce` (httpOnly, SameSite=Lax, secure in production, 10 min) is set at /start and must be sent back on /callback, so both routes must be on the same host (auth.ts:27-35, 71, 80).

11. ENV: SESSION_SECRET (SECRET). Still required in production (env.ts:131) and used to key rate-limit subjects (apps/api/src/middleware/rate-limit.ts:107, 139, 155); it is not involved in verifying Supabase tokens. NODE_ENV=production turns on all guards (env.ts:130-138) and the `secure` cookie flag (auth.ts:31).

12. WORKER: the worker process also boots through loadEnv (apps/api/src/worker.ts:7 -> container.ts:31), so in production the Railway worker environment must also carry AUTH_PROVIDER=supabase, SUPABASE_URL and SUPABASE_ANON_KEY or it refuses to start (env.ts:134-135), even though only the API's auth routes ever verify a token (auth.ts:88, 105). SUPABASE_JWT_SECRET is not needed on the worker.

13. NOT READ BY THE CODE: SUPABASE_JWT_ISSUER (grep over apps/ and packages/ finds no reader; the issuer is derived from SUPABASE_URL at supabase.ts:18-20), SUPABASE_SERVICE_ROLE_KEY (not needed for sign-in; docs 13:180 forbid provisioning it), MS_OAUTH_CLIENT_ID/SECRET/TENANT (deferred calendar registration only, 13:157), and any Entra tenant id (no `tenant`/`ENTRA`/`AZURE_TENANT` reference in packages/integrations/src/identity, packages/core/src/identity.ts or apps/api/src/routes/auth.ts).

14. PROVIDER KEY: Microsoft is the Supabase provider key `azure` everywhere: providers list and scopes (supabase.ts:22, 32), label "Microsoft" (claims.ts:29), staff policy `staffProvider: "azure"` hard-coded (auth.ts:52; identity.ts:13, 29), login button links to `${API_BASE}/api/v1/auth/start/azure` (apps/web/src/pages/Login.tsx:53). The token's `app_metadata.provider` must therefore come back as `azure` for staff (claims.ts:5, 9).

15. SCOPES: for azure the code sets `scopes=openid profile email` on Supabase's `${SUPABASE_URL}/auth/v1/authorize` (supabase.ts:32) together with provider, redirect_to, code_challenge and code_challenge_method=s256 (supabase.ts:26-31). No scopes parameter is sent for google. Docs 13:65 list delegated `openid, profile, email, User.Read` on the registration; the code never asks for User.Read (a registration permission the flow will not exercise; harmless). No calendar scope anywhere (supabase.ts:31).

16. JWT VERIFICATION (jwt.ts:33-63): algorithm from the header only; HS256 -> HMAC with SUPABASE_JWT_SECRET, constant-time compare (37-40); RS256/ES256 -> key from the JWKS matched by `kid` and `kty` (41-48); anything else refused (49-50). Then `iss` must equal `${SUPABASE_URL}/auth/v1` (55), `aud` must contain `authenticated` (56-58; supabase.ts:54), `exp` with 60 s skew (53-54, 59), `nbf` (60), non-empty `sub` (61).

17. CLAIMS READ (claims.ts:4-27): `sub` (14), `email` lower-cased (12), `aal` (10), `amr[].method` and `amr[].timestamp` (7-8), `app_metadata.provider` with default "email" (5, 9), `user_metadata.full_name` / `user_metadata.name` (6, 18), `user_metadata.email_verified` and top-level `email_verified` (6, 17), `iss` (23), `iat` (22, 24), `exp` (25). emailVerified is true when either flag is true, or when both are absent and the provider is not `email` (17); an unverified email is refused with `email_unverified` (identity.ts:28).

18. AAL2 DETERMINATION: aal2 is decided solely by the `aal` claim being the string "aal2" (claims.ts:10). The amr methods `totp`, `mfa/totp` and `webauthn` (claims.ts:11) do not decide aal2; they only supply `mfaVerifiedAt` (used by break-glass, D25); when aal2 but none of them is present, mfaVerifiedAt falls back to `iat` (claims.ts:22). Staff (domain or platform role) are refused `staff_provider_required` unless provider === "azure" (identity.ts:29) and `mfa_required` unless aal === "aal2" (identity.ts:30; requireStaffMfa is hard-coded true at auth.ts:52). Administrator and recruiter routes additionally refuse any session whose stored aal is not aal2 (apps/api/src/middleware/session.ts:75-82, 84-90).

19. STAFF MFA IS SUPABASE MFA, NOT ENTRA MFA: the code only sees Supabase's own `aal`/`amr` claims (claims.ts:7-11). MFA done inside Microsoft (Security defaults / Conditional Access) is invisible to the Supabase token, which records the provider sign-in as an `oauth` amr entry at aal1. Every doc agrees the second factor is Supabase TOTP (docs/spec/00:165 D19 "TOTP MFA with the aal2 claim"; docs/spec/09:18; docs/spec/12:101; 13:67; 17:35; 19:30 "Auth (Microsoft, Google, TOTP)"; docs/readiness/03:21). Therefore TOTP must be enabled in the recruiting-os-staging project (Authentication -> Multi-Factor). Enforcement is done by the application (identity.ts:30), not by a Supabase setting.

20. CODE GAP: nothing in the repository enrols a TOTP factor or performs a Supabase MFA challenge/verify (grep for enroll/enrol/factors/mfa./@supabase across apps/ and packages/ finds only tests asserting `mfa_required`). The PKCE exchange returns the access token immediately after the OAuth step (supabase.ts:35-43), the application never holds the Supabase session (supabase.ts:8), and no supabase-js client exists in the web app. As written, a staff Microsoft sign-in in staging will yield aal1 and be refused with `mfa_required` (identity.ts:30); the checklist step "Microsoft sign-in as an ITS staff member with TOTP" (03:21; 17:35 "/api/v1/auth/me shows aal2") cannot pass until an enrolment and challenge step exists (or the `POST /api/v1/auth/session` JSON route at auth.ts:100-114 is fed an aal2 token obtained elsewhere).

21. REDIRECT URL THE APP SENDS: `redirect_to = ${APP_BASE_URL}/api/v1/auth/callback` (auth.ts:72; authRoutes mounted at /api/v1/auth in apps/api/src/app.ts:72; supabase.ts:28). Supabase only honours a redirect_to that matches its Site URL or Redirect URLs allow list, so the staging project must list exactly `https://<staging APP_BASE_URL host>/api/v1/auth/callback` under Authentication -> URL Configuration -> Redirect URLs (and `http://localhost:3001/api/v1/auth/callback` if a laptop is ever pointed at the staging project). The staging host is the Vercel preview URL per 17:24; the docs never mention Supabase's redirect allow list or Site URL at all (grep over docs/ finds nothing).

22. REDIRECT URI ON THE ENTRA SIDE (distinct from the above): the registration's Web redirect URI is Supabase's callback `https://<project-ref>.supabase.co/auth/v1/callback` (13:64; 19:31), which the application never sends. So the staging project ref is needed in two non-secret places: SUPABASE_URL and the Entra redirect URI.

23. SUPABASE DASHBOARD DESTINATIONS FOR SECRETS (never application variables): the Entra client id and client secret go into Supabase -> Authentication -> Providers -> Azure (13:66, 13:216; 17:32-34); the Google sign-in client likewise into Providers -> Google (13:110, 13:217). The code holds no Microsoft credentials (registry.ts:63-65 passes only url, anonKey, jwtSecret, providers).

24. NON-SECRET IDENTIFIERS THE CODE/CONFIG ACTUALLY NEEDS: (1) the recruiting-os-staging project ref, i.e. the `https://<ref>.supabase.co` API URL (for SUPABASE_URL and the Entra redirect URI); (2) the project's region (Oregon / us-west-1, documentation only; 13:51); (3) the stable staging hostname that APP_BASE_URL/WEB_BASE_URL will use (for the redirect allow list); (4) the Entra registration's display name and application (client) id (documentation only; it is entered in Supabase, 17:33); (5) which JWT signing mode the project uses (legacy HS256 shared secret vs asymmetric signing keys), because that decides whether SUPABASE_JWT_SECRET must be entered in Vercel or can be omitted in favour of JWKS (jwt.ts:37-48). The anon key is publishable but per 19:30 is entered by Nadine into Vercel, not sent in chat.

25. DOC-VS-CODE CONTRADICTION 1: docs/spec/13:55 and 13:189 name `SUPABASE_JWT_ISSUER` ("or SUPABASE_JWT_SECRET", planned, Vercel); no code reads it. The issuer is always derived from SUPABASE_URL (supabase.ts:18-20).

26. DOC-VS-CODE CONTRADICTION 2: docs/spec/13 appendix A marks SESSION_SECRET (13:177) and COOKIE_DOMAIN (13:176) "retiring with Supabase Auth" and WEB_BASE_URL (13:174) as merging into APP_BASE_URL; the code still requires SESSION_SECRET in production (env.ts:131; rate-limit.ts:107), reads COOKIE_DOMAIN (auth.ts:34) and uses WEB_BASE_URL separately (auth.ts:79, 92).

27. DOC-VS-CODE CONTRADICTION 3: docs/spec/13:55 and appendix A (13:178-182) say values go into "Vercel and Trigger.dev"; Trigger.dev is deferred and the worker host is Railway (docs/spec/19:117-121, 19:144). The worker environment still needs AUTH_PROVIDER, SUPABASE_URL, SUPABASE_ANON_KEY (env.ts:134-135 via worker.ts:7) but not SUPABASE_JWT_SECRET, which 13:181 assigns to the worker too.

28. DOC-VS-CODE CONTRADICTION 4: .env.example:1 says every variable is documented in docs/14-deployment-and-environment.md, but docs/14 contains no row for AUTH_PROVIDER, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_JWT_SECRET, AUTH_SIGNIN_PROVIDERS, ITS_STAFF_EMAIL_DOMAINS, BOOTSTRAP_ADMIN_EMAILS or MAGIC_LINK_ENABLED (grep empty; only COOKIE_DOMAIN and SECRET_STORE mention sign-in or Supabase, docs/14:32-33).

29. DOC-VS-CODE CONTRADICTION 5: docs/spec/19:31 lists the Entra "application (client) id and tenant id" as non-secret identifiers Claude will need; the code never uses a tenant id, and with the documented account type "Accounts in any organizational directory and personal Microsoft accounts" (13:63) the Supabase Azure provider's optional tenant setting should stay at its default so personal and customer-tenant accounts can sign in.

30. DOC-VS-CODE CONTRADICTION 6: 13:67 ("TOTP enrolment is enforced for staff afterwards"), 17:35 and 03:21 assume the sign-in flow includes TOTP; the code has no enrolment or challenge step (see CODE GAP above), it only refuses an aal1 staff token.

31. CUSTOMER SIGN-IN: customers (any non-staff domain, no platform role) may sign in with azure or google at aal1; only emailVerified is required (identity.ts:27-31). A personal Microsoft account signing in as a test customer (13:67) works only if the Entra registration allows personal accounts (13:63).

UNCERTAINTIES:
1. Whether recruiting-os-staging issues HS256 (legacy shared JWT secret) or ES256/RS256 (asymmetric JWT signing keys) tokens was not verified; it is a per-project Supabase setting. If HS256 and SUPABASE_JWT_SECRET is not set in Vercel, every sign-in fails with `unsupported_algorithm` (jwt.ts:38). Check Project Settings -> JWT (signing keys) in the dashboard before deciding whether the secret must be entered.

2. The exact current labels of the Supabase dashboard screens (Authentication -> URL Configuration -> Redirect URLs; Authentication -> Multi-Factor -> TOTP; Providers -> Azure incl. the optional tenant URL field) were stated from general knowledge of the product, not read from Supabase documentation in this task.

3. The stable staging hostname for APP_BASE_URL/WEB_BASE_URL is not named in the docs (17:24 says "the preview URL"); Vercel preview URLs vary per deployment unless a fixed alias or branch domain is used, so the redirect allow-list entry cannot be written until that host is chosen.

4. Supabase's own default OAuth scopes for the azure provider (which apply in addition to the `openid profile email` the code passes) and for google (no scopes passed) were not checked; they do not include calendar scopes but may add e.g. offline_access.

5. Observation, not a config need: SupabaseIdentityProvider.authorizeUrl never places the app's `state` on the Supabase authorize URL (supabase.ts:24-33; the fake at fake.ts:30 does), and the callback tolerates a missing returned state (auth.ts:84-85). CSRF binding rests on the PKCE cookie alone; a reviewer may want to confirm that is intended.

6. Whether the Supabase TOTP challenge can be completed for staff without new application code (for example via a supabase-js page added to the web app, or an operator-run script feeding `POST /api/v1/auth/session`) is a design question the docs do not answer; the finding here is only that no such code exists today.