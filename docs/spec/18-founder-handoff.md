# 18. Founder handoff: what Nadine and Paul do next

Written 21 September 2026 by the production team. Release 1 scope is frozen as of this date (`docs/spec/00` section P).
Nothing here is legal advice; nothing here is approved. Every pointer below leads to the full detail.

## A. Decisions only Nadine can make (no account needed)

Record each in `docs/spec/00` section M, one line, dated.

| # | Decision | Where the options are |
|---|---|---|
| 1 | Confirm the governing-account rule and the mailbox owners | `docs/spec/12`; gate 1.1 in `docs/readiness/16` |
| 2 | Which staff address becomes the first platform administrator (you or Paul) | gate 1.4; `docs/readiness/13` |
| 3 | Which shared mailbox is the ITS queue: `recruiting-replies@` or `support@` | gate 1.5 |
| 4 | The shared rate-limit counter ("take the team's recommendation" is a valid answer) | gate 1.6; `docs/readiness/15` |
| 5 | Engage counsel: California employment counsel with hiring-AI experience, and privacy and technology counsel | gate 1.7; `docs/spec/11` |
| 6 | Who handles privacy requests with you (reads `privacy@`) | gate 1.8 |
| 7 | Twilio now (registration only) or later; Trigger.dev now or later; where the worker process runs | gate 1.9; `docs/spec/17` section 9 |
| 8 | Approve the proposed DNS records or send questions back | gate 2.5; `docs/spec/13` appendix B |
| 9 | The outcome sentence on the candidate sheet: confirm or change the wording | gate 3.16 (your part can be done on the laptop version today) |
| 10 | The 45-day privacy-request deadline and its one-time extension: put in front of counsel, then decide | gate 4.4; decision M1 |
| 11 | Approve the paid point-in-time recovery option for the database | gate 3.8 |
| 12 | Who does the screen-reader pass on staging | gate 3.10 |
| 13 | Whether the penetration test happens before the first partner's real data or before public launch | gate 5.2 |
| 14 | The two sign-offs, when their conditions are met: first real candidate data (gate 4.13), public launch (gate 5.8) | `docs/spec/00` section O |
| 15 | Adopt or strike three team proposals: the text-screening row counts as verified with texting off; Google's reviews may still be pending when the first partner starts; real candidate data may run in production with the browser-protection policy in "report only" until gate 5.1 | `docs/spec/00` section O has a row for each |
| 16 | Which of you signs the pilot agreements and reads the counsel-approved exhibits with each partner | gates 4.1 and 4.8 |

## B. Accounts Nadine and Paul create, in order

Every account is owned by an ITS business mailbox with owner, billing contact, recovery contact, region and permissions
written down first (`docs/spec/12`). Names only go in the worksheet (`docs/spec/13`); secret values go in the vault and
the service settings, never in a message.

1. Confirm the Microsoft 365 account for `identifiedtalent.com`, administrators, and second factors (spec 12 §12 steps 1 to 3).
2. Secure GoDaddy: named access, second factor, ITS-controlled recovery; export and save the DNS zone (steps 4, 5).
3. Create the mailboxes: `platform@`, `billing@`, `support@`, `security@`, `dev-alerts@`, `recruiting-replies@`, `privacy@` (step 6).
4. 1Password Business and its vaults (step 7).
5. GitHub organization and private repository (step 8).
6. Supabase staging and production (step 9).
7. Microsoft Entra sign-in registration and the Supabase Microsoft provider (step 9a); the Google sign-in provider follows the Google Cloud project.
8. Vercel, connected to the repository (step 10).
9. Postmark staging and production; then the email DNS records, only after reviewing the existing email DNS (steps 12, 13).
10. Google Cloud project for the calendar connection and the Google sign-in client (step 14).
11. Sentry (step 15), PostHog (step 16), Anthropic with spend limits (step 17).
12. Twilio, registration only, if decision 7 says now (step 18). Trigger.dev, if decision 7 says now (step 11).
13. Create the test identities every staging check needs: a Google test customer, a Google test interviewer with a real calendar, a Microsoft staff test account with a second factor, a test mailbox for candidate email (gate 2.9).
14. Record every non-secret reference (step 20) and hand it over as in section C.

