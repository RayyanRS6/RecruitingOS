# 14. Candidate links: the trust boundary for privacy requests and withdrawals

Status: implemented and tested locally on 21 September 2026 (founder instruction, item 3). Not legal advice.

## What a candidate link is

Every application gets its own status link, `/c/status/<token>`. The token is 24 random bytes (192 bits) from the
operating system's random source, encoded base64url, and stored on the application row. It is not a signed token: the
server holds the only copy and looks it up by equality, so there is nothing to forge and no signing key to leak. A token
names exactly one application (one candidate, one role, one company). Screening and scheduling links work the same way
with their own tokens.

The link stays valid while the application exists and the candidate's record has not been anonymized. Once a deletion
request has been fulfilled by anonymization the link is dead: the page answers "This link is no longer active" (HTTP
410) for reading and for every write, and nothing is recorded or sent. There is no separate calendar expiry; the
founder can add one later without changing the trust model.

## What the candidate can do with it, and what the server decides

| The form sends | The server derives from the token | Ignored if sent |
|---|---|---|
| `kind` (exactly access, correct, delete, human_review; any other kind is refused) and `details` (the candidate's words) | company, candidate, application, requester email, channel `status_page`, verification `verified_by_link`, deadline | `companyId`, `candidateId`, `applicationId`, `requesterEmail`, `status`, anything else |
| `confirm=yes` for a withdrawal | everything; a repeat changes nothing | everything else |
| `pref` for text messages (opting out always; opting in only while texting is on, decision M2) | everything; a repeat changes nothing | everything else |

A request with an unknown token is a 404 and writes nothing. A request for a token that belongs to another company is
impossible to express: the company is never an input.

## The platform-role write

The `data_requests` table is out of the tenant role's reach (migration 0009), so the candidate handler opens a platform
transaction for the write. Inside that transaction the code does exactly this and nothing else:

1. inserts one `data_requests` row for the token's application (or, for an identical open request from the same
   application within 24 hours, answers that row again and records `data_request.replayed`);
2. writes the `data_request.created` audit record and the `candidate.data_request` event (kind and reference only);
3. for `human_review`, opens a recruiter escalation with a generic sentence; the candidate's words stay on the request in the ITS console and never reach the customer;
4. sends the acknowledgment email to the candidate through the normal outbound path.

There is no general-purpose endpoint that writes with the platform role. The only unauthenticated writers are the
candidate handlers, each bound to one token. Administrators create requests received by email through
`/api/v1/admin/data-requests`, which needs an administrator session with a second factor and records the channel as
`admin` and the verification as `pending`.

## Rate limits and abuse

The privacy form is limited per link token and per address (`docs/readiness/15-rate-limiting-provider.md`); a trip is
recorded as a security event. Replays within a day are idempotent (including requests already waiting on counsel), a
per-application lock makes two clicks in flight one request, and a replay sends no second acknowledgment. Withdrawals
and text-message choices are idempotent too. Administrators recording an email request cannot attach a candidate or
application from another company.

## Tokens never reach logs or analytics

- The request logger and the error handler pass every line through the redaction filter, which removes the token from
  `/c/status/<token>`, `/c/screen/<token>` and `/c/schedule/<token>` paths and the value of any `token=`, `email=` or
  `phone=` query string.
- Analytics receive only the allow-listed funnel events with keyed hashes of identifiers; candidate pages load no
  analytics script at all (founder decision, correction 14).
- Event and audit payloads carry request ids and kinds, never the token.

Tests: `apps/api/src/privacy-requests.test.ts` ("the status link is the whole trust boundary…") and
`packages/core/src/secrets.test.ts` for the redaction patterns.
