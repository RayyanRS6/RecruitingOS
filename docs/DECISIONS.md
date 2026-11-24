# Decisions still in force

The decisions and open items that hold around the product in [PRODUCT.md](PRODUCT.md): one line each, with its date and the id it had in the register it came from. "The owner" is the person who owns the product, and "the platform administrator" is the staff side. The registers themselves are in git history, at commit `199c94f` and before. New decisions and the owner's sign-offs are added here, dated.

## The product

- (17 and 18 Nov 2026, owner.) One simple flow, as [PRODUCT.md](PRODUCT.md) describes it: "keep only the features and settings that are actually required". By the owner's own decision the product has no recruiter side and no booking of in-person interviews, calendars or offers. Nothing that was cut for this comes back without the owner's decision.

## Sign-in

- **Q2** (7 Oct 2026). Google or Microsoft only: no email-code sign-in, and no passwords of our own (**F11**, 14 Sep 2026). The email sign-in link is a development aid, off by default on a hosted deployment and refused on production.
- **MS-1** (10 Nov 2026). Microsoft sign-in takes work accounts from any company: one app registration that allows all tenants, and the Tenant URL `https://login.microsoftonline.com/organizations` in Supabase. Microsoft's own page refuses a personal account (outlook.com, hotmail.com), by design; those people use Continue with Google.
- **MS-2** (10 Nov 2026). Three protections keep a stranger out of someone else's account, together: the `xms_edov` claim on the ID token (Supabase marks an address with a false value as unverified, so it is never linked to an existing account by email); **Confirm email** on, with "Allow users without an email" off; and the app refusing an unverified address (`email_unverified`).
- **MS-3** (10 Nov 2026). The Graph setting `removeUnverifiedEmailClaim` is not set. It is the fallback only if `xms_edov` cannot be used.
- **MS-4** (10 Nov 2026). No tenant check for staff sign-ins: platform staff are known by their email domain. Requiring the platform's own tenant is optional hardening for later.
- (6 Nov 2026, review.) Whether Supabase's **Confirm email** and **Secure email change** are on is read by a person at release ([production-setup.md](runbooks/production-setup.md), "Supabase project"): the app takes the address on a sign-in as proved, and nothing in the code can read that setting.
- **L-17 A** (16 Oct 2026). A person opens one company of their own, and a request counts as one. A second company only through the platform administrator.
- **AP-2** (6 Nov 2026). A company that is waiting or declined gets nothing: no company route answers, no AI runs, no money is spent and nothing of theirs is public.
- **AP-4, AP-9** (6 Nov 2026). Decline is not final: no reason is typed, the person cannot send a second request, and accepting later is the undo. Take away access ends every membership and session of a company, and Accept brings everyone back on the same plan.

## Staff second factor

