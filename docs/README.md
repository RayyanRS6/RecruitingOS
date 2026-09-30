# Recruiting OS documentation

Governing context: [FOUNDER-CONTEXT.md](FOUNDER-CONTEXT.md) (the consultant-completed founder intake, 14 September 2026) and [17-founder-context-reconciliation.md](17-founder-context-reconciliation.md) (what it changed and what remains sequenced).

The product requirements document is the set of documents below, read in order. They are kept in sync with the code; a pull request that changes behavior updates the matching document.

| # | Document | What it settles |
|---|---|---|
| 00 | [Strategy reassessment](00-strategy-reassessment.md) | What changed after challenging the strategy memo; the ten questions |
| 01 | [Product thesis](01-product-thesis.md) | The locked thesis, non-negotiables, business modes, first vertical |
| 02 | [Product architecture](02-product-architecture.md) | Five layers, the Role Packet, two modes, Recruiter on Demand, candidate experience, admin, playbooks, billing, learning, metrics, customer success |
| 03 | [Technical architecture](03-technical-architecture.md) | Stack, topology, AI layer, integration layer, security summary, dev environment |
| 04 | [Data model and events](04-data-model-and-events.md) | Every table, relationships, indexes, tenancy, permissions, lifecycle states, the event taxonomy |
| 05 | [Agents](05-agents.md) | The seven agents and the orchestrator |
| 06 | [Workflows, policy, state machine](06-workflows-policy-and-state-machine.md) | Workflow catalog, resilience matrix, policy defaults, the application state machine |
| 07 | [UX and design system](07-ux-and-design-system.md) | Owner Mode, Recruiter Mode, candidate experience, tokens and components |
| 08 | [Compliance and security](08-compliance-and-security.md) | Regulation as configuration, obligations to mechanisms, bias monitoring, security controls, threat model |
| 09 | [Roadmap](09-roadmap.md) | 0 to 3, 3 to 6, 6 to 12, 12 to 18, 18 to 24 months, year 3, with per-feature attributes |
| 10 | [Repository structure](10-repository-structure.md) | Folders and boundaries |
| 11 | [Evaluation framework](11-evaluation-framework.md) | Suites, fixtures, release gates |
| 12 | [API contracts](12-api-contracts.md) | Route map; schemas live in `packages/contracts` |
| 13 | [Test plan](13-test-plan.md) | Levels, the end-to-end scenario, failure injection, definition of done |
| 14 | [Deployment and environment](14-deployment-and-environment.md) | Local setup, environment variables, production topology, release |
| 15 | [Integrations](15-integrations.md) | Every adapter and its status |
| 16 | [Admin](16-admin.md) | The internal console and the six questions |

The current state of the product (what is built, what tests prove, what needs a CI run, what only the founder can do before a deploy, and the decisions still open) is in [STATUS.md](STATUS.md), updated 30 September 2026, followed by the history by slice. A developer joining the team starts with [handoff/developer-onboarding.md](handoff/developer-onboarding.md).

Release-1 production specification (14 September 2026, awaiting founder approval): [spec/README.md](spec/README.md). It begins with a decisions register of contradictions, open decisions, security risks, compliance questions, and simulated behavior; the ten documents that follow are the build contract for the first release.

## Runbooks (`runbooks/`)

Step-by-step procedures for the team and the founder. The two marked new were written with the release-1 completion work on 30 September 2026.

| Runbook | What it is for |
|---|---|
| [release-migrations.md](runbooks/release-migrations.md) (new) | Release day with a pending migration: migrate first, deploy second; the `migrate` GitHub workflow or `pnpm db:migrate`; reading the status output; what the boot refusal looks like |
| [candidate-replies.md](runbooks/candidate-replies.md) (new) | Where candidate email replies land with and without the inbound mail domain, the per-application reply address, the HUMAN reply, and the checks |
| [railway-worker.md](runbooks/railway-worker.md) | The worker on Railway: variables, the health check, first deployment |
| [resume-storage.md](runbooks/resume-storage.md) | The private résumé bucket, direct uploads, quarantine, scanning, and running ClamAV on Railway |
| [staging-environment-variables.md](runbooks/staging-environment-variables.md) | The variables entered in Vercel for the staging Preview of `main` |
| [staging-database-setup.md](runbooks/staging-database-setup.md) | First-time setup of the staging database roles and grants, and how to resume an interrupted run |
| [staff-second-factor.md](runbooks/staff-second-factor.md) | ITS staff sign-in with an authenticator: enrolment, backup, reset |
| [privacy-requests.md](runbooks/privacy-requests.md) | Handling candidates' privacy requests with deadlines |

## Customer documents (`customer/`)

Drafted 30 September 2026 for the Founding Partner Program and checked again the same day against the finished release-1 work (the posting flow, the report, the team screens, the audit history, the privacy-request form), awaiting founder review (`spec/21` section 3). Written for a small-business owner or office manager and their hiring manager; every claim was checked against the product's screens and code. Nothing in this folder may be given to a customer until the founder signs it off.

| # | Document | What it is for |
|---|---|---|
| 01 | [What you get and what is not included](customer/01-what-you-get-and-what-is-not-included.md) | The feature and limitation sheet with the honest statements; becomes Exhibit A of the agreement |
| 02 | [Security overview](customer/02-security-overview.md) | Where data lives, who can see it, recruiter access, candidate protection, what is recorded, deletion, the customer's own duties; becomes Exhibit B |
| 03 | [Support expectations](customer/03-support-expectations.md) | Hours, channels, response times by business hours as the product computes them, what support covers, how incidents are communicated; becomes Exhibit I |
| 04 | [Onboarding checklist](customer/04-onboarding-checklist.md) | The ordered steps from signing to the first candidate, who does each, what to have ready, and week one |
| 05 | [Administrator guide](customer/05-administrator-guide.md) | For the owner: sign-in, creating the company, invitations, roles and removal, Setup (the company card, sessions, "confirm it's you", the audit history), the daily brief, posting, the report, recruiters, outcomes, closing, privacy, Development mode |
| 06 | [Hiring manager guide](customer/06-hiring-manager-guide.md) | For the person running a hire: intake, the packet, approval, the Posting tab and the accepting switch, Talent and "Needs a closer look", comparing candidates, screens, scorecards, interviews, the decision after an interview, declines, outcomes, writing to candidates, the report |
| legal 11 | [Founding Partner Agreement additions](legal-drafts/11-founding-partner-agreement-additions.md) | Draft sections for counsel: fees, term, support, limitations, security, data processing, subprocessors, job boards; bracketed placeholders for the founder's decisions |
