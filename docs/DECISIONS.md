# Decisions still in force

The decisions and open items that still hold for the product in [PRODUCT.md](PRODUCT.md): one line each, with its date and the id it had in the register it came from. A decision about a feature the product no longer has is left out. "The owner" is the person who owns the product (the older registers say "the founder"), and "the platform admin" is the staff side (the older registers say "ITS"). Every decision comes from one of four registers. Three are in git history, read with `git show`: `199c94f:docs/workflow-decisions.md`, `199c94f:docs/spec/00-decisions-and-risks.md` and `199c94f:docs/readiness/16-founder-readiness-checklist.md`. The fourth, [20-real-data-readiness-plan.md](readiness/20-real-data-readiness-plan.md), is still in this folder. New decisions and the owner's sign-offs are added here, dated.

## Sign-in

- **Q2** (7 Oct 2026). Google or Microsoft only: no email-code sign-in, and no passwords of our own (**F11**, 14 Sep 2026). The email sign-in link is a development aid, off by default in production.
- **MS-1** (10 Nov 2026). Microsoft sign-in takes work accounts from any company: one app registration that allows all tenants, and the Tenant URL `https://login.microsoftonline.com/organizations` in both Supabase projects. Microsoft's own page refuses a personal account (outlook.com, hotmail.com), by design; those people use Continue with Google.
- **MS-2** (10 Nov 2026). Three protections keep a stranger out of someone else's account, together: the `xms_edov` claim on the ID token (Supabase marks an address with a false value as unverified, so it is never linked to an existing account by email); **Confirm email** on in both projects, with "Allow users without an email" off; and the app refusing an unverified address (`email_unverified`). Microsoft's own default for multi-tenant apps may also apply, but it was not checked (the registration's `authenticationBehaviors` was not read), and this registration was single-tenant until 10 November 2026, so nothing counts on it.
- **MS-3** (10 Nov 2026). The Graph setting `removeUnverifiedEmailClaim` is not set. It is the fallback only if `xms_edov` cannot be used.
- **MS-4** (10 Nov 2026). No tenant check for staff sign-ins: platform staff are known by their email domain, which can be verified in one tenant only. Requiring the platform's own tenant is optional hardening for later.
- (6 Nov 2026, review.) Whether Supabase's **Confirm email** and **Secure email change** are on is read by a person at release ([production-setup.md](runbooks/production-setup.md), step 1): the app takes the address on a sign-in as proved, and nothing in the code can read that setting.
- **L-17 A** (16 Oct 2026). A person opens one company of their own, and a request counts as one. A second company only through the platform admin.
- **AP-2** (6 Nov 2026). A company that is waiting or declined gets nothing: no company route answers, no AI runs, no money is spent and nothing of theirs is public.
- **AP-4, AP-9** (6 Nov 2026). Decline is not final: no reason is typed, the person cannot send a second request, and accepting later is the undo. Take away access ends every membership and session of a company, and Accept brings everyone back on the same plan.

## Staff second factor

- **F11, I8** (14 and 15 Sep 2026; kept 10 Nov 2026). Platform staff sign in with Microsoft and a second factor, a code from an authenticator app, on every sign-in. A staff session without it is refused, and staff sessions last eight hours.
- (22 Sep 2026.) Enrolment happens on the first sign-in, with a backup authenticator offered and five attempts at a code. Recovery is the backup authenticator, or a reset the owner runs in the sign-in service, because it issues no recovery codes. Steps: [staff-second-factor.md](runbooks/staff-second-factor.md).
- **N2** (21 Sep 2026). Administrator rights come from a ledger, never from a list of addresses in a setting. The first administrator comes from a one-time starter setting that works only while no administrator exists; nobody grants themselves, and the last administrator is protected. Steps: [13-administrator-bootstrap.md](readiness/13-administrator-bootstrap.md).

## Plans and locked applicants

- **PL-1** (5 Nov 2026, as every PL line here). Four public plans. The plans and their names are the owner's request, and the owner left every number to the team. Each number is one edit in `packages/db/src/seed.ts` and reaches a company the next time its plan is applied.

| Plan | Price a month | Jobs | Candidates per job | AI credit | People |
|---|---|---|---|---|---|
| Free | $0 | 1, ever | 5 | $10 in all, never starts again | 2 |
| Basic | $49 | 3 at a time | 25 | $20 a month | 3 |
| Pro | $149 | 10 at a time | 100 | $60 a month | 10 |
| Ultra | $399 | 30 at a time | No limit | $200 a month | No limit |

- **PL-1.** Design Partner stays as a private plan, never in a company's list. Trial, Core, Growth and Company are retired: their rows stay, and Change plan refuses them.
- **PL-2.** A new company starts on Free, active, with no clock and no trial. An existing company does not change until someone changes its plan.
- **PL-3.** One job on Free: a job using a place now, or one that ever went live, counts; a job closed before it ever opened gives its place back. The refusal reads "Your Free plan includes one job. Upgrade to post more."
- **PL-4.** Past the plan's candidates per job, an application is locked. It is decided once, when the application arrives, by arrival order alone and never by a score, so nobody already applying is cut off. A withdrawal, a decline or a deletion gives no place back, and a move down to a smaller plan never locks anyone the team could already read.
- **PL-5.** A locked applicant gets no AI: no CV reading, no AI interview, no AI call on the company's credit. The file is still scanned.
- **PL-6.** A locked applicant never reads a word about a plan or money, and never a promise that is false for them. Their wording is DRAFT WORDING PENDING COUNSEL and keeps every word (`packages/core/src/candidate-lock.ts`).
- **PL-8.** A change of plan opens people oldest first on each job, up to the new limit, each with one event and one audit line.
- **PL-9, PL-13.** The server is the wall: a locked application answers 402 `candidate_locked` before any handler, and lists and counts leave locked people out in the query. On screen a locked person is one card ("Locked", when they applied, "Upgrade to view more candidates."), never a name, initials, a score, a stage or a source.
- **PL-10.** The AI credit is the one meter. Every model call takes a hold first and is refused when what is spent plus the hold would pass the limit less $0.10. Free's credit never starts again, and a move down to Free gives no second $10. A candidate is never stuck, cut off or told. The company's owner gets one notice at 80% and one when it is used up, and reads the credit as words or a percentage, never dollars; the platform admin sees dollars.
- **PL-11.** No payment system. Upgrade sends a request to the platform admin, who changes the plan: "No card is charged", and nothing changes until then.

## AI models

- **D13** (13 Oct 2026). Only Claude Haiku 5.5, for every task, and Claude Sonnet 5.5, only for writing the whole job (`intake.compile`). Never any other model. Moving another task to Sonnet 5.5 needs evidence and a plain explanation first. The allow-list is in `packages/ai/src/routing.ts`: it is checked at start-up, and a call to any other model is refused.
- **P1** (14 Sep 2026). The stand-in AI is for development and tests only; production refuses to start on it.

## Fairness

- (13 Oct 2026; the owner: "the CV screening should be fair".) Each CV and each AI interview is read three times and the middle answer is kept; both scoring readings run at high effort; each finding has one written definition; the candidate is never named in a reading.
- **D-04 C** (14 Oct 2026). The scoring readings never see the name, email, phone, street address, zip code or web links, nor earlier applications and how they ended. The team still sees everything.
- (15 Oct 2026.) A licence, certificate, permit or registration must-have is "no" only when the candidate's own words say plainly they do not hold it. Lapsed, expired, pending or unclear is not known, never "no". Code enforces it after the model answers.
- **AI-24** (13 Oct 2026). A "Run fairness tests" button in GitHub Actions runs the fairness checks on the real model: the CV checks, the AI interview with its scorecard, or the job builder. Results stay in GitHub, not in the repository. Steps: [fairness-tests.md](runbooks/fairness-tests.md).
- **Open** (15 Oct and 6 Nov 2026). The last real-model run on record is of 15 Oct 2026; it passed all 11 CV-reading and scoring checks it ran. No real-model run of the AI interview or of the job builder is on record, and none since the score changed on 6 Nov 2026. Run it before real candidates.
- **LT-31** (17 Nov 2026). The fairness check on a job's wording refuses a ban on a criminal record and a question about one. A background check after an offer is never refused, and "Must pass a background check" is neither refused nor flagged until a lawyer answers.
- (15 Oct 2026.) A company's question about a protected characteristic is refused before it is saved.

## Applying and jobs

- **Q14 A** (7 Oct 2026). Every applicant reads the same receipt, a repeat included, and the status page opens only from the emailed link, so the form never tells anyone whether an address applied before.
- **Q12 B** (7 Oct 2026). A closing date stops new applications at the end of that day. Nobody is rejected by it, and closing the job stays a person's decision.

## Hosting and releases

- (9 Oct 2026.) Keep Vercel, Supabase and Railway: "don't change anything" about hosting. Vercel runs the app, the API included; Railway runs the worker; Supabase holds the database, sign-in and files.
- **Decision 1** (22 and 23 Sep 2026). Background work runs in the product's own engine on the Railway worker. There is no hosted job runner, and moving to one needs its own decision.
- (22 Sep and 16 Oct 2026.) A release to production is a pull request from `main` into the `production` branch, and the full `verify` check is always waited for before a merge.
- (14 Sep 2026.) Migrations are a release step. They never run when the app starts in production.
- **RR-6** (11 Nov 2026). A release that changes how the worker treats work it already knows stops the old worker before it migrates; work waits in the database, and the new worker runs it. No repair at start-up. The order of a release: [production-setup.md](runbooks/production-setup.md), "Every later release".
- **RR-19** (11 Nov 2026). `verify` always runs, so a cancelled run fails the check instead of being skipped, which GitHub would count as passed.
- **F1** (14 Sep 2026). No superuser or row-level-security-bypassing database role: production refuses to start on one. A company's data is reached only through the signed-in person's verified membership.
- **J9** (18 Sep 2026). The app never holds Supabase's service-role key; a policy test guards it.
- **Decision 4** (22 Sep 2026). Request limits are counted in Upstash Redis, United States region, so every server shares one count. Background: [15-rate-limiting-provider.md](readiness/15-rate-limiting-provider.md).
- **N6** (21 Sep 2026). The browser-protection policy (CSP) stays in report-only until its reports have been reviewed; it was still report-only in production on 4 Nov 2026. Background: [18-content-security-policy.md](readiness/18-content-security-policy.md).
- **Blocker 8** (22 Sep 2026). A candidate's file is checked and scanned for malware before anything reads it, and a production worker without a real scanner raises a standing alert. Steps: [resume-storage.md](runbooks/resume-storage.md).
- **I1, I16** (15 Sep 2026). No secret value goes in chat or in the repository. Secrets live only in the providers' own stores and the owner's password vault, and the owner enters them.
- **RR-20, RR-25** (11 Nov 2026). The repository is public. No real person's full name stands beside a company address anywhere in it; `tests/policy/public-repo.test.ts` guards the tree.

## Email

- **A12** (14 Sep 2026). Candidate email is sent from the product's own sending domain through Postmark, not from a customer's mailbox.
- (4 Nov 2026.) Email is **not live** on production: Postmark's account approval is pending and the sending domain is not verified, so every email of the smoke test failed. It waits for the product's new name and its domain, which the owner is choosing.
- (5 Nov 2026, real-data plan, section F.) Email must be live before any real candidate applies: "you hear from us by email" and the status link both depend on it. **PQ-18** asks the owner to confirm this; it is not answered.
- **AP-5** (6 Nov 2026). Until then nothing depends on email: a failed email never stops a company's request, an Accept or a Decline, and a screen says an email was sent only when it really left.

## Legal: open before real candidates

- **R-LEGAL-1** (22 Sep 2026). The owner accepted the risk of running without a lawyer's review for one unpaid pilot only: one partner, one job, US candidates, 60 to 90 days, no charge. The legal drafts stay labelled unreviewed until a lawyer returns them. The risk is raised again before a paid customer, a job or candidate outside the United States, automatic rejection, a second partner or a wider release.
- **R-LEGAL-1 raised again** (5 Nov 2026, **PQ-3**). The plans go past that scope, and the risk has **not** been accepted again. Until the owner accepts it again in writing, dated in this file, or a lawyer has answered: made-up applicants only, and no real company on a plan. Nothing in the code enforces this. Since 6 Nov 2026 anyone with a Google or Microsoft account can ask for access, so it rests on whoever presses Accept.
- **Gates 4.13 and 5.8** (21 Sep 2026). The owner's dated sign-off that real candidate data may start, and later the one for a public launch, have not been given. They are recorded in this file when they are. What must be proven first: [20-real-data-readiness-plan.md](readiness/20-real-data-readiness-plan.md), section B.
- **F13** (14 Sep 2026); gate 1.7. No lawyer is engaged. An open legal question does not block building; it blocks live use of the feature it is about. The questions, none answered: [counsel-register.md](legal-drafts/counsel-register.md).
- (15 Oct 2026; **PQ-16**, 5 Nov 2026.) No real candidates in New York City, Illinois, California or Colorado until a lawyer has answered, and a remote job counts as everywhere. Nothing in the code refuses such a job; it rests on whoever presses Accept.
- **J6** (18 Sep 2026). No automatic rejection: only a person declines, and the candidate is told only after that decision is recorded.
- **J8** (18 Sep 2026); gates 4.5 and 5.7. The retention periods are proposals waiting for a lawyer, and nothing is deleted automatically until they are decided: [data-retention-matrix.md](legal-drafts/data-retention-matrix.md), [10-proposed-retention-schedule.md](legal-drafts/10-proposed-retention-schedule.md).
- **M1** (21 Sep 2026); **L-11 A** (16 Oct 2026). A privacy request is answered within 45 calendar days, provisional until a lawyer confirms it, and the platform admin handles it. Steps: [privacy-requests.md](runbooks/privacy-requests.md).
- **PQ-15** (5 Nov 2026). A deletion needs a recorded lawyer's approval, and there is no lawyer, so a real deletion request cannot be finished today: the code refuses every deletion without that record.
- **AQ-1** (6 Nov 2026). What we keep about a declined company request, and for how long, is not decided. Until it is, everything stays and nothing deletes it; a person who asks goes to the owner the same day.
- (30 Sep 2026.) A candidate's status link has no expiry date; one waits on the retention decision.
- **PQ-14** (5 Nov 2026). Testers need terms. None are signed, and Accept asks for none. A short draft, reviewed by nobody: [12-free-plan-terms.md](legal-drafts/12-free-plan-terms.md).
- **PQ-1** (5 Nov 2026; owner, then lawyer). Keep taking applications past a plan's limit, or stop? Today they are taken, with no cap.
- **PQ-2** (lawyer). May we collect an application that our software will hide from the employer, and is hiding by a plan limit a decision made by software?
- **PQ-4** (owner and lawyer). Approve the wording a locked applicant reads.
- **PQ-6** (lawyer). If a locked applicant asks why, may we say only "the employer did not review your application", without naming the plan?
- **PQ-11** (owner). Should a Free job close by itself 30 days after going live? Not built.
- **PQ-13** (lawyer). Who holds locked records, for how long, and can the employer reach them for a legal need without paying? Today: the same retention as everyone, nothing deleted.
- **PQ-17** (owner). Turn on an invisible bot check on the apply form before testers? Not built (**L-14**, not now, 15 Oct 2026): the form has a hidden trap field and rate limits.
- Not listed: PQ-9, PQ-10 and PQ-12 were about recruiter requests, the automatic interview link and the "still reviewing" note, which the product no longer has. PQ-5, PQ-7 and PQ-8 are under "Check with the owner".

## Put off, and open to asking again

- **D-02** (14 Oct 2026). No adding or importing people who did not apply.
- **L-03** (15 Oct 2026). Members see every job of their company; limiting a member to their own jobs is for later.
- **L-13 B** (16 Oct 2026). No equal-opportunity questions until a lawyer has answered and there are enough applicants to study.
- **L-15 B** (16 Oct 2026). No "house voice" note for the job writer.
- **L-16** (15 Oct 2026). No second sign-in step of our own for companies: they rely on Google's or Microsoft's own two-step sign-in.
- **Migration 0040** (15 Oct 2026). A session left open in another company can still switch back to a company the person was signed out of, while they are still a member.
- (September 2026.) Not built, by decision: payments, job-board API connections, sourcing, background checks, interview recording, a second jurisdiction.

## Check with the owner

Decisions that may no longer hold, or that the owner never confirmed.

- **PQ-7** (5 Nov 2026). "A locked applicant gets no AI" (PL-5) was the team's choice. The owner was told; no written yes is on record.
- **PQ-8** (5 Nov 2026). The owner's request said the first 3 candidates in one place and the first 5 in another. Free shows 5; it is one number to change.
- **PL-7, PQ-5** (5 Nov 2026). A locked applicant is promised a real answer by email "at the latest 30 days" after applying, or when the job closes. The team chose the timing and the owner never answered. Check that the simple product still sends it: the wording a locked applicant reads promises it.
- **PL-1, PL-12** (5 Nov 2026). Pro and Ultra were priced with the platform's staff posting each job on the job boards, and every plan with a number of recruiter requests a month. The product no longer has either. Do $49, $149 and $399 still stand?
- **Q9 A** (7 Oct 2026). "The pay range is always shown on the job ad." PRODUCT.md keeps pay in every posting and a pay check where a state asks for one; it does not say whether "always" still holds.
- **F11, I8 against L-16.** In September 2026 the owner asked for a second factor for company administrators before a general release; in October it was put off. Which holds now that anyone can ask for access?
- **F7, I9** (14 and 15 Sep 2026). A separate staging copy beside production, never holding real candidate data. Whether a staging copy is still used is not on record here; [staging-environment-variables.md](runbooks/staging-environment-variables.md) and [17-staging-handoff.md](spec/17-staging-handoff.md) are kept only because the app names them.
- **F6** (14 Sep 2026). Candidate email goes out from a subdomain of the platform company's own domain, under the hiring company's name. The new name and domain the owner is choosing may replace it.
- (5 Nov 2026, left open by the build.) One job draft at a time per session is not enforced: a stuck page or a script can still spend a company's whole AI credit on repeated drafts.