## C. What you may safely return to Claude

Yes, in a message or in `docs/spec/13` appendix D: Supabase project references and URLs; Vercel team and project names
and the production and preview hostnames; Trigger.dev project reference; Postmark server names and the verified sending
and inbound domains; Google Cloud project ids and the OAuth client id; Sentry organization and project slugs; PostHog
project key and host; the GitHub repository URL; screenshots of dashboards with no candidate data; audit record ids.
None of these grants access.

Never: passwords, API keys, tokens, secrets, connection strings, the contents of any settings screen that shows values,
webhook secrets, the session secret, any file named `.env`, and any real candidate's name, email, phone, résumé or
message. If in doubt, describe it instead of pasting it. Claude will never ask for a secret value.

## D. Exact order for staging activation

1. Section A decisions 1 to 8 recorded.
2. Section B accounts 1 to 11 created.
3. Paul enters the staging settings in the Vercel project with the team beside him; a preview address answers; the worker host from decision 7 runs the worker process (gate 2.6).
4. Paul switches on the automatic checks in the repository; first passing run (gate 2.4).
5. Nadine and Paul sign the "secrets entered directly" note in the vault (gate 2.8).
6. First administrator: the person from decision 2 signs in with Microsoft and a second factor; Paul removes the one-time starter setting; the other of you two is granted in the console (gate 3.2).
7. The team runs the staging verification checklist (`docs/readiness/03`) with you watching; every section ticked (gate 3.1 with 3.3 to 3.6, 3.13 to 3.15).
8. Browser-protection policy: two weeks "report only" with the team's journeys, reports reviewed, then you switch staging to "enforce"; two more weeks enforced (gate 3.7).
9. Point-in-time recovery on; one restore drill by you or Paul (gate 3.8).
10. Incident tabletop, you and Paul (gate 3.9).
11. Screen-reader pass by the person you named (gate 3.10); business calendar published (3.11).
12. Google's job-listing review requested (3.12); AI evaluation suites on the real model (3.13).
13. Your confirmation of the outcome sentence on the laptop version, re-checked on staging (3.16).
14. Design partners are invited to staging only after they sign the pilot agreement (gate 4.1), and only with made-up candidates until section E is closed.

## E. Every blocker before the first real candidate

All of stage 3 above, and then:

- Counsel engaged (decision 5) and their written answers recorded in `docs/spec/11` for: the pilot agreement (item 14), the privacy notice and AI-use disclosure (items 1, 5, 16), the privacy-request deadline, extension and runbook (items 6, 9), the retention periods (item 9), the subprocessor list (item 19), and, at the team's request beyond the register, screening and human-decision questions (items 2, 3, 4, 7, 8, 12). Gates 4.1 to 4.6.
- Each design partner has signed the counsel-approved pilot agreement (4.1) and acknowledged the recruiter-access summary (4.8).
- The privacy mailbox is live and the handler from decision 6 has walked two test requests through (4.7).
- Texting confirmed off in staging (4.9).
- Credential rotation drill done by you or Paul (4.10).
- Production switched on with its own settings, database setup, recovery option, worker, sign-in redirect addresses and administrator bootstrap (4.12).
- Google's two reviews submitted once production exists and complete, or your written acceptance to start without them (4.11).
- Counsel's answers on the "talk to a person" alternative, the recruiter-access model and audit record keeping (items 13, 17, 18), inside gate 4.3.
- Your dated sign-off that the register's condition E is met (4.13; `docs/spec/00` section O).

Blocked today by accounts: everything in sections B and D. Blocked today by counsel: every item in the first bullet
of this section, plus texting (5.4), customer terms and pricing (5.3), and automated deletion (5.7).
