# Recruiting OS documentation

What is in this folder, one line per file. How to run the app is in the [root README](../README.md), and the guide for developers and AI agents is [AGENTS.md](../AGENTS.md). The code wins over every document: when a statement matters, open the file it names.

## The product

| File | What it is |
|---|---|
| [PRODUCT.md](PRODUCT.md) | What the product is: the flow, who may do what, stages, the two scores, and what is never cut |
| [DECISIONS.md](DECISIONS.md) | The decisions and open items around it: sign-in, plans, AI models, fairness, hosting, email, legal |
| [07-ux-and-design-system.md](07-ux-and-design-system.md) | The screens, the "Words on screen" lists and the design system |
| [11-evaluation-framework.md](11-evaluation-framework.md) | The AI evaluation suites and how to run them on the stand-in AI and on the real models |
| [14-deployment-and-environment.md](14-deployment-and-environment.md) | Where the app runs, what a process checks at start, every environment variable, rate limits and the browser policy |

## Runbooks

| File | What it is for |
|---|---|
| [production-setup.md](runbooks/production-setup.md) | Production: setup, secrets and their rotation, the first administrator, every release, the check with made-up people, rollback and hotfix |
| [release-migrations.md](runbooks/release-migrations.md) | Release day with a pending migration: migrate first, deploy second |
| [railway-worker.md](runbooks/railway-worker.md) | The worker on Railway: its settings, how a stopped worker is noticed and brought back |
| [resume-storage.md](runbooks/resume-storage.md) | The private resume bucket: uploads, quarantine, malware scanning, key rotation |
| [staff-second-factor.md](runbooks/staff-second-factor.md) | Staff sign-in with an authenticator: enrolment, backup, reset |
| [privacy-requests.md](runbooks/privacy-requests.md) | Handling a candidate's privacy request within its deadline |
| [fairness-tests.md](runbooks/fairness-tests.md) | The "Run fairness tests" button: what it checks and how to run it |

## Legal drafts

Drafts for a lawyer. None is approved, and none may be sent or shown to anyone until a lawyer returns it. They were written before the simple product, and parts of them describe things it no longer does ([DECISIONS.md](DECISIONS.md), F13).

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
