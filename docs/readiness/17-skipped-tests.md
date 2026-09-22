# 17. The five skipped tests: what they are and why they are skipped

Reviewed on 21 September 2026 (founder instruction, item 9). Command used: `grep -rn "it.skip\|test.skip\|describe.skip\|it.todo" apps packages tests --include=*.ts --include=*.tsx`. Result: exactly five, all in `tests/scenario/lifecycle.test.ts`, lines 459 to 463. No other suite skips or defers a test.

| Test name (as written) | Target release | What it would cover | Why it is skipped | Where the release 1 behaviour is tested instead |
|---|---|---|---|---|
| Step 12b [deferred to release 2, see DEFERRED]: consented recording and a draft scorecard confirmed by the interviewer | Release 2 | Recording an interview with consent, an AI draft scorecard, interviewer confirmation | Founder decision: interview recording stays off in release 1 (stop condition "Activate recording"; `docs/spec/15` step 12b) | Step 12 (interview held, human scorecard) runs in the same file; scorecards in `core.test.ts` |
| Step 13b [deferred to release 2, see DEFERRED]: debrief with disagreements and calibration memory | Release 2 | Structured debrief across interviewers with disagreement handling and calibration memory | Deferred product scope (`docs/spec/15` step 13b); release 1 records decisions without the debrief workflow | Step 13 (decision recorded by a person) runs in the same file |
| Step 14 [deferred to release 2, see DEFERRED]: offer drafted within the ceiling, approved, sent, accepted; counter is human | Release 2 | Automated offer drafting, approval and sending | Stop condition "Build automated offers"; release 1 records outcomes that happened outside the platform instead | `apps/api/src/outcomes.test.ts` (human-recorded hire, decline, withdrawal, role outcomes, admin correction) |
| Step 15 [deferred to release 3, see DEFERRED]: onboarding handoff or HRIS, reminders, 30/60/90 outcomes | Release 3 | Onboarding handoff, HRIS integration, milestone check-ins | Stop condition "Build onboarding"; no onboarding data exists in release 1 by design | Not applicable in release 1; the outcome record deliberately carries no onboarding, payroll or identity field (`outcomes.test.ts`) |
| Step 16 [deferred to release 3, see DEFERRED]: recruiter takeover overlay and handback | Release 3 | An ITS recruiter taking over a customer's workflow in the interface and handing it back | Deferred product scope (`docs/spec/15` step 16); release 1 gives recruiters scoped, time-limited access only | `staff-access.test.ts` (scoped access, expiry, customer-initiated revocation), `queue-preview.test.ts` |

## Confirmation

- Each skipped test maps to a feature the founder deferred in writing (`docs/spec/15-scenario-steps-11-16.md`, section "DEFERRED", and the 21 September stop conditions).
- None hides unfinished release 1 behaviour: the release 1 parts of interviews (steps 11 to 13), decisions, outcomes and recruiter access are covered by active tests named above, and no security, privacy, tenant-isolation, authentication, communication, scheduling, accessibility or audit test is skipped anywhere.
- The five remain `it.skip` rather than deleted so the scenario file keeps the numbering of the founder's sixteen steps and the deferral is visible in every test run ("5 skipped").
