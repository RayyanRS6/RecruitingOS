# 08. Compliance and security architecture

This document describes architecture, not legal advice. Items marked **[counsel]** require attorney review before the affected feature is used with paying customers. Doc 00 §E lists them.

## Compliance by design

### Principle: regulation is configuration

Legal obligations change by jurisdiction and by year. The product therefore has:

- A **jurisdiction resolver**: for each candidate touch, the applicable jurisdictions are the company's location(s), the role's location(s), and the candidate's stated location. Rules attach to jurisdictions.
- A **notice registry** (`packages/core/src/compliance/notices.ts` and rows in `company.settings.notices`): versioned notice texts keyed by purpose (`ai_use`, `recording`, `sms_consent`, `privacy`, `pay_transparency`, `adverse_decision_explanation`) and jurisdiction. The platform ships defaults; ITS updates them; customers may add company text; every display is logged with the version shown.
- **Consent as data**: `candidates.consent` records each purpose with `granted`, `at`, `source` (apply form, SMS reply, spoken), `notice_version`, and `ip` where applicable. Adapters refuse actions that lack the required consent.
- **Retention classes**: `company.settings.retention` sets days per class (application data, assessments, transcripts, communications, documents), defaulting to four years for decision data (California) and the customer's choice above that. A purge job anonymizes or deletes on schedule and writes `audit_records`.
- **Policy engine** (doc 06) enforces the human-decision boundary for rejections, hiring, compensation, and adverse actions.

### Obligations mapped to mechanisms

| Obligation (as of Sept 2026) | Mechanism |
|---|---|
| Illinois HB 3773: notice when AI is used in recruitment or hiring; no zip-code proxies **[counsel: text and timing]** | `ai_use` notice shown at apply and on the first automated message for roles or candidates in Illinois (shown everywhere by default); eligibility rule types exclude geography except a bona fide `location_radius` with rationale; the eval suite tests zip and geography neutrality |
| Illinois AI Video Interview Act | No video analysis is performed; if a customer uploads video, only audio is transcribed with consent |
| California CRC ADS regulations: discrimination liability, four-year retention, ADS assessments as medical inquiries **[counsel: which artifacts are ADS data]** | Retention default 4 years for assessments, screens, decisions; no personality games or health-related questions in screens (schema-restricted question types) |
| NYC Local Law 144: bias audit and notice for AEDTs **[counsel: whether owner-authored eligibility rules or our assessments "substantially assist"]** | Assessment is information only; the audit-ready export produces selection rates by stage for self-reported categories; notice text available; a partner auditor referral in Setup for NYC customers |
| Colorado SB 26-189 (Jan 2027): adverse-decision notice, explanation, appeal | `adverse_decision_explanation` notice with the evidence-based reasons from the human decision record; an appeal channel routed to the compliance queue |
| Texas TRAIGA | Documentation: the model card and the ai_runs ledger |
| Federal Title VII, ADEA, ADA; Mobley v. Workday agent theory | Human-only rejection on judgment; evidence-based assessments; bias monitoring; vendor terms allocate responsibility and describe the tool's function |
| TCPA and A2P 10DLC **[counsel: consent language]** | Separate SMS consent at apply (unchecked), keyword opt-out (STOP), quiet hours per candidate time zone, campaign registration, consent record with source and timestamp |
| Recording consent (all-party states) and BIPA **[counsel: scripts; voiceprint analysis]** | Recording requires explicit consent from every participant; spoken consent is captured and stored; no speaker identification or voice biometrics; transcripts are text |
| FCRA (background checks; reference automation) **[counsel: our status]** | Background checks only through Checkr with its disclosure and adverse-action flows; adverse action is human-only; reference automation is disabled until cleared |
| Pay transparency laws (CA, CO, NY, WA and others) | Packet `compensation.disclose_range` is forced on for roles in listed jurisdictions; the job page renders the range |
| CCPA/CPRA and GDPR: notice, access, deletion, correction, purpose limitation **[counsel: DPA and privacy notice]** | Privacy page and notice at collection; data-request intake for candidates with identity verification; deletion and export workflows (`data.delete`, `data.export` human-only, audited); service-provider terms with customers; no cross-tenant use |
| EEOC recordkeeping | Retention classes; the events log |

