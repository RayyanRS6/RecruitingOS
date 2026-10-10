import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { CANCEL_STAGES, DECISION_STAGES, createDataRequest, createEscalation, decisionTold, disclosureLine, followUpParked, humanResponseExpectation, loadBusinessCalendar, notify, openFollowUpOf, raiseAlert, setAutoState } from "@ros/core";
import { fromAddress, newTimesDayWords, queueCommunication, recordInbound, replyToFor, requestHuman, sendPrivacyAcknowledgment } from "@ros/agents";
import { applications, candidates, communications, companies, dataRequests, inboundEmails, rolePackets, roles, screens, withPlatform, withTenant, type Tx } from "@ros/db";
import type { InboundEmail } from "@ros/integrations";
import { cancelNewTimesRuns, stopPreparedNewTimes } from "@ros/workflows";
import type { Container } from "../container";
import { screenDeps } from "./screens";
import { optOutOfTalentPool } from "./talent-pool";

/**
 * A candidate's reply to one of our emails (docs/spec/21 F12, D9, H12). With the inbound mail domain configured, every
 * candidate email carries a per-application Reply-To address; the Postmark inbound webhook hands a message to that
 * address here. The reply is recorded on the application as an inbound communication, the team is told with a link
 * straight to the candidate, and a reply whose first line is HUMAN hands the conversation to a person exactly as the
 * HUMAN keyword does in a screening text, with an answer that says when (business hours) and carries the AI disclosure
 * (plan G8). Once the decision message reached them (or they were told), a first line of "no thanks" answers its offer
 * and keeps the person out of the talent pool; before that, the same words are passed to the team as they are. After a decision message, asking for
 * its reasons and a person's review (EXPLAIN, as Colorado's line says) goes to the ITS compliance queue (plan G5).
 * Nothing here ever creates an application or changes a stage.
 */
type App = typeof applications.$inferSelect;
type InboundRow = typeof inboundEmails.$inferSelect;

const EMAIL_REPLY_ACTOR: Actor = { kind: "system", id: "email_reply" };
const SCREEN_ACTIVE_STATUSES = ["invited", "reminded", "in_progress"];