- **F11, I8** (14 and 15 Sep 2026; kept 10 Nov 2026). Platform staff sign in with Microsoft and a second factor, a code from an authenticator app, on every sign-in. A staff session without it is refused, and staff sessions last eight hours.
- (22 Sep 2026.) Enrolment happens on the first sign-in, with a backup authenticator offered and five attempts at a code. Recovery is the backup authenticator, or a reset the owner runs in the sign-in service, because it issues no recovery codes. Steps: [staff-second-factor.md](runbooks/staff-second-factor.md).
- **N2** (21 Sep 2026). Administrator rights come from a ledger, never from a list of addresses in a setting. The first administrator comes from a one-time starter setting that works only while no administrator exists; nobody grants themselves, and the last administrator is protected. Steps: [production-setup.md](runbooks/production-setup.md), "First administrator".

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
- **PL-5.** A locked applicant gets no AI: no resume reading, no AI interview, no AI call on the company's credit. The file is still scanned.
- **PL-6.** A locked applicant never reads a word about a plan or money, and never a promise that is false for them. Their wording is DRAFT WORDING PENDING COUNSEL and keeps every word (`packages/core/src/candidate-lock.ts`).
- **PL-7** (the team's timing; the owner never answered). A locked applicant is told by email when their job closes, or at the latest 30 days after they applied. The worker checks every day.
- **PL-8.** A change of plan opens people oldest first on each job, up to the new limit, each with one event and one audit line.
- **PL-9, PL-13.** The server is the wall: a locked application answers 402 `candidate_locked` before any handler, and lists and counts leave locked people out in the query. On screen a locked person is one card ("Locked", when they applied, "Upgrade to view more candidates."), never a name, initials, a score, a stage or a source.
- **PL-10.** The AI credit is the one meter. Every model call takes a hold first and is refused when it would pass the limit. Free's credit never starts again, and a move down to Free gives no second $10. A candidate is never stuck, cut off or told. The company's owner gets one notice at 80% and one when it is used up, and reads the credit as words or a percentage, never dollars; the platform administrator sees dollars.
- **PL-11.** No payment system. Upgrade sends a request to the platform administrator, who changes the plan: "No card is charged", and nothing changes until then. The button's words are the server's: "Upgrade", or "Talk to ITS" on the top plan, and no button for someone who may not ask.

## AI models

- (13 Oct 2026, owner.) Only Claude Haiku 5.5, for every task, and Claude Sonnet 5.5, only for writing the whole job (`intake.compile`). Never any other model. Moving another task to Sonnet 5.5 needs evidence and a plain explanation first. The allow-list is in `packages/ai/src/routing.ts`: it is checked at start-up, and a call to any other model is refused.
- **P1** (14 Sep 2026). The stand-in AI is for development and tests only; a hosted deployment refuses to start on it.

## Fairness

- (13 Oct 2026; the owner: "the CV screening should be fair".) Each resume and each AI interview is read three times and the middle answer is kept; both scoring readings run at high effort; each finding has one written definition; the candidate is never named in a reading.
- **D-04 C** (14 Oct 2026). The scoring readings never see the name, email, phone, street address, zip code or web links, nor earlier applications and how they ended. The team still sees everything.
- (15 Oct 2026.) A licence, certificate, permit or registration must-have is "not met" only when the candidate's own words say plainly they do not hold it. Lapsed, expired, pending or unclear is not known, never "not met". Code enforces it after the model answers.
- **AI-24** (13 Oct 2026). A "Run fairness tests" button in GitHub Actions runs the fairness checks on the real models: the resume checks, the AI interview with its scorecard, or the job builder. Results stay in GitHub, not in the repository. Steps: [fairness-tests.md](runbooks/fairness-tests.md).
- (19 Nov 2026.) The button was run on the prompts as they are now: the resume reading (`resume.extract` version 3, `triage.assess` 8) passed every check; the AI interview's chat and scorecard (`screen.turn` 9, `screen.assess` 11) passed every group but one conversation in each of two runs, each time on how the check itself was set up; the job builder (`intake.turn` 7, `intake.compile` 8) refused every unlawful wish and wrote every job to the standard, and showed that the model writes the kind of job and the pay basis in plain words, which blocked the builder until code read them. `intake.turn` is version 8 since: run again that evening from the branch that carried it, the job builder passed every case and the AI interview every group. The two posts (`job.posts` 1) have no suite: they were read on the live site.
- **Open** (19 Nov 2026). The scoring prompts spell "résumé", and the models repeat it. Code corrects it where an assistant writes to a person (the AI interview, the job builder); a summary a model writes for the team can still carry it. Rewording those prompts changes their versions and needs the button run again.
- **LT-31** (17 Nov 2026). The fairness check on a job's wording refuses a ban on a criminal record and a question about one. A background check after an offer is never refused, and "Must pass a background check" is neither refused nor flagged until a lawyer answers.
- (15 Oct 2026.) A company's question about a protected characteristic is refused before it is saved.

## Applying and jobs

- **Q14 A** (7 Oct 2026). Every applicant reads the same receipt, a repeat included, and the status page opens only from the emailed link, so the form never tells anyone whether an address applied before.
- **Q12 B** (7 Oct 2026). A closing date stops new applications at the end of that day. Nobody is rejected by it, and closing the job stays a person's decision.
- (19 Nov 2026, the team.) An AI interview asks the questions of the job as it is when the interview is made, by Shortlist or by a new link, and keeps them to its end. Closing a job closes its AI interview links that are still open. An interview the candidate sent is always scored.
- (25 Nov 2026, the team; the owner approved the round.) In the job builder the assistant never asks for the same thing twice, but the page never says "still needed" without a card to answer: the server's own card for an essential that is still missing comes back on every turn, and so does the pay card while pay is stated and no person has confirmed it. A pay card sent as it was drawn confirms the pay it shows. The work arrangement is read from words ("on site", "work from home"), the assistant's and the owner's, and is still taken only when the owner typed it. Pay typed as a range that says its thousand once ("45-55k") counts as typed.
- (25 Nov 2026, the team.) The three lines under every candidate email (the AI disclosure, how to reach a person, the signature) and the line about a person on the AI interview's first page are the code's own words, the same for every job. A job record's copies of them, which a model wrote with the job, are never shown to a candidate; the record is rewritten with the code's words on every save.
- (25 Nov 2026, the team.) The AI interview asks about a must-have that names a licence, certificate, permit or registration once, as yes or no ("... Do you have it?"), and takes the answer: never "something similar". It does not ask again about a must-have the stored reading found not met on the candidate's own "No" to a yes-or-no question of the form. **Open:** nothing in a job's record ties a form question to a must-have, so any other must-have the form asked about can still be asked again; an interview answered before this change shows the new wording of the licence question beside the old answer; and the scorecard mostly reads a bare "No" about a licence as not known, not as not met (no number moves).
- (25 Nov 2026, the team; found by the button on the real model.) The answer on record for an AI interview question is every reply the candidate gave to it, as they sent them, with protected information taken out by code. The words of the model's own record of an answer are never used: the real model has joined two replies its own way, and has kept only the latest of two.
- (25 Nov 2026, the team.) A question added or reworded in the job editor gets its kind from its words: a yes-or-no question offers Yes and No and takes "No" as its answer. A must-have whose words changed loses the reason written for the old words, and a skill whose name or meaning changed loses what was said to show it.
- (25 Nov 2026, the team.) A closed job's page stays up: it says the position is closed, takes no applications, and its JobPosting data ends on the closing day. The preview and the Share tab say so, never that the page is no longer public.

## The look

- (24 Nov 2026, owner.) "The job page does not match the UI of my app. Apply now button is very worse"; "fix inconsistent UI"; "do not completely transform my website", "keep my current app's theme"; changes to hierarchy, components and smoothness are allowed. The owner likes narrow bold headlines (Klarna Title, Helvetica Now Display Condensed) and the look of coss.com/ui, klarna.com and ugly.cash.
- (24 Nov 2026, the team.) Apply now is the application's own plum pill, the words then an arrow in a light circle; the pale pill with a sliding fill is gone. The job page's text sits in a card like the application's, and the company is named in plain semibold words beside its logo.
- (24 Nov 2026, owner.) "Use the fonts I mentioned" (Klarna Title, Helvetica Now Display Condensed Bold) and "I want UI like this" (klarna.com, ugly.cash), keeping the app's theme and plum colours. Neither font can be used as asked: Helvetica Now is sold by Monotype and needs a web licence, and Klarna Title is not offered for licence; taking the files from those sites would be using them unlicensed. **Open:** if the owner buys Helvetica Now Display Condensed Bold, it replaces the display face in one change (`fonts.ts`, the two `--font-display` lines).
- (24 Nov 2026, the team.) The display face is Instrument Sans (SIL OFL), one variable file with a width axis; big headings and figures are set at 75% width and weight 700, a step larger than before. Of the open faces compared side by side with the owner's two references (Mona Sans, Archivo, Bricolage Grotesque, Instrument Sans) it is the nearest: the same two-storey a and one-storey g. Small headings keep the normal width. Body text stays IBM Plex Sans.
- (24 Nov 2026, owner; this replaces "never `appearance: none`" of 15 Oct.) "Dropdowns are not like the theme ... the arrow down is touching the right side." A dropdown stays the browser's own `<select>`; the kit draws its arrow with room on the right and, where the browser allows and there is a mouse, its open list. No scripted dropdown.
- (24 Nov 2026, owner.) "Buttons like Open Home do not seem like a button": a link that is an action of its own is drawn as a button or a small lavender pill. An update's "Open ..." link is a button in the row.
- (24 Nov 2026, owner.) "Details" inside a card did not read as something to press: every folded part's summary is an outlined pill with a chevron, and a problem's reads "Show details" / "Hide details", its words opening in a soft panel.
- (24 Nov 2026, the team.) Cards have 20px corners (16px before), toward the rounder cards of the owner's references.
- (24 Nov 2026, the team.) A page under another has one quiet back link above its heading ("‹ Jobs"), in no bar of its own. A page title wraps inside its row, so its status and buttons stay on its first line.
- (24 Nov 2026, the team.) System, Health: each problem is a mark, its title, one quiet line (how urgent, when), one sentence, and the rest under "Details"; its buttons sit beside the title.
- (24 Nov 2026, the team.) The libraries the owner named (coss.com/ui, reactbits.dev, obsidianui.dev, libraries.dev) are references for the feel only. None is installed and no code is copied: the kit stays our own (mixed licences, and pages must stay light on old phones). The small mono eyebrows stay, as part of the owner's theme. Candidate pages keep following the device's light or dark setting.

## Hosting and releases

- (9 Oct 2026.) Keep Vercel, Supabase and Railway: "don't change anything" about hosting. Vercel runs the app, the API included; Railway runs the worker; Supabase holds the database, sign-in and files.
- (11 Nov 2026, owner.) No staging walkthrough: a release is tested on the live site with made-up people.
- **Decision 1** (22 and 23 Sep 2026). Background work runs in the product's own engine on the Railway worker. There is no hosted job runner, and moving to one needs its own decision.
- (22 Sep and 16 Oct 2026.) A release to production is a pull request from `main` into the `production` branch, and the full `verify` check is always waited for before a merge.
- (14 Sep 2026.) Migrations are a release step. They never run when a hosted app starts.
- **RR-6** (11 Nov 2026). A release that changes how the worker treats work it already knows stops the old worker before it migrates; work waits in the database, and the new worker runs it. No repair at start-up. The order of a release: [production-setup.md](runbooks/production-setup.md), "Every later release".
- (19 Nov 2026.) The simple product is live. Its release dropped what the builds before it read and wrote, so nothing rolls back past it: [production-setup.md](runbooks/production-setup.md), "Rollback".
- (25 Nov 2026, after the AI key was refused on 24 Nov.) When the AI provider refuses our account or does not answer, the job builder tells the owner "The assistant is not available right now. Your words are saved; try again later." and a platform administrator gets one critical alert: at once for a refused account, from the second failure within ten minutes for an outage. It resolves itself when the assistant answers again. What to do: [production-setup.md](runbooks/production-setup.md), "Secrets".
- **RR-19** (11 Nov 2026). `verify` always runs, so a cancelled run fails the check instead of being skipped, which GitHub would count as passed.
- **F1** (14 Sep 2026). No superuser or row-level-security-bypassing database role: a hosted process refuses to start on one. A company's data is reached only through the signed-in person's verified membership.
- **J9** (18 Sep 2026). The app never holds Supabase's service-role key; a policy test guards it.
- **Decision 4** (22 Sep 2026). Request limits are counted in Upstash Redis, United States region, so every server shares one count. How it works: [14-deployment-and-environment.md](14-deployment-and-environment.md), "Rate limits".
- **N6** (21 Sep 2026). The browser-protection policy (CSP) stays in report-only until its reports have been reviewed. **Open:** enforcing was to be earned by two weeks of reviewed reports on a test copy first; with no staging walkthrough, the owner has not said what earns it on production. How it works: [14-deployment-and-environment.md](14-deployment-and-environment.md), "The content-security policy".
- **Blocker 8** (22 Sep 2026). A candidate's file is checked and scanned for malware before anything reads it, and the production worker refuses to start without a real scanner. Steps: [resume-storage.md](runbooks/resume-storage.md).
- **I1, I16** (15 Sep 2026). No secret value goes in chat or in the repository. Secrets live only in the providers' own stores and the owner's password vault, and the owner enters them.
- **RR-20, RR-25** (11 Nov 2026). The repository is public. No real person's full name stands beside a company address anywhere in it; `tests/policy/public-repo.test.ts` guards the tree.

## Email

- **A12** (14 Sep 2026). Candidate email is sent from the product's own sending domain through Postmark, not from a customer's mailbox. A reply goes to the company's own contact address ([PRODUCT.md](PRODUCT.md), D15).
- **Open** (4 Nov 2026). Email was not live on production: Postmark's account approval was pending and the sending domain was not verified. It waits for the product's new name and its domain, which the owner is choosing.
- (5 Nov 2026; **PQ-18**, not answered by the owner.) Email must be live before any real candidate applies: "we received your application" and the status link both depend on it.
- **AP-5** (6 Nov 2026). Until then nothing depends on email: a failed email never stops a company's request, an Accept or a Decline, and a screen says an email was sent only when it really left.

## Legal: open before real candidates

- **R-LEGAL-1** (22 Sep 2026). The owner accepted the risk of running without a lawyer's review for one unpaid pilot only: one partner, one job, US candidates, 60 to 90 days, no charge. The legal drafts stay labelled unreviewed until a lawyer returns them. The risk is raised again before a paid customer, a job or candidate outside the United States, automatic rejection, a second partner or a wider release.
- **R-LEGAL-1 raised again** (5 Nov 2026, **PQ-3**). The plans go past that scope, and the risk has **not** been accepted again. Until the owner accepts it again in writing, dated in this file, or a lawyer has answered: made-up applicants only, and no real company on a plan. Nothing in the code enforces this. Anyone with a Google or Microsoft account can ask for access, so it rests on whoever presses Accept.
- **Gates 4.13 and 5.8** (21 Sep 2026). The owner's dated sign-off that real candidate data may start, and later the one for a public launch, have not been given. They are recorded in this file when they are. Before the first: database backups with point-in-time recovery and one restore drill; a signed pilot agreement and the vendors' data-processing terms; a named person who leads an incident; a security review by someone outside the team, or the owner's dated deferral of it; email live; and the uptime monitor proven once ([production-setup.md](runbooks/production-setup.md), "Uptime monitor").
- **F13** (14 Sep 2026); gate 1.7. No lawyer is engaged. An open legal question does not block building; it blocks live use of the feature it is about. The questions, none answered: [counsel-register.md](legal-drafts/counsel-register.md). The legal drafts were written before the simple product: what they say that is no longer true has to be corrected before a lawyer reads them.
- (15 Oct 2026; **PQ-16**, 5 Nov 2026.) No real candidates in New York City, Illinois, California or Colorado until a lawyer has answered, and a remote job counts as everywhere. Nothing in the code refuses such a job; it rests on whoever presses Accept.
- **J6** (18 Sep 2026). No automatic rejection: only a person declines, and the candidate is told only when a person presses "Email the decision".
- **J8** (18 Sep 2026); gates 4.5 and 5.7. The retention periods are proposals waiting for a lawyer, and nothing is deleted automatically until they are decided: [data-retention-matrix.md](legal-drafts/data-retention-matrix.md), [10-proposed-retention-schedule.md](legal-drafts/10-proposed-retention-schedule.md).
- **M1** (21 Sep 2026); **L-11 A** (16 Oct 2026). A privacy request is answered within 45 calendar days, provisional until a lawyer confirms it, and the platform administrator handles it. Steps: [privacy-requests.md](runbooks/privacy-requests.md).
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

## Put off, and open to asking again

- **D-02** (14 Oct 2026). No adding or importing people who did not apply.
- **L-03** (15 Oct 2026). Members see every job of their company; limiting a member to their own jobs is for later.
- **L-13 B** (16 Oct 2026). No equal-opportunity questions until a lawyer has answered and there are enough applicants to study.
- **L-15 B** (16 Oct 2026). No "house voice" note for the job writer.
- **L-16** (15 Oct 2026). No second sign-in step of our own for companies: they rely on Google's or Microsoft's own two-step sign-in.
- (15 Oct 2026.) A session left open in another company can still switch back to a company the person was signed out of, while they are still a member.
- (September 2026.) Not built, by decision: payments, job-board API connections, sourcing, background checks, interview recording, a second jurisdiction.

## Check with the owner

Decisions that may no longer hold, or that the owner never confirmed.

- **PQ-7** (5 Nov 2026). "A locked applicant gets no AI" (PL-5) was the team's choice. The owner was told; no written yes is on record.
- **PQ-8** (5 Nov 2026). The owner's request said the first 3 candidates in one place and the first 5 in another. Free shows 5; it is one number to change.
- **PL-1, PL-12** (5 Nov 2026). Pro and Ultra were priced when each plan came with work by the platform's own staff, which the product no longer has. Do $49, $149 and $399 still stand?
- **Q9 A** (7 Oct 2026). "The pay range is always shown on the job ad." A job cannot be written without pay, and the legal check asks for the range where a state requires it; whether "always" still holds elsewhere is not on record.
- **F11, I8 against L-16.** In September 2026 the owner asked for a second factor for company administrators before a general release; in October it was put off. Which holds now that anyone can ask for access?
- **F6** (14 Sep 2026). Candidate email goes out from a subdomain of the platform company's own domain, under the hiring company's name. The new name and domain the owner is choosing may replace it.
- (5 Nov 2026, left open by the build.) One job draft at a time per session is not enforced: a stuck page or a script can still spend a company's whole AI credit on repeated drafts.
