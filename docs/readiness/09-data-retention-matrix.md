# Data-retention matrix (proposed; counsel decision pending)

Status: **Blocked (counsel)**. These are the proposed conservative defaults from `docs/spec/05` §6 and register items 6 and 9. No automatic deletion is implemented or will be enabled until counsel approves this matrix; anonymization runs only per request after a recorded counsel decision (`docs/runbooks/privacy-requests.md`).

| # | Category | Examples | Proposed retention | Proposed action at end | Exceptions and holds |
|---|---|---|---|---|---|
| 1 | Application decision records | stage history, eligibility results, human decisions with reasons | 4 years from the decision | anonymize identity, keep the record | litigation hold; hired persons become employment records (customer's) |
| 2 | Candidate identity and contact | name, email, phone, location | 4 years after last activity, or on request | anonymize | as above |
| 3 | Resumes and extracted text | file, text, extraction facts | 4 years after last activity, or on request | delete file and text | litigation hold |
| 4 | Screening transcripts and answers | text conversation, structured answers | 4 years, or on request | delete content, keep counts | litigation hold |
| 5 | AI assessments and runs | evidence-bound assessments, `ai_runs` metadata and cost | 4 years (assessments), 2 years (run logs) | assessments anonymized with the candidate; run logs deleted | audit needs |
| 6 | Communications | emails and texts sent and received | 4 years, or on request | body replaced, envelope kept | litigation hold |
| 7 | Interviews and calendar references | times, participants, event ids | 4 years | keep without identity | none |
| 8 | Audit records | who viewed or changed what, secret reads | 7 years | never altered; identity fields point to anonymized records | none |
| 9 | Events (domain log) | every fact the system recorded | 7 years | as audit | none |
| 10 | Privacy-request records | requests, verification, notes, resolution | 7 years | keep | none |
| 11 | Account and team data | users, memberships, sessions, invitations | life of the account plus 2 years; sessions 30 days | delete | none |

Open counsel questions (register `11`): the applicable federal and California periods for applicant records of employers of 10 to 150 people; whether anonymization satisfies a deletion request where a retention duty applies; treatment of hired candidates; litigation-hold procedure; the 45-day response deadline and its extension.
