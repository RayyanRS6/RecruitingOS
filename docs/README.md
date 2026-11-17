# Recruiting OS documentation

What is in this folder, one line per file. Start with [PRODUCT.md](PRODUCT.md): it wins over every other document. How to run the app is in the [root README](../README.md), and the guide for developers and AI agents is [AGENTS.md](../AGENTS.md).

A document here may still cite a decision id or a document from the earlier, larger design (HF-8, known-bugs row 159, the staging verification checklist). Those are in git history, at commit `199c94f` and before: `git show 199c94f:docs/README.md` lists what was there.

## The product

| File | What it is |
|---|---|
| [PRODUCT.md](PRODUCT.md) | What the product is: the flow, the decisions, and what is never cut |
| [DECISIONS.md](DECISIONS.md) | The decisions and open items still in force: sign-in, plans, AI models, fairness, hosting, email, legal |
| [07-ux-and-design-system.md](07-ux-and-design-system.md) | The design system and the "Words on screen" lists |

## Runbooks

| File | What it is for |
|---|---|
| [production-setup.md](runbooks/production-setup.md) | Production from new accounts to go-live, every later release, rollback and hotfix |
| [release-migrations.md](runbooks/release-migrations.md) | Release day with a pending migration: migrate first, deploy second |
| [railway-worker.md](runbooks/railway-worker.md) | The worker on Railway: its variables, health check and deployments |
| [resume-storage.md](runbooks/resume-storage.md) | The private CV bucket: uploads, quarantine and malware scanning |
| [staff-second-factor.md](runbooks/staff-second-factor.md) | Staff sign-in with an authenticator: enrolment, backup, reset |
| [privacy-requests.md](runbooks/privacy-requests.md) | Handling a candidate's privacy request within its deadline |
| [fairness-tests.md](runbooks/fairness-tests.md) | The "Run fairness tests" button: how to run it and what it checks |

## Legal drafts

Drafts for a lawyer. None is approved, and none may be sent or shown to anyone until a lawyer returns it.

| File | What it is |
|---|---|
| [README.md](legal-drafts/README.md) | The status of the drafts, and which register item each one answers |
| [counsel-register.md](legal-drafts/counsel-register.md) | Every question for the lawyer, with the wording under review |
| [data-retention-matrix.md](legal-drafts/data-retention-matrix.md) | How long each kind of data would be kept: proposed, waiting for the lawyer |
| [01-design-partner-pilot-agreement.md](legal-drafts/01-design-partner-pilot-agreement.md) | The pilot agreement for one unpaid partner |
| [02-candidate-privacy-notice.md](legal-drafts/02-candidate-privacy-notice.md) | The privacy notice candidates read |
| [03-ai-use-disclosure.md](legal-drafts/03-ai-use-disclosure.md) | The AI-use disclosure candidates read |
| [05-eligibility-question-policy.md](legal-drafts/05-eligibility-question-policy.md) | Which screening questions a job may ask |
| [06-human-review-and-rejection-policy.md](legal-drafts/06-human-review-and-rejection-policy.md) | People decide; nobody is rejected by software |
| [08-candidate-privacy-request-runbook-summary.md](legal-drafts/08-candidate-privacy-request-runbook-summary.md) | The privacy-request process, in short |
| [09-subprocessor-list.md](legal-drafts/09-subprocessor-list.md) | The outside services that touch candidate data |
| [10-proposed-retention-schedule.md](legal-drafts/10-proposed-retention-schedule.md) | The retention schedule proposed for the agreement |
| [11-founding-partner-agreement-additions.md](legal-drafts/11-founding-partner-agreement-additions.md) | Additions to the agreement for a paid customer |
| [12-free-plan-terms.md](legal-drafts/12-free-plan-terms.md) | Short terms for a tester on the Free plan |

## Kept where they are because the app or CI names their path

To be moved or folded when the code that names them changes.

| File | What it is |
|---|---|
| [11-evaluation-framework.md](11-evaluation-framework.md) | The AI evaluation suites and the real-model run (named by `packages/evals`) |
| [14-deployment-and-environment.md](14-deployment-and-environment.md) | Local setup and every environment variable (named by `.env.example`) |
| [staging-environment-variables.md](runbooks/staging-environment-variables.md) | The variables of the staging copy on Vercel (named by a start-up error) |
| [13-administrator-bootstrap.md](readiness/13-administrator-bootstrap.md) | How the first platform administrator is made, and the ledger of administrators |
| [15-rate-limiting-provider.md](readiness/15-rate-limiting-provider.md) | Rate limiting and its shared store |
| [18-content-security-policy.md](readiness/18-content-security-policy.md) | The content-security policy, and how enforcing it is earned |
| [20-real-data-readiness-plan.md](readiness/20-real-data-readiness-plan.md) | What must be proven before real candidate data |
| [17-staging-handoff.md](spec/17-staging-handoff.md) | The staging hand-off package (named by a start-up warning) |