/** The first line of the message alone, trimmed. */
function firstLine(text: string): string {
  return text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

/** HUMAN on the first line (any case, a full stop or an exclamation mark allowed) asks for a person; anything else is a message for the team. */
export function humanRequested(text: string): boolean {
  return /^human[.!]?$/i.test(firstLine(text));
}

/**
 * "No thanks" as the whole first line (any case, with or without a comma, "no thank you" too) answers the decline
 * email's offer: do not keep me for future roles (Wave 0 item 0.11). A longer sentence that merely starts that way is
 * a message for the team, not an opt-out.
 */
export function noThanksRequested(text: string): boolean {
  return /^no[,.]?\s*(thanks|thank you)[.!]*$/i.test(firstLine(text));
}

/**
 * A request for the reasons for a decision and a person's review (plan G5): EXPLAIN as the whole first line, as Colorado's
 * line in the decision message asks, or, after a message that carried that line, a reply that plainly asks why.
 */
export function explanationRequested(text: string, afterColoradoLine: boolean): boolean {
  if (/^explain[.!]?$/i.test(firstLine(text))) return true;
  return afterColoradoLine && /\b(explain|explanation|reasons?\s+(for|behind)|why\s+(was|wasn't|was\s+not|were|am|did|didn't)\b|review\s+(of\s+)?(the|my|this|that)\s+decision)/i.test(text);
}

/**
 * The decision message this application was sent, if any, and whether it carried Colorado's line (the tag the
 * coordinator records on it): only a candidate who was told a decision can ask for its reasons.
 */
async function decisionMessageSent(tx: Tx, app: App): Promise<{ sent: boolean; coloradoLine: boolean }> {
  const rows = await tx.select({ tags: communications.tags }).from(communications).where(and(eq(communications.applicationId, app.id), eq(communications.direction, "outbound"), like(communications.templateKey, "disposition:%"), inArray(communications.status, ["sent", "delivered"])));
  return { sent: rows.length > 0, coloradoLine: rows.some((r) => !!(r.tags as Record<string, string> | null)?.adverseDecisionLine) };
}

/** Whether this reply asks for the reasons for a decision the candidate was sent (neither HUMAN nor "no thanks"). */
async function asksForReasons(tx: Tx, app: App, text: string): Promise<boolean> {
  if (humanRequested(text) || noThanksRequested(text)) return false;
  const told = await decisionMessageSent(tx, app);
  return told.sent && explanationRequested(text, told.coloradoLine);
}

/** What the caller needs to file a request for the reasons. */
type ExplanationAsk = { candidateId: string; email: string | null; companyName: string };

/**
 * A reply from someone under Cancelled (founder decisions 2A and 4A, founder question 8). A reply asking for a person, or
 * "no thanks" before any decision, stops an automatic set still waiting for its day (`candidate_replied`), or one being
 * prepared whose email has not left yet (the interview it reopened goes back to cancelled, `stopPreparedNewTimes`):
 * someone who asked for a person, or said no, is not sent times by software. Any other reply leaves it and names its day.
 * Either way the team's notice says which entry the reply belongs to. The reply itself is recorded and answered as
 * always; none of their words go on the follow-up. Returns the sentence to add to the team's notice ("" when none), and
 * whether it stopped a set (the notice then never says nothing was changed).
 */
async function replyUnderCancelled(tx: Tx, container: Container, input: { app: App; companyTimezone: string; stops: boolean; actor: Actor }): Promise<{ sentence: string; stopped: boolean }> {
  // The application first, then its follow-up: the order the automatic set and a person's send take them.
  const [app] = await tx.select({ stage: applications.stage }).from(applications).where(eq(applications.id, input.app.id)).limit(1).for("update");
  const f = await openFollowUpOf(tx, input.app.id, { lock: true });
  if (!app || !f || !CANCEL_STAGES.includes(app.stage)) return { sentence: "", stopped: false };
  const day = f.autoDueAt ? newTimesDayWords(f.autoDueAt, input.companyTimezone) : null;
  if (followUpParked(f) && input.stops) {
    const now = container.engine.clock();
    await setAutoState(tx, { followUpId: f.id, to: "not_sent", reason: "candidate_replied", actor: input.actor, now });
    await cancelNewTimesRuns(tx, container.engine, { companyId: input.app.companyId, applicationId: input.app.id, actor: input.actor, reason: "the candidate replied" });
    return { sentence: ` Their automatic new times${day ? `, due ${day},` : ""} were stopped: a person should arrange the next step with them. They are under Cancelled.`, stopped: true };
  }
  if (f.autoState === "preparing" && input.stops) {
    const stopped = await stopPreparedNewTimes(tx, { followUp: f, reason: "candidate_replied", actor: input.actor, now: container.engine.clock() });
    if (stopped) return { sentence: " Their automatic new times were stopped before they went out: a person should arrange the next step with them. They are under Cancelled.", stopped: true };
  }
  if (followUpParked(f)) return { sentence: ` New times are due to go to them automatically${day ? ` on ${day}` : ""}. Open them under Cancelled to send them now or stop them.`, stopped: false };
  return { sentence: ` They are under Cancelled${f.kind === "candidate_no_show" ? " as a no-show" : ""}.`, stopped: false };
}

/**
 * Whether a "no thanks" answers the offer about future roles. Only the decision message makes that offer, so this is
 * true only once the candidate knows the decision: the message reached them, someone recorded telling them, or the
 * decision came before decisions were private. A decision the team has not told them yet is unknown to them (founder
 * decision B6), and so is one whose message is still waiting, was taken back with Undo, or failed. In those cases, as
 * before any decision, "no thanks" to a screening invitation or an interview time more likely turns down that step, and
 * it goes to the team as it is.
 */
async function noThanksMeansFutureRoles(tx: Tx, app: App): Promise<boolean> {
  if (DECISION_STAGES.includes(app.stage) && decisionTold(app.toldState)) return true;
  // A decision message that actually left (sent or delivered): also someone told, then moved back with "review anyway".
  return (await decisionMessageSent(tx, app)).sent;
}

export async function handleCandidateReply(tx: Tx, container: Container, input: { app: App; mail: InboundEmail }): Promise<{ communicationId: string; humanRequested: boolean; talentPoolOptOut?: boolean; duplicate?: boolean; explanationRequested?: ExplanationAsk }> {
  const { app, mail } = input;
  // Postmark redelivers a message it thinks was not taken (a timeout after this transaction committed, for instance):
  // the same MessageID on this application is the same reply, recorded once, acted on once. A replay of a request for
  // the reasons still answers it, so the caller files the request if the first delivery could not (filing is idempotent).
  if (mail.messageId) {
    const [seen] = await tx.select({ id: communications.id, bodyText: communications.bodyText }).from(communications).where(and(eq(communications.applicationId, app.id), eq(communications.direction, "inbound"), eq(communications.providerMessageId, mail.messageId))).limit(1);
    if (seen) {
      if (!(await asksForReasons(tx, app, seen.bodyText))) return { communicationId: seen.id, humanRequested: false, duplicate: true };
      const [cand] = await tx.select({ email: candidates.email }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
      const [co] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, app.companyId)).limit(1);
      return { communicationId: seen.id, humanRequested: false, duplicate: true, explanationRequested: { candidateId: app.candidateId, email: cand?.email ?? mail.from ?? null, companyName: co?.name ?? "the company" } };
    }
  }
  const [candidate] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await tx.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  if (!candidate || !role || !company) throw new Error("the application's candidate, role or company is missing");
  const text = (mail.text ?? "").trim().slice(0, 20000) || "(an empty message)";
  const candidateActor: Actor = { kind: "candidate", id: candidate.id };
  const communicationId = await recordInbound(tx, { companyId: app.companyId, candidateId: candidate.id, applicationId: app.id, channel: "email", text, from: mail.from, provider: "postmark", providerMessageId: mail.messageId ?? null, actor: candidateActor });
  const name = `${candidate.firstName} ${candidate.lastName}`.trim() || "A candidate";
  const open = `/roles/${app.roleId}/talent?open=${app.id}`;
  const wantsHuman = humanRequested(text);
  // Once they know the decision the opt-out is done at once and confirmed by email; anything else they wrote stays in the thread for the team.
  const saidNoThanks = !wantsHuman && noThanksRequested(text);
  const aboutFutureRoles = saidNoThanks && (await noThanksMeansFutureRoles(tx, app));
  const optedOut = aboutFutureRoles && (await optOutOfTalentPool(tx, container, { application: app, source: "email_reply" }));
  // Asking for the reasons for a decision and a person's review (plan G5) goes to the ITS compliance queue, never to the
  // assistant; the caller files it as a privacy request once this transaction has committed.
  const wantsExplanation = await asksForReasons(tx, app, text);
  const quoted = `About ${role.title}: "${firstLine(text).slice(0, 140)}"`;
  const cancelled = await replyUnderCancelled(tx, container, { app, companyTimezone: company.timezone, stops: wantsHuman || (saidNoThanks && !aboutFutureRoles), actor: EMAIL_REPLY_ACTOR });
  // A "no thanks" that stopped their automatic new times changed something, so the notice never says nothing was.
  const body = wantsHuman ? `They asked for a person about ${role.title}. A recruiter has been asked to follow up; you can also reply yourself.`
    : optedOut ? `About ${role.title}: they replied "no thanks", so they will not be kept for future roles. They were sent a confirmation; nothing else changed.`
    : saidNoThanks && !aboutFutureRoles ? `${quoted}. This may mean they do not want to go ahead with this step.${cancelled.stopped ? " Reply to check with them." : " Nothing was changed; reply to check with them."}`
    : wantsExplanation ? `About ${role.title}: they asked for the reasons for your decision and for a person to review it. ITS's compliance team has the request and answers them; their message is on their page.`
    : quoted;
  await notify(tx, { companyId: app.companyId, kind: "message.received", title: `${name} wrote back`, body: `${body}${cancelled.sentence}`, action: { label: "Read it", href: open } });
  if (wantsExplanation) return { communicationId, humanRequested: false, explanationRequested: { candidateId: candidate.id, email: candidate.email ?? mail.from ?? null, companyName: company.name } };
  if (!wantsHuman) return { communicationId, humanRequested: false, talentPoolOptOut: optedOut };

  const now = container.engine.clock();
  const calendar = await loadBusinessCalendar(tx, now);
  const signature = pv?.packet.communication.signature || `The hiring team at ${company.name}`;
  // An automatic answer, so it carries the AI disclosure like every other (plan G8).
  const disclosure = pv?.packet.communication.disclosureText || disclosureLine(company.name);
  const reply = `Hi ${candidate.firstName},\n\nUnderstood. A person from ${company.name} will follow up with you ${humanResponseExpectation(now, calendar)}. Thank you for your patience.\n\n${signature}\n\n${disclosure}`;
  const [screen] = await tx.select({ id: screens.id }).from(screens).where(and(eq(screens.applicationId, app.id), inArray(screens.status, SCREEN_ACTIVE_STATUSES))).orderBy(desc(screens.updatedAt)).limit(1);
  if (screen) {
    // The same hand-off as HUMAN in a screening text: the conversation stops, a recruiter gets the whole context, the team is told.
    // The answer to their email below says when; the hand-off sends no second one.
    await requestHuman(tx, screenDeps(container), { screenId: screen.id, reason: "candidate asked for a person by email", actor: EMAIL_REPLY_ACTOR, reply, replyChannel: "web", confirmByEmail: false });
  } else {
    await createEscalation(tx, { companyId: app.companyId, roleId: app.roleId, applicationId: app.id, kind: "candidate_issue", summaryOrigin: "candidate", question: `${name} replied HUMAN to an email about the ${role.title} role and needs a person. Please reach out by email${candidate.phone ? " or phone" : ""} and pick up the conversation.`, requestedBy: EMAIL_REPLY_ACTOR, now });
    await notify(tx, { companyId: app.companyId, kind: "screen.human_requested", title: `${name} asked for a person`, body: `They replied HUMAN to an email about ${role.title}. A recruiter has the request; you can also reply directly.`, action: { label: "Open the candidate", href: open } });
  }
  if (candidate.email) {
    // The response-time sentence goes back the same way every candidate email does: through the outbox, after this transaction commits.
    const subject = mail.subject?.trim() ? (/^re:/i.test(mail.subject.trim()) ? mail.subject.trim() : `Re: ${mail.subject.trim()}`) : `A person will follow up: ${role.title} at ${company.name}`;
    await queueCommunication(tx, container.integrations, { channel: "email", companyId: app.companyId, candidateId: candidate.id, applicationId: app.id, to: candidate.email, from: fromAddress(company, container.integrations), replyTo: replyToFor(app, container.integrations), subject, text: reply, templateKey: "human_requested_reply", idempotencyKey: mail.messageId ? `human_reply:${app.id}:${mail.messageId}` : `human_reply:${communicationId}`, tags: { template: "human_requested_reply", applicationId: app.id }, actor: EMAIL_REPLY_ACTOR, disclosureIncluded: true });
  }
  return { communicationId, humanRequested: true };
}

