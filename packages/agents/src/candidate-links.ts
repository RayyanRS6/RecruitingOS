import type { Actor } from "@ros/contracts";
import type { Queryable, applications, candidates, companies } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import { fromAddress, replyToFor } from "./coordinator";
import { queueCommunication, type QueueResult } from "./outbox";

type App = typeof applications.$inferSelect;
type Cand = typeof candidates.$inferSelect;
type Company = typeof companies.$inferSelect;

/**
 * The emails that carry a candidate's own status link outside the acknowledgment (Wave 0 item 0.1), and the
 * confirmation of a talent-pool opt-out (item 0.11). Templated, never written by the model, sent to the address the
 * company already has on file (never to an address someone typed into a form), and queued through the outbox like
 * every candidate email. Each one is limited by its idempotency key: repeat submissions send at most one notice a day
 * per application, "lost your link" requests at most one email an hour per person.
 */

/** The status page an application's own link opens. */
export function statusUrlFor(appBaseUrl: string, application: Pick<App, "statusToken">): string {
  return `${appBaseUrl}/c/status/${application.statusToken}`;
}

/** The UTC day and hour the limits count in. */
function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}
function hourKey(now: Date): string {
  return now.toISOString().slice(0, 13);
}

/**
 * Someone sent the form again with an address that already has an application for this role. The page they see is the
 * same as for anyone else; the person who owns the address learns here that nothing was changed, and gets their link.
 */
export async function sendRepeatApplicationNotice(q: Queryable, integrations: Integrations, input: { application: App; candidate: Cand; company: Company; roleTitle: string; signature?: string | null; appBaseUrl: string; actor: Actor; now: Date }): Promise<QueueResult | null> {
  const { application, candidate, company } = input;
  if (!candidate.email) return null;
  const text = `Hi ${candidate.firstName},

We received another application for the ${input.roleTitle} position at ${company.name} from this email address. You already have an application with us, so we kept that one exactly as it was. Nothing in it was changed or replaced.

You can check where things stand at any time with your own link:
${statusUrlFor(input.appBaseUrl, application)}

If you did not send the second application, you do not need to do anything. If something looks wrong, reply to this email and a person will look into it.

${input.signature || `The hiring team at ${company.name}`}`;
  return queueCommunication(q, integrations, {
    channel: "email",
    companyId: company.id,
    candidateId: candidate.id,
    applicationId: application.id,
    to: candidate.email,
    from: fromAddress(company, integrations),
    replyTo: replyToFor(application, integrations),
    subject: `Your application for ${input.roleTitle} at ${company.name}`,
    text,
    templateKey: "status_link_repeat",
    // Per application, not per person: a repeat for a second role gets that role's own link the same day.
    idempotencyKey: `status_link_repeat:${application.id}:${dayKey(input.now)}`,
    tags: { template: "status_link_repeat", applicationId: application.id },
    actor: input.actor,
    disclosureIncluded: false,
  }, input.now);
}

/** "Lost your link?": one email per company, listing the person's own links there, newest first. */
export async function sendStatusLinks(q: Queryable, integrations: Integrations, input: { candidate: Cand; company: Company; items: Array<{ application: App; roleTitle: string }>; appBaseUrl: string; actor: Actor; now: Date }): Promise<QueueResult | null> {
  const { candidate, company, items } = input;
  if (!candidate.email || !items.length) return null;
  const several = items.length > 1;
  const lines = items.map((i) => `${i.roleTitle}: ${statusUrlFor(input.appBaseUrl, i.application)}`).join("\n");
  const text = `Hi ${candidate.firstName},

You asked us to send your application link${several ? "s" : ""} again. ${several ? "Here is the link for each of your applications" : "Here is the link for your application"} at ${company.name}:

${lines}

Each link opens your own status page, where you can see where things stand, withdraw, or ask about your information. Keep this email: there is no account or password.

If you did not ask for this, you do not need to do anything.

The hiring team at ${company.name}`;
  const latest = items[0].application;
  return queueCommunication(q, integrations, {
    channel: "email",
    companyId: company.id,
    candidateId: candidate.id,
    applicationId: latest.id,
    to: candidate.email,
    from: fromAddress(company, integrations),
    replyTo: replyToFor(latest, integrations),
    subject: `Your application link${several ? "s" : ""}: ${company.name}`,
    text,
    templateKey: "status_link_request",
    idempotencyKey: `status_link_request:${candidate.id}:${hourKey(input.now)}`,
    tags: { template: "status_link_request", applicationId: latest.id },
    actor: input.actor,
    disclosureIncluded: false,
  }, input.now);
}

/**
 * The person asked not to be kept for future roles (a "no thanks" reply, or the button on the status page): done, and
 * said so once. The way back is real: the status page has a button to be kept for future roles again.
 */
export async function sendTalentPoolOptOutConfirmation(q: Queryable, integrations: Integrations, input: { application: App; candidate: Cand; company: Company; appBaseUrl: string; actor: Actor }): Promise<QueueResult | null> {
  const { application, candidate, company } = input;
  if (!candidate.email) return null;
  const text = `Hi ${candidate.firstName},

Done. ${company.name} will not keep your details for future roles, and nobody will contact you about other openings.

This does not change an application you have open right now: it carries on as before, and your status link still works.

If you change your mind, your status page has a button to be kept for future roles again:
${statusUrlFor(input.appBaseUrl, application)}

The hiring team at ${company.name}`;
  return queueCommunication(q, integrations, {
    channel: "email",
    companyId: company.id,
    candidateId: candidate.id,
    applicationId: application.id,
    to: candidate.email,
    from: fromAddress(company, integrations),
    replyTo: replyToFor(application, integrations),
    subject: `You will not be contacted about future roles: ${company.name}`,
    text,
    templateKey: "talent_pool_opt_out",
    idempotencyKey: `talent_pool_opt_out:${candidate.id}`,
    tags: { template: "talent_pool_opt_out", applicationId: application.id },
    actor: input.actor,
    disclosureIncluded: false,
  });
}
