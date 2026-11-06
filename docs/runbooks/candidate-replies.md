# Candidate replies: where they land and who reads them

Every email a candidate receives from the product is sent from the dedicated ITS address with the customer's hiring
team as the display name. What happens when the candidate hits Reply depends on one thing: whether the inbound mail
domain is configured.

## When the inbound domain is configured (production)

`EMAIL_PROVIDER=postmark`, `POSTMARK_INBOUND_SECRET` set, and `EMAIL_INTAKE_DOMAIN` a real domain whose MX record
points at Postmark's inbound server (the same setup the per-role intake addresses use). The product reports this as
"email-in connected" on the Setup page.

- Every candidate email carries a per-application Reply-To address: `reply-<token>@<EMAIL_INTAKE_DOMAIN>`. The token
  is random, lowercase, and belongs to the application only. It is never the candidate's status token, so an address
  seen in a mail header cannot open the status page.
- Postmark posts the reply to `/webhooks/postmark/inbound`, the same webhook the intake addresses use. The reply is
  recorded on the application as an inbound message (the sheet's Messages card shows "They wrote"), the event
  `message.received` is written, and the owner, admins and hiring managers get an update: "<name> wrote back", with a
  link straight to the candidate's sheet.
- A reply whose first line is `HUMAN` (any case) asks for a person. The product does what it does when a candidate
  texts HUMAN during a screening: the screening conversation, if one is open, stops and is marked as waiting for a
  person; a recruiter request is created with the whole context and the usual response time; the team is told; and
  the candidate gets one short email saying a person will follow up, with the response-time sentence computed from the
  ITS business calendar. Nothing else is sent automatically.
- A reply to a token nobody has is recorded on the inbound log as `unmatched` with the reason `unknown reply token`
  and ignored. It never becomes an application and never gets an answer.
- The team answers from the candidate's sheet ("Message <first name>"), which sends under the company's hiring-team
  name with the sender's name in the footer and no AI disclosure line, because a person wrote it. Under the policy
  "Send a message a team member wrote to a candidate" set to approval or to "only a person", an owner or admin reads
  it first (from Today or the sheet); their own messages go at once. Under the default (auto with a notice) a message
  goes out at once and the owners are told afterwards.

## When the application is locked (the plans of 5 November 2026)

While an application is past its plan's candidates per job, nobody on the team may read this person, so a reply never reaches them. It is recorded on the application's thread and `message.received` is written, with no notice to the team. Any reply opens one `candidate_issue` request at a time in the ITS queue, with its usual response time, its question naming the role and saying the hiring team cannot read this application, and their words left on the thread. HUMAN works the same way, with the one short email saying a person will follow up. A reply about future roles ("no thanks") is honoured with no request. The team's list shows only "An ITS recruiter is helping a candidate you cannot see yet.", with no name and no answer.

The recruiter accepts it, reads it under a grant naming exactly that application, and sees "Locked for the company. Do not name them in your reply." They answer the candidate from that application, and nothing about the person goes to the company: `docs/runbooks/privacy-requests.md`, "What ITS may say". A message from there goes straight away whatever the company's approval rule says, because nobody at the company may read it, with a line in the audit trail. Notes from a call go on the candidate's Notes tab as the recruiter's own. Nothing is scored, and no AI interview or interview can start, until an upgrade opens them. An accommodation request is answered the same way, and is never limited. Once a change of plan opens them, replies go to the team again.

A text works the same way once texting is on: with no chat open, anything a locked person texts, HUMAN included, stays on their thread and opens one request, at the company of the locked application, and the team hears nothing.

Without the inbound domain these replies land in the mailbox like any other, and the product cannot tell the person reading it. **Console, Customers** shows how many a company has locked: if it has any, find out whether this person is one of them before writing anything to the team, and if they are, answer them and tell the team nothing.

## When the inbound domain is not configured (development, staging without the DNS record)

Reply-To stays `EMAIL_REPLY_TO` (by default the ITS queue mailbox, `ITS_QUEUE_EMAIL`). Replies land in that mailbox
and a person reads it: the recruiter on duty checks it during business hours, records anything the customer needs to
know on the candidate's sheet by writing to the candidate or by opening a recruiter request, and forwards nothing
automatically. The product cannot see these replies, so the Messages card shows only what the product sent.

## Checks

- Setup page: the email-in row says "Forward application emails to each role's intake address" when the domain is
  live; "The inbound mail domain is not configured yet" otherwise.
- `GET /api/v1/applications/:id` (the sheet): the `communications` list shows inbound rows with `channel: email`
  once replies arrive.
- Postmark activity: inbound messages to `reply-...@` addresses should show a 200 from the webhook; a 202 means the
  reply was received but could not be recorded and is kept on the inbound log with its error for a person to look at.