/**
 * Files a request for the reasons for a decision and a person's review (plan G5) in the ITS compliance queue: a privacy
 * request of kind human review, verified (it came to the application's own reply address), deadline-tracked, and
 * acknowledged to the candidate. ITS answers it; the hiring team sees that they asked, and their reply is on the
 * candidate's thread like any reply to the team's email. Filed once per reply (the reply's communication is named on the
 * request), and a second ask while one is open files nothing new. Privacy requests are platform records, so this runs
 * in a platform transaction after the reply's.
 */
async function fileExplanationRequest(container: Container, input: ExplanationAsk & { app: App; communicationId: string }): Promise<string | null> {
  const actor: Actor = { kind: "candidate", id: input.candidateId };
  const marker = `(reply ${input.communicationId})`;
  return withPlatform(container.db, async (tx) => {
    const [filed] = await tx.select({ id: dataRequests.id }).from(dataRequests).where(and(eq(dataRequests.applicationId, input.app.id), eq(dataRequests.kind, "human_review"), sql`coalesce(${dataRequests.details}, '') like ${`%${marker}%`}`)).limit(1);
    if (filed) return filed.id;
    const [open] = await tx.select({ id: dataRequests.id }).from(dataRequests).where(and(eq(dataRequests.applicationId, input.app.id), eq(dataRequests.kind, "human_review"), inArray(dataRequests.status, ["received", "in_progress"]), sql`coalesce(${dataRequests.details}, '') like 'Asked for the reasons%'`)).limit(1);
    if (open) return open.id;
    const row = await createDataRequest(tx, {
      companyId: input.app.companyId, kind: "human_review", requesterEmail: input.email ?? `unknown+${input.candidateId}@example.invalid`, candidateId: input.candidateId, applicationId: input.app.id, channel: "email", verified: true,
      details: `Asked for the reasons for the decision and a review by a person, replying to the decision message (Colorado adverse-decision line). Their words are on the application's thread ${marker}.`,
      verificationNote: "the reply came to the application's own reply address", actor, now: container.engine.clock(),
    });
    if (input.email) await sendPrivacyAcknowledgment(tx, container.integrations, { row, companyName: input.companyName, privacyEmail: container.env.PRIVACY_EMAIL, actor });
    return row.id;
  });
}

