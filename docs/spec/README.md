# Release-1 specification set

Prepared 14 September 2026 for founder approval. Read `00` first: it lists every contradiction, open decision, security risk, compliance question, and simulated behavior found while writing the specification, with a recommendation and a default for each. The remaining documents are written against those defaults. No production code for release 1 starts until the founder answers the checklist at the end of `00`.

| # | Document | Settles |
|---|---|---|
| 00 | [Decisions register](00-decisions-and-risks.md) | Contradictions, open decisions (D), security risks (S), compliance questions (C), simulated actions (P), approval checklist |
| 01 | [MVP product requirements](01-mvp-prd.md) | Goal, scope, personas, the thirteen-step workflow with acceptance criteria, AI boundaries, functional and non-functional requirements, metrics, release criteria |
| 02 | [Roles and permissions](02-roles-and-permissions.md) | Actors, permission matrix, platform roles, policy levels, approvals, candidate tokens, tenancy |
| 03 | [Service blueprint](03-service-blueprint.md) | Frontstage, backstage, AI, policy, data, events, failure, human path, metrics per stage |
| 04 | [Screens and states](04-screens-and-states.md) | Every screen, route, action, state, message, and notification |
| 05 | [Database schema](05-database-schema.md) | Tables by status, modifications, new tables, indexes, retention, migrations |
| 06 | [Workflow state machines](06-workflow-state-machines.md) | Application, role, screen, interview, escalation machines; every workflow including `schedule_interview` |
| 07 | [API specification](07-api-specification.md) | Every endpoint marked existing, changed, or new; schemas; error codes |
| 08 | [AI architecture and evals](08-ai-architecture-and-evals.md) | Tasks, models, code guards, runtime behavior, spend cap, injection defenses, eval suites and the live-model gate |
| 09 | [Security and privacy](09-security-and-privacy.md) | Identity, tenancy, database roles, credential encryption, public-surface hardening, privacy, compliance mapping |
| 11 | [Counsel-decision register](11-counsel-register.md) | The fourteen items counsel must approve; unresolved items block only the affected feature |
| 12 | [Account setup checklist](12-account-setup-checklist.md) | Governing version (15 Sep 2026): current ITS facts, ownership rules, addresses, DNS rules, hostnames, vault, authentication, calendar decision, creation sequence |
| 13 | [Account-creation worksheet](13-account-creation-worksheet.md) | Founder-facing: per service, signup URL, owners, billing, recovery, MFA, region, plan, spend limit, roles, environment and project names, DNS, environment-variable names, verification, revocation, rotation |
| 10 | [Test and deployment plan](10-test-and-deployment-plan.md) | Test levels, CI, environments, infrastructure, release process, monitoring, runbooks, pilot rollout, exit criteria |

Founder decisions of 15 September 2026 (section I of `00`) govern account setup, authentication, infrastructure, counsel review, and release 1; they replace conflicting defaults in earlier drafts.

Relationship to the existing documents: `docs/00` to `docs/17` remain the long-range design; where this set and those differ for release 1, this set governs and `00` records the difference.


Application shell (18 Sep 2026, D20): `apps/shell` is the Next.js application deployed to Vercel; it mounts the Hono API and candidate pages unchanged and renders the existing React interface client-side while pages are ported. `pnpm --filter @ros/shell dev` runs everything on one port (3000).

Browser journeys and accessibility (18 Sep 2026): `pnpm e2e` starts the shell on port 3010 with every provider faked and runs `tests/e2e/specs` in Chromium with axe checks on each page. The shell keeps one container per process, so restart `next dev` after changing API code; the React pages hot-reload.

Production readiness (18 Sep 2026): `docs/readiness/01` to `12` (register, route inventory, staging checklist, incident response, backup and recovery, credential rotation, subprocessors, data-flow map, retention matrix, security and accessibility checklists, pilot support runbook). Legal drafts for attorney review: `docs/legal-drafts/` (not approved). Staging handoff: `docs/spec/17`. Scenario steps 11 to 16: `docs/spec/15`. Route inventory: `docs/spec/16`.