### Bias monitoring and explainability

- **Every assessment stores its factors and evidence**, the packet version, the prompt version, and the model. Any decision can be reconstructed.
- **Selection-rate monitoring**: a quarterly job computes pass rates by stage for self-reported categories (voluntary, separate from the application, never visible to reviewers) where counts allow; the four-fifths rule is a screen, with results to the compliance queue.
- **Prompt-level controls**: protected characteristics and proxies are excluded by instruction and tested by the eval suite (doc 11) on every prompt change.
- **Model card**: a public document describing what the system does and does not do, which decisions are human, and how to request an explanation.
- **Explainability to candidates**: on request, the evidence-based reasons recorded with the human decision (never the raw assessment text without review).

### Candidate rights

Access, correction, deletion, opt-out (SMS, email, talent pool), human alternative to any AI interaction, explanation of adverse decisions where required, withdrawal at any time, complaint intake. All routed through the tenant's compliance queue with SLAs, logged.

## Security architecture

### Identity and access

- Passwordless magic links (single use, 15 minutes, hashed, rate-limited); signed httpOnly sameSite=lax session cookies; 30-day idle expiry; session list and revocation in Setup.
- Roles: owner, admin, hiring_manager, interviewer, hr, recruiter (tenant); its_recruiter, platform_admin (platform). Object-level predicates in `packages/core/src/permissions.ts`.
- Candidates authenticate with signed, scoped, expiring tokens embedded in links (apply status, screen, schedule, offer); tokens are bound to the application id and purpose.
- Platform admins operate under a separate database role; RLS bypass is explicit per request and every bypass writes an audit record.

### Data protection

- TLS everywhere; HSTS; secure cookies; CSP on the web app and candidate pages.
- Encryption at rest by the managed database and object store; integration credentials additionally encrypted with AES-256-GCM under `APP_ENCRYPTION_KEY` with key ids for rotation.
- Data minimization: no SSN, bank, government ID, or health data is collected; the HRIS owns those; resume content is stored as text and file with retention.
- Tenant isolation: RLS on every tenant table; tests attempt cross-tenant reads.
- Documents served through signed, time-limited URLs; uploads validated for size and type; scanning hook.

### Application security

- Input validation with Zod on every boundary; parameterized SQL via the ORM; output encoding in SSR pages.
- Rate limiting per IP and per tenant on public and authenticated routes; stricter on apply, screen, and magic links.
- Abuse prevention on public forms: honeypot fields, timing checks, per-IP and per-email limits, duplicate suppression.
- Webhooks verified by signature (Postmark, Twilio, Stripe, e-sign).
- Dependency policy: lockfile, audit in CI, minimal dependencies.

### Operations

- Backups: managed Postgres point-in-time recovery; object storage versioning; restore drill quarterly in staging.
- Disaster recovery: infrastructure as configuration; documented RTO 4 hours, RPO 15 minutes for the database.
- Monitoring: health endpoints (API, worker, queue depth, oldest waiting job), error tracking, failed-run alerts, cost anomaly alerts (tokens, SMS, voice per tenant per day).
- Incident response: an on-call rotation, a runbook, customer notification templates.
- SOC 2 Type II: begin readiness by month 12 with an automation platform; controls above map to it.

### Threat model highlights

| Threat | Control |
|---|---|
| Cross-tenant data access via a bug | RLS at the database; tests |
| Stolen session cookie | httpOnly, secure, short idle expiry, revocation, IP change re-verification for admin |
| Malicious resume upload | Type and size checks, no execution, scanning hook, text extraction in a sandboxed step |
| Prompt injection via resume or candidate message | Untrusted content is delimited and labeled as data in prompts; structured outputs; no tool that takes free-text instructions from candidate content; evals include injection cases |
| Spam applications and bots | Rate limits, honeypot, duplicate detection, anomaly flags |
| Integration credential leak | Encrypted at rest, never logged, scoped tokens, rotation |
| Insider misuse (platform admin) | Explicit bypass, audit records, least privilege, quarterly access review |
| Candidate data over-retention | Retention classes and purge jobs |