/**
 * The webhook's side: the reply token names the application (a platform read, since no tenant is known yet); the
 * reply is handled in the company's transaction; the inbound row records what became of it. An unknown token is
 * recorded as unmatched and nothing else happens: no application, no message, no error to the sender.
 */
export async function receiveCandidateReply(container: Container, input: { inbound: InboundRow; mail: InboundEmail; replyToken: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const found = await withPlatform(container.db, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.replyToken, input.replyToken)).limit(1);
    if (!app) return null;
    const [cand] = await tx.select({ anonymizedAt: candidates.anonymizedAt }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
    return { app, anonymized: !!cand?.anonymizedAt };
  });
  if (!found) {
    await withPlatform(container.db, (tx) => tx.update(inboundEmails).set({ status: "unmatched", error: "unknown reply token" }).where(eq(inboundEmails.id, input.inbound.id)));
    return { status: 200, body: { ok: true, matched: false } };
  }
  const { app } = found;
  if (found.anonymized) {
    // A deletion request was fulfilled for this person: a reply to an old email must not write their address or words
    // back. The inbound row keeps nothing personal, nothing is recorded on the application, and nobody is notified.
    await withPlatform(container.db, (tx) => tx.update(inboundEmails).set({ status: "unmatched", error: "reply to a record removed at the person's request", fromAddress: "(removed)", subject: null, parsed: {} }).where(eq(inboundEmails.id, input.inbound.id)));
    return { status: 200, body: { ok: true, matched: false } };
  }
  let r: Awaited<ReturnType<typeof handleCandidateReply>>;
  try {
    r = await withTenant(container.db, app.companyId, (tx) => handleCandidateReply(tx, container, { app, mail: input.mail }));
    await withPlatform(container.db, (tx) => tx.update(inboundEmails).set({ status: r.duplicate ? "duplicate" : "matched", companyId: app.companyId, applicationId: app.id }).where(eq(inboundEmails.id, input.inbound.id)));
  } catch (err) {
    await withPlatform(container.db, (tx) => tx.update(inboundEmails).set({ status: "error", companyId: app.companyId, error: err instanceof Error ? err.message : String(err) }).where(eq(inboundEmails.id, input.inbound.id)));
    return { status: 202, body: { ok: false, matched: true, reply: true, error: "could not record the reply; queued for review" } };
  }
  // A request for the reasons is a deadline-tracked compliance request the team was just told ITS has: it is never lost.
  // When it cannot be filed, an operator is alerted and the provider is asked to send the reply again (503); the replay
  // finds the reply already recorded and files the request (counsel register item 24).
  let explanationRequestId: string | null = null;
  if (r.explanationRequested) {
    try {
      explanationRequestId = await fileExplanationRequest(container, { app, communicationId: r.communicationId, ...r.explanationRequested });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await withPlatform(container.db, (tx) => tx.update(inboundEmails).set({ status: "error", error: `the request for the reasons could not be filed: ${error}` }).where(eq(inboundEmails.id, input.inbound.id)));
      await withPlatform(container.db, (tx) => raiseAlert(tx, { kind: "privacy_request.not_filed", severity: "high", title: "A request for the reasons for a decision could not be filed", body: `A candidate replied asking for the reasons for a decision and a person's review, and filing it in the privacy queue failed: ${error}. The reply is on the application; file the request by hand if the provider's retry does not.`, companyId: app.companyId, target: { type: "application", id: app.id }, details: { communicationId: r.communicationId } })).catch(() => undefined);
      return { status: 503, body: { ok: false, matched: true, reply: true, error: "could not file the request for the reasons; send it again" } };
    }
  }
  if (r.duplicate) return { status: 200, body: { ok: true, matched: true, reply: true, duplicate: true, applicationId: app.id, ...(explanationRequestId ? { explanationRequestId } : {}) } };
  await container.kick();
  return { status: 200, body: { ok: true, matched: true, reply: true, applicationId: app.id, humanRequested: r.humanRequested, talentPoolOptOut: !!r.talentPoolOptOut, ...(explanationRequestId ? { explanationRequestId } : {}) } };
}
