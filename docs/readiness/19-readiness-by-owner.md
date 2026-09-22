# 19. The 56 readiness gates as a simple checklist, by who does them

Written 21 September 2026. The full meaning, evidence and status of every gate is in `docs/readiness/16`; the numbers
match. A gate appears under each person who has a part in it, so nine gates appear twice (2.4, 3.7, 3.16, 4.1, 4.13,
5.2, 5.4, 5.7, 5.8); nothing is ticked; nothing is approved.

## Nadine and Paul

Before any account:

- [ ] 1.1 Governing account rule written down (you and Paul)
- [ ] 1.2 Microsoft 365 confirmed, second factors on (Paul, you)
- [ ] 1.3 GoDaddy secured; DNS zone copy saved (Paul, you)
- [ ] 1.4 First administrator chosen (you)
- [ ] 1.5 Queue mailbox chosen (you)
- [x] 1.6 Rate-limit counter chosen: Upstash, US region (22 Sep)
- [ ] 1.7 Counsel engaged (you)
- [ ] 1.8 Privacy-request handler named (you)
- [x] 1.9 Twilio later, Trigger.dev later, worker host Railway (22 Sep)
- [x] 1.10 1Password Business exists (founder confirmed 22 Sep 2026: Nadine and Paul owners, MFA on, five vaults)

Creating staging:

- [ ] 2.0 ITS mailboxes exist (Paul)
- [ ] 2.1 Accounts created under the rule (you and Paul)
- [ ] 2.2 Sign-in registrations with Microsoft and Google (Paul, you)
- [ ] 2.4 Automatic checks switched on in the repository (Paul; Claude assists)
- [ ] 2.5 DNS records reviewed by you and applied by Paul; DMARC tightened two weeks later (Paul)
- [ ] 2.6 Staging switched on: settings entered, worker running (Paul; Claude beside him)
- [ ] 2.7 Vendor terms accepted knowingly, versions noted (you or Paul)
- [ ] 2.8 "Secrets entered directly" note signed in the vault (you and Paul)
- [ ] 2.9 Test identities created: a Google test customer, a Google test interviewer with a calendar, a Microsoft staff test account, a test mailbox (Paul, you)

Before a design partner:

- [ ] 3.2 First administrator signs in; Paul removes the starter setting; the second administrator granted (Claude checks)
- [ ] 3.7 You switch staging to "enforce" after the review period (Claude reviews the reports first)
- [ ] 3.8 You approve point-in-time recovery; you or Paul run one restore (Claude checks)
- [ ] 3.9 Incident tabletop, you and Paul (Claude joins)
- [ ] 3.10 You name the screen-reader tester (Claude fixes what they find)
- [ ] 3.11 Business calendar published (you or Paul)
- [ ] 3.16 Outcome sentence confirmed on the laptop version (you; Claude re-checks on staging)

Before real candidate data:

- [ ] 4.7 Two test privacy requests handled end to end (the handler from 1.8)
- [ ] 4.9 Texting confirmed off in staging (Paul)
- [ ] 4.10 Credential rotation drill (you or Paul; Claude checks)
- [ ] 4.13 Your sign-off that condition E is met, adopting or striking the three team proposals (you; `docs/spec/00` section O)

Before public launch:

- [ ] 5.1 You switch production to "enforce" after two enforced weeks on staging (Claude checks)
- [ ] 5.4 Texting on: your decision, once counsel, the carriers and a partner allow it
- [ ] 5.5 Microsoft Calendar: your decision, when a partner requires it
- [ ] 5.6 Job runner migration: your decision, when the team proposes it
- [ ] 5.8 Your sign-off for public launch (`docs/spec/00` section O)

## Counsel (engaged at 1.7; every answer recorded in `docs/spec/11`)

- [ ] 4.1 Pilot agreement approved (item 14); then signed by each partner
- [ ] 4.2 Privacy notice and AI-use disclosure approved (items 1, 5, 16); you adopt the text
- [ ] 4.3 Screening, human decisions, eligibility, the "talk to a person" alternative, recruiter access, audit keeping, accessibility statement, outcome sentence (items 2, 3, 4, 7, 8, 12, 13, 17, 18), a team request beyond the register
- [ ] 4.4 Privacy-request deadline, extension and runbook (items 6, 9)
- [ ] 4.5 Retention periods (item 9)
- [ ] 4.6 Subprocessor list and the vendors' data-processing terms (item 19)
- [ ] 5.2 Penetration-test engagement letter reviewed; whether the tester is a subprocessor
- [ ] 5.3 Customer terms (item 15, not drafted), pricing and billing
- [ ] 5.4 Text-message consent and messaging wording (items 5, 10) before texting is ever turned on
- [ ] 5.7 The notice re-checked once automated deletion exists (items 9, 16)

## Claude, after the accounts exist

- [ ] 2.4 and 2.6 Sit with Paul for the automatic checks and the staging settings
- [ ] 3.1 Run every line of the staging checklist (`docs/readiness/03`) and sign the areas
- [ ] 3.3 Database accounts and customer isolation on the real database (Paul applies the setup scripts; Claude checks)
- [ ] 3.4 Secret store and deletion drill (Paul holds the test interviewer's Google account)
- [ ] 3.5 Email sending, email-in, bounces, complaints (Paul for the records and the Postmark dashboard)
- [ ] 3.6 Rate-limit counter connected (Paul enters the secret); subprocessor list updated
- [ ] 3.7 Two weeks of journeys in "report only"; every report reviewed; two more weeks enforced
- [ ] 3.12 Google's two reviews prepared (structured data validated); submitted at 4.11 once production exists
- [ ] 3.13 AI evaluation suites on the real model (Paul runs them with the key; Claude reads the report)
- [ ] 3.14 Error reporting and analytics scrubbed (Paul files the dashboard screenshots)
- [ ] 3.15 Worker and timers on the host from 1.9 (Paul starts it; Claude checks)
- [ ] 3.16 Outcome sentence re-checked on staging; an administrator correction recorded
- [ ] 4.11 Google's reviews submitted once production exists, and completed (or your written exception)
- [ ] 4.12 Production switched on and re-checked (Paul: settings, database setup, recovery option, worker, redirect addresses, administrator bootstrap; Claude checks)
- [ ] 5.7 Automated deletion built and tested once the retention periods exist

## Independent security review

- [ ] 5.2 Penetration test on a staging copy with made-up data only: you choose and pay the tester, counsel reviews the letter, the team fixes the findings; you decide whether it happens before the first partner's real data or before public launch

## Design-partner pilot

- [ ] Stage 3 rule: a partner is invited to staging only after signing the pilot agreement, and works with made-up candidates until 4.13 is signed
- [ ] 4.1 Each partner signs the counsel-approved pilot agreement (a copy per partner in the contracts folder)
- [ ] 4.8 Each partner acknowledges the recruiter-access summary (an exhibit of 4.1); a dated line in `docs/readiness/12`
- [ ] 4.13 The first partner starts with real candidate data only after your sign-off
- [ ] 5.8 Beyond the design partners only after your public-launch sign-off

Count: 56 gates (1.1 to 1.10, 2.0 to 2.9 without a 2.3, 3.1 to 3.16, 4.1 to 4.13, 5.1 to 5.8); every one appears above
at least once, checked by a script against `docs/readiness/16`.
