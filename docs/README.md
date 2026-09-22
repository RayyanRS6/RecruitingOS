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

Implementation status by slice is tracked in [STATUS.md](STATUS.md).

Release-1 production specification (14 September 2026, awaiting founder approval): [spec/README.md](spec/README.md). It begins with a decisions register of contradictions, open decisions, security risks, compliance questions, and simulated behavior; the ten documents that follow are the build contract for the first release.
