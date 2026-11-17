# Legal drafts for attorney review

**Founder decision of 22 September 2026 (risk R-LEGAL-1, `docs/DECISIONS.md`): counsel review is deferred; the first controlled real-candidate pilot proceeds under these drafts, labelled unreviewed and not attorney-approved, with the risk accepted by the founder and raised again before paid customers, other jurisdictions, SMS, recording, automated rejection or broader release. This label stays on every draft until counsel returns it.**

**Every document in this folder is a draft prepared by the production team for review by Identified Talent Solutions' counsel. None is legally approved, none has been reviewed by an attorney, and none may be sent to a design partner or shown to a candidate until counsel returns it and the founder records the approval in `docs/legal-drafts/counsel-register.md` (the counsel register).** Product text that already appears in the software (notices, disclosures, consent language) is marked as such; counsel's edits flow back into the code through `packages/core/src/compliance.ts`.

| # | Draft | Counsel register item | Where it will be used |
|---|---|---|---|
| 01 | Design Partner pilot agreement | 14 | signed before each partner's real data |
| 02 | Candidate privacy notice | 16 (privacy policy), 1 | `/privacy`, application form, status page |
| 03 | AI-use disclosure | 1 | application form, every candidate message, screening |
| 05 | Eligibility-question policy | 3 | packet compilation; owner guidance |
| 06 | Human-review and rejection policy | 3, 4, 8 | product policy engine; customer-facing explanation |
| 08 | Candidate privacy-request runbook (summary) | 6 | `docs/runbooks/privacy-requests.md` |
| 09 | Subprocessor list | 19 (and exhibit to 14; input to 16) | pilot agreement exhibit; privacy notice |
| 10 | Proposed retention schedule | 9, 31, 35 | `docs/legal-drafts/data-retention-matrix.md` |
| 11 | Founding Partner Agreement additions (fees, term, support, limitations, security, data processing, subprocessors, job boards) | 14 (paid conversion; R-LEGAL-1 stop point) | drafted 30 September 2026 for counsel or the founder's separate acceptance before the first invoice; its exhibits were the customer documents (see the last note) |
| 12 | Free plan terms for testers | 15, 32 (R-LEGAL-1 raised again 5 November 2026) | drafted 6 November 2026 for counsel; to be signed by each tester before a real job, once the founder has accepted the risk or counsel has answered |

**The plans of 5 November 2026** (`docs/DECISIONS.md`) change what several of these drafts describe: software now hides some applicants from the employer by a plan limit. Drafts 01, 02, 03, 06, 08, 10 and 11 carry a dated note where this bears on them; the questions are items 27 to 34 of `docs/legal-drafts/counsel-register.md`. Nothing in those notes is approved or in force.

**Drafts 04 (SMS consent language) and 07 (recruiter-access summary) were removed with texting and recruiter access.** Drafts 01 and 11 still list them as exhibits D-2 and H, and list exhibits whose documents are no longer in the repository: the customer documents (the service description, the security overview, the support statement, the onboarding checklist and the two guides), the security checklist and the operational subprocessor register. All of them are in git history, at commit `199c94f` and before. The exhibit lists themselves are for whoever next revises those drafts.
