# Candidate privacy requests: access, correction, deletion

The admin dashboard's **Privacy requests** records every step. The deadlines and the retention rules wait for a lawyer ([counsel-register.md](../legal-drafts/counsel-register.md), items 6 and 9): until then the deadline below is a cautious default, and nothing is deleted without a recorded lawyer's decision.

## Who

- The platform administrator handles every request, and reads the privacy mailbox (`PRIVACY_EMAIL`). Nobody else reads that mailbox.
- A request that touches employment records, a legal hold, or someone who was hired goes to a lawyer before any deletion.
- A company's team never sees a request's content.

## How a candidate asks

- The form on their status page, which their emailed link opens.
- The public form at `/c/privacy-request`, linked from `/privacy`, for someone without their link: it emails a confirmation link that works once, for 24 hours, and nothing is recorded before they press it.
- An email to the privacy mailbox from the address they applied with. A message to any other mailbox that asks for access or deletion is forwarded there the same business day.

## Steps

1. **Record** a request that came by email: **Privacy requests**, record a request from the privacy mailbox. One made on a form is already there.
2. **Acknowledge** within one business day from the privacy mailbox. If the address does not match an application, ask the person to reply from the address they applied with, or to confirm the job and the rough date. Do not ask for identity documents.
3. **Verify** who is asking, and record how. A request made through the person's own link or the confirmation link is verified already. Nothing can be done on a request before it is verified.
4. **Act**, within 45 days of receipt. The dashboard warns ten days before the deadline and when it has passed.
   - **Access**: Fulfil sends the person a copy of what they gave (their form answers, their resume, the messages sent to them, their AI interview) as a file attached to the completion email. It holds nothing about other candidates, and not the AI's own notes.
   - **Correction**: name the field and the corrected value. The change is recorded with who made it and why.
   - **Deletion**: the dashboard anonymizes, and never before a lawyer's decision is recorded on the request and the administrator confirms. It removes the person's words from every table that holds them and deletes the resume file; a hire and the findings of a reading stay, as codes with no words. Audit records are never deleted. No lawyer is engaged, so **a real deletion request cannot be finished today** ([DECISIONS.md](../DECISIONS.md), PQ-15): tell the owner on the day it comes in, because the 45 days are running.
   - **A review by a person**, or **a withdrawal** recorded as a request: do what was asked outside the dashboard, then close the request with the outcome in plain words.
5. **Close.** Fulfil or Decline writes the outcome and emails the person what was done, what was kept and why, in plain words.

## Someone who asked for access to the product

A person who sent the company form and is waiting or declined is not a candidate, and the public form answers as if their company did not exist. The privacy mailbox is how they reach us. What we keep about them and for how long is not decided ([DECISIONS.md](../DECISIONS.md), AQ-1). Until it is, delete nothing by hand: tell the owner the same day, treat the 45 days as running, and say from the privacy mailbox what we hold.

## Someone locked

An application past a plan's candidates per job is locked: the hiring team cannot read it, and no AI has. Every step above works the same for them. Defaults, for a lawyer to confirm ([DECISIONS.md](../DECISIONS.md), PQ-6, PQ-13, PQ-15):

- **Nothing goes to the team while they are locked.** Do not write to the company about them.
- **Access.** The copy holds everything they gave. Each application that was ever locked carries `hiringTeamCanSeeThis`, in no plan's words.
- **Deletion.** A deletion frees no place, so it never reveals the next person, and the company's locked card for them stays a card with no name.
- **What we may say.** If they ask why: "The employer did not review your application." Never name the plan, the limit or the money. Do not say or hint how many applied or where they came in. Do not tell the employer who asked. If someone keeps asking, or the candidate is in Colorado, go to the owner and a lawyer before answering.
- **An employer's legal need.** If an agency or a lawsuit asks an employer for applicant records, the employer is never told "upgrade first": the platform produces locked records for a recorded legal reason. Record the reason and who asked in the request's notes, and tell the owner.

## What we cannot reach

The hosting provider's request logs. Vercel records the full address of every request before our code runs. When someone's sign-in is refused, that address can carry their email address; our own logs cut it, but Vercel's copy stays for as long as the plan keeps request logs. We cannot delete one person's lines there. If a request comes from someone who was refused at sign-in, say so plainly in the answer, and tell the owner.

## Before real candidate data

Walk one made-up access request and one made-up deletion end to end: ask, acknowledge, verify, act, close, and check that the person's words are gone from the application, the AI interview, the files and the messages while the stage history remains.
