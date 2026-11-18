/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { CANDIDATE_STEP_LABEL, CandidatePrivacyRequest, SCREEN_ACTIVE_STATUSES, type ApplicationStage, type CandidateStep, type RolePacket, type ScreenStatus } from "@ros/contracts";
import { CLOSE_OUT_TEMPLATE, sendPrivacyAcknowledgment } from "@ros/agents";
import { CLOSED_OUT_STATUS_LINE, audit, candidateStep, closeOutDayWords, closeOutDueAt, createDataRequest, decisionTold, isCompanyLive, mayWithdraw, onFileNoDateLine, onFileStatusLine, openHumanReview, screenAnswersSent } from "@ros/core";
import { applications, candidates, communications, companies, dataRequests, events, roles, withPlatform, withTenant } from "@ros/db";
import type { Vars } from "../middleware/session";
import type { Container } from "../container";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { packetOf, screensOf, sentAnswersFor, sentInterviewPacket, type SentAnswers } from "../services/application-record";
import { queueLinkRequest, recordWithdrawal, rotateStatusLink, withdrawApplication } from "../services/applications";
import { contactLineFor } from "../services/company-settings-profile";
import { CORRECTION_REQUEST, anonymizedFor, linkGone, maskEmail } from "./candidate-shared";
import { Icon } from "./icons";
import { JobFacts } from "./job-facts";
import { ContactLink } from "./job-page";
import { Layout } from "./layout";
import { CARD_PAGE_CSS } from "./signin-link";
import { CHAT_BUBBLE_CSS } from "./conversation-frame";
import { forTheWeb } from "./web-wording";

/**
 * The candidate's own pages about their application: "Lost your link?", the status page at /c/status/:token, and
 * everything its forms do (privacy requests, withdrawing, a new link). Mounted on the candidate pages by
 * pages/candidate.tsx.
 */
const candidatePages = new Hono<Vars>();
export { candidatePages as recordPages };

/* ------------------------------------------------------------------------------------------------------------ */
/* "Lost your link?": the status link goes again to the address on file, never to the page.                      */
/* ------------------------------------------------------------------------------------------------------------ */

/** The form's one field. */
const LinkRequestForm = z.object({ email: z.email().max(254) });

function LinkRequestPage(props: { error?: string; email?: string }) {
  return (
    <Layout title="Get your application link again" extraCss={CARD_PAGE_CSS}>
      <h1>Lost your link?</h1>
      <p class="lead">Type the email address you applied with. If we have an application from it, we email your link there, never to this page.</p>
      {props.error ? <div class="err" role="alert">{props.error}</div> : null}
      <form method="post" action="/c/link-request" class="card">
        <div class="trap" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" type="text" tabindex={-1} autocomplete="off" /></div>
        <label for="email" class="flush">Your email address</label>
        <input id="email" name="email" type="email" required autocomplete="email" value={props.email ?? ""} />
        <button class="btn" type="submit">Email me my link</button>
      </form>
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
    </Layout>
  );
}

/** What every request answers, whether or not the address is known: only the mailbox learns that. */
function LinkRequestSent() {
  return (
    <Layout title="Check your email" extraCss={CARD_PAGE_CSS}>
      <h1>Check your email</h1>
      <div class="card" role="status">
        <p><strong>If we have an application from that address, your link is on its way.</strong></p>
        <p>It can take a few minutes; look in your spam or promotions folder too. To protect your privacy, this page looks the same whether or not we found anything.</p>
      </div>
      <p class="foot">Still nothing? You may have applied with a different address. <a href="/c/link-request">Try another address</a>.</p>
    </Layout>
  );
}

candidatePages.get("/c/link-request", (c) => {
  c.header("Cache-Control", "no-store");
  return c.html(c.req.query("sent") === "1" ? <LinkRequestSent /> : <LinkRequestPage />);
});

candidatePages.post("/c/link-request", rateLimit(POLICIES.linkRequest), async (c) => {
  const container = c.get("container");
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
  // the honeypot is answered like everyone else and sends nothing
  if (str("website")) return c.redirect("/c/link-request?sent=1", 303);
  const parsed = LinkRequestForm.safeParse({ email: str("email").trim() });
  if (!parsed.success) return c.html(<LinkRequestPage error="Please check the email address and send it again." email={str("email")} />, 400);
  // One queued job for every address, known or not; the worker looks it up (in production the kick does nothing here).
  await queueLinkRequest(container, parsed.data.email);
  await container.kick();
  return c.redirect("/c/link-request?sent=1", 303);
});

/**
 * The status page's styles. The steps it leads with: one card, a numbered circle per step joined by a line, past steps
 * filled in plum with a tick, the current one ringed in plum with a lavender halo (and announced as the current step).
 * Down the page on a phone, across it from 600 pixels. No motion. Their chat, read back word for word, wears the AI
 * interview's own look (`CHAT_BUBBLE_CSS`).
 */
export const STATUS_CSS = `
.track { display: grid; margin: 22px 0 14px; padding: 16px 18px; border: 1px solid var(--line); border-radius: var(--r-card); background: var(--surface); list-style: none; counter-reset: track; }
.track li { position: relative; display: flex; align-items: flex-start; gap: 12px; padding: 6px 0; color: var(--ink-3); font-size: 15px; font-weight: 600; line-height: 1.3; counter-increment: track; }
.track li > span:nth-child(2) { padding-top: 6px; }
.track li:not(:last-child)::after { content: ""; position: absolute; top: 40px; bottom: -4px; left: 15px; width: 2px; border-radius: 2px; background: var(--line); }
.track li.done:not(:last-child)::after { background: var(--primary); }
.track .dot { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border: 1.5px solid var(--line-2); border-radius: 50%; background: var(--surface); color: var(--ink-3); font-size: 13px; font-variant-numeric: tabular-nums; }
.track .dot::before { content: counter(track); }
.track li.done .dot { border-color: var(--primary); background: var(--primary); color: var(--on-primary); }
.track li.done .dot::before { content: none; }
.track .dot .icon { width: 15px; height: 15px; stroke-width: 2.5; }
.track li.current .dot { border-color: var(--primary); color: var(--primary); box-shadow: 0 0 0 4px var(--tint-2); }
.track li.done { color: var(--ink-2); }
.track li.current { color: var(--ink); }
@media (min-width: 600px) {
  .track { grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); padding: 20px 12px 18px; }
  .track li { flex-direction: column; align-items: center; gap: 10px; padding: 0 4px; font-size: 13.5px; text-align: center; }
  .track li > span:nth-child(2) { padding-top: 0; }
  .track li:not(:last-child)::after { top: 15px; bottom: auto; left: calc(50% + 22px); right: calc(-50% + 22px); width: auto; height: 2px; }
}
${CHAT_BUBBLE_CSS}${recordCss()}${CARD_PAGE_CSS}`;

/**
 * The status page's own parts: the pills that jump to each section; "What happens next" as the "your next step" card
 * (`.next-step`: its heading as a small eyebrow with a coral dot, the line in display type, the one thing to do); the
 * status card as one strip of label-over-value cells; the answers read back, with a pill for one skipped or changed; and
 * the details as label/value rows. Tokens only, no motion, no button rules. A function, so the status page's stylesheet
 * above can name it before this point in the file.
 */
function recordCss(): string {
  return `
.jump { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 24px; padding: 0; list-style: none; }
.jump a { display: inline-flex; align-items: center; min-height: 34px; padding: 6px 14px; border: 1px solid var(--line-2); border-radius: var(--r-pill); background: var(--surface); color: var(--ink-2); font-size: 13.5px; font-weight: 600; line-height: 1.2; text-decoration: none; }
.next-step { margin: 0 0 20px; padding: 26px; border: 1px solid var(--tint-2); border-radius: var(--r-panel); background: linear-gradient(115deg, var(--tint) 0%, var(--surface) 58%, var(--peach) 135%); }
.next-step > h2 { display: flex; align-items: center; gap: 10px; margin: 0 0 10px; color: var(--ink-2); font-family: var(--mono); font-size: 11.5px; font-weight: 400; line-height: 1.4; letter-spacing: 0.14em; text-transform: uppercase; }
.next-step > h2::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.next-step > h2 + p { margin: 0; color: var(--ink); font-family: var(--display); font-size: 22px; font-weight: 700; line-height: 1.25; letter-spacing: -0.02em; }
.next-step > p + p { margin: 12px 0 0; color: var(--ink-2); font-size: 15px; }
.next-step > a { margin-top: 20px; }
main .next-step > .card, main .next-step > .card[role="status"] { margin: 16px 0 0; border-color: var(--line); border-radius: var(--r-card); background: var(--surface); }
div.card.status { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr)); gap: 0; margin: 20px 0; padding: 0; overflow: hidden; border: 1px solid var(--line); border-radius: var(--r-card); background: var(--surface); }
.card.status > div { display: grid; align-content: start; gap: 4px; margin: 0; padding: 16px 20px; border: 0; box-shadow: -1px 0 0 var(--line), 0 -1px 0 var(--line); }
.card.status > div > :first-child { color: var(--ink-2); font-size: 13px; font-weight: 400; }
.card.status > div > :last-child { min-width: 0; color: var(--ink); font-family: var(--display); font-size: 19px; font-weight: 700; line-height: 1.25; letter-spacing: -0.01em; text-align: left; overflow-wrap: anywhere; }
.said { display: grid; gap: 14px; margin: 10px 0 0; padding: 0; list-style: none; }
.said > li + li { padding-top: 14px; border-top: 1px solid var(--line); }
.said-q { margin: 0 0 4px; color: var(--ink); font-weight: 600; }
.said .pre { margin: 0; color: var(--ink-2); }
.state { display: inline-flex; align-items: center; min-height: 24px; padding: 2px 10px; border-radius: var(--r-pill); background: var(--surface-2); color: var(--ink-2); font-size: 12.5px; font-weight: 600; line-height: 1.3; white-space: nowrap; }
.details { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 20px; margin: 10px 0 0; font-size: 14.5px; }
.details dt { color: var(--ink-2); }
.details dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; }
@media (hover: hover) and (pointer: fine) { .jump a:hover { border-color: var(--line-strong); color: var(--ink); } }
@media (pointer: coarse) { .jump a { min-height: 40px; } }
@media (max-width: 600px) {
  .next-step { padding: 22px 18px; }
  .next-step > h2 + p { font-size: 20px; }
  .details { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .details dd { margin-bottom: 8px; }
}
`;
}

/**
 * What the candidate may see of a decision: Not selected shows only once they were told. Until then the page stands where
 * they last saw it: the stage the decision was made at, and the date that stage began. Read off the stage history.
 */
async function visibleStage(container: Container, app: typeof applications.$inferSelect): Promise<{ hidden: boolean; before: ApplicationStage | null; since: string }> {
  if (app.stage !== "rejected" || decisionTold(app.toldState)) return { hidden: false, before: null, since: app.stageChangedAt };
  const moves = await withTenant(container.db, app.companyId, (tx) => tx.select({ payload: events.payload, at: events.occurredAt }).from(events).where(and(eq(events.subjectType, "application"), eq(events.subjectId, app.id), eq(events.type, "application.stage_changed"))).orderBy(asc(events.id)));
  return { hidden: true, before: (moves.at(-1)?.payload.from as ApplicationStage | undefined) ?? null, since: moves.at(-2)?.at ?? app.createdAt };
}

/**
 * Someone past their plan's candidates per job: `byDay`, the day they hear by, `closedOut`, that they have had the
 * close-out note, `datePassed`, that the day has gone by, and `jobClosed`, that the job has closed. Their page never says
 * the team is reviewing them, and promises no email or date once that may not be true. The moment they are unlocked the
 * page goes back to its usual words by itself. DRAFT WORDING PENDING COUNSEL (packages/core/src/candidate-lock.ts).
 */
type OnFile = { byDay: string; closedOut: boolean; datePassed: boolean; jobClosed: boolean };

/** Their line while the page stands before any decision they were told. */
function onFileLine(onFile: OnFile, companyName: string): string {
  if (onFile.closedOut) return CLOSED_OUT_STATUS_LINE;
  if (onFile.jobClosed) return onFileNoDateLine(companyName);
  return onFile.datePassed ? CLOSED_OUT_STATUS_LINE : onFileStatusLine(companyName, onFile.byDay);
}

/** Said while a person may still decide: it promises no answer, because nothing answers a candidate by itself. */
const REVIEWING_LINE = "The hiring team is reviewing your application.";
/** Said once their job has closed to someone not hired and not told a decision: what is true, and nothing more. */
const JOB_CLOSED_LINE = "This job is no longer taking applications.";

/**
 * The line under the steps, in the candidate's words: what is happening now and what they can do. `interview`: their AI
 * interview's link is open (`open`), they have begun it (`started`), or they sent their answers (`sent`);
 * `interviewUntil`: the day an open link closes. `jobClosed`: the job has closed, which by itself tells nobody a decision.
 */
function nextLine(input: { step: CandidateStep; stage: ApplicationStage; interview: "open" | "started" | "sent" | null; interviewUntil: string | null; companyName: string; onFile: OnFile | null; jobClosed: boolean }): string {
  const { step, stage } = input;
  if (step === "decision") return stage === "hired" ? "You are on the team." : stage === "withdrawn" ? "You withdrew this application. Thank you for your time." : "Thank you for applying. This role did not work out.";
  if (input.onFile && (step === "received" || step === "under_review")) return onFileLine(input.onFile, input.companyName);
  if (input.jobClosed) return JOB_CLOSED_LINE;
  if (step === "received") return stage === "applied" ? "We are confirming your application now." : "Your application is in. We are checking the basics.";
  if (step === "under_review") return REVIEWING_LINE;
  const until = input.interviewUntil ? ` Its link stays open until ${input.interviewUntil}.` : "";
  if (input.interview === "started") return `Your AI interview is saved where you left it.${until}`;
  if (input.interview === "open") return `Your next step is a short AI interview with the hiring team's AI assistant.${until}`;
  return input.interview === "sent" ? "Thanks for completing the AI interview. The team is reviewing your answers." : REVIEWING_LINE;
}

/** A day on the status page ("Oct 14, 2026"), in the company's time zone. */
export function statusDay(at: string | Date, timeZone: string): string {
  return new Date(at).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
}

/** The steps as the page draws them: a circle per step (a tick once done), the words, and "done" for a screen reader. */
function ProgressLine(props: { steps: CandidateStep[]; current: CandidateStep }) {
  const at = props.steps.indexOf(props.current);
  return (
    <ol class="track" aria-label="Where your application is">
      {props.steps.map((s, i) => {
        const state = i < at ? "done" : i === at ? "current" : undefined;
        return (
          <li class={state} aria-current={state === "current" ? "step" : undefined}>
            <span class="dot" aria-hidden="true">{state === "done" ? <Icon name="check" /> : null}</span>
            <span>{CANDIDATE_STEP_LABEL[s]}</span>
            {state === "done" ? <span class="sr-only"> (done)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** The pills under the steps that jump to each part of the record: plain links, no script. */
function JumpLinks(props: { items: Array<{ href: string; label: string }> }) {
  return (
    <nav aria-label="On this page">
      <ul class="jump">{props.items.map((i) => <li><a href={i.href}>{i.label}</a></li>)}</ul>
    </nav>
  );
}

/**
 * The decision as the candidate knows it: only once they were told or it is their own act (`candidateStep`), in plain
 * words. Null before then, so nothing hints at a decision kept private.
 */
export function decisionHeadline(step: CandidateStep, stage: ApplicationStage): string | null {
  if (step !== "decision") return null;
  if (stage === "hired") return "Hired";
  if (stage === "withdrawn") return "You withdrew";
  return "Not moving forward";
}

function DecisionCard(props: { headline: string; since: string }) {
  return (
    <section class="card" aria-labelledby="decision">
      <p class="eyebrow">Decision</p>
      <h2 id="decision">{props.headline}</h2>
      <p class="meta">Since {props.since}</p>
    </section>
  );
}

/** "Changed by you", "Skipped", "Not answered": how an answer came to be, beside it. */
const SENT_MARK: Record<"skipped" | "changed" | "not_given", string> = { skipped: "Skipped", changed: "Changed by you", not_given: "Not answered" };

/**
 * "Your answers": exactly what the candidate sent, read only. Their details on file, the job's screening questions from
 * the form in the one wording every reader uses, and the AI interview they sent: each question with its answer, and the
 * whole chat word for word one click away. Never an answer they did not send, never the team's notes, never a score.
 */
function AnswersSection(props: { sent: SentAnswers; companyName: string; timeZone: string; details: { email: string | null; resume: boolean } }) {
  const { sent, details } = props;
  return (
    <section id="answers" aria-labelledby="answers-h">
      <h2 id="answers-h">Your answers</h2>
      <p class="meta">To correct something, use <a href="#help">"{CORRECTION_REQUEST}"</a> below.</p>
      <div class="card">
        <h3>Your details</h3>
        <dl class="details">
          {details.email ? <><dt>Email</dt><dd>{maskEmail(details.email)}</dd></> : null}
          {details.resume ? <><dt>Sent with it</dt><dd>Your resume</dd></> : null}
        </dl>
      </div>
      {sent.questions.length ? (
        <div class="card">
          <h3>Questions from {props.companyName}</h3>
          <ul class="said">{sent.questions.map((s) => <li>{s}</li>)}</ul>
        </div>
      ) : null}
      {sent.chat ? (
        <div class="card">
          <h3>From your AI interview</h3>
          {sent.chat.sentAt ? <p class="meta">Sent {statusDay(sent.chat.sentAt, props.timeZone)}</p> : null}
          <ol class="said">
            {sent.chat.answers.map((a, i) => (
              <li>
                <p class="said-q">{i + 1}. {a.question}</p>
                {a.mark ? <p><span class="state">{SENT_MARK[a.mark]}</span></p> : null}
                <p class="pre">{a.answer ?? (a.mark === "skipped" ? "You skipped this question." : "No answer was given.")}</p>
              </li>
            ))}
          </ol>
          {sent.chat.lines.length ? (
            <details class="more">
              <summary>Your chat, word for word</summary>
              <ol class="thread">
                {sent.chat.lines.map((l) => <li class={`msg ${l.who}`}><span class="sr-only">{l.who === "candidate" ? "You said: " : "The assistant said: "}</span>{l.who === "assistant" ? forTheWeb(l.text) : l.text}</li>)}
              </ol>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * "The job": the job's facts as they were when they applied, what the team looks for, and its page while it is public.
 * Not its title and employer again: the page's heading is the job, and the line on who decides names the employer.
 */
function JobSection(props: { packet: RolePacket; href: string | null }) {
  const { packet } = props;
  const mustHaves = packet.requirements.mustHaves.map((m) => m.text.trim()).filter(Boolean);
  return (
    <section class="card" id="job" aria-labelledby="job-h">
      <h2 id="job-h">The job</h2>
      <JobFacts packet={packet} pay="" small schedule={false} />
      {mustHaves.length ? <><h3>What the team is looking for</h3><ul>{mustHaves.map((t) => <li>{t}</li>)}</ul></> : null}
      {props.href ? <p><a href={props.href}>See the job page</a></p> : null}
    </section>
  );
}

/**
 * The candidate's status page. It leads with the steps (Received, Under review, AI interview for someone who was
 * shortlisted, Decision once they were told) and the one line on what happens next, with the button into their AI
 * interview while its link is open. Never the team's stage names, and never a score. Not selected shows only once the
 * candidate was told; until then the page stands where it was and withdrawing stays open. Once the job has closed,
 * someone not hired and not told reads that it takes no more applications, and nothing is promised or offered. A line
 * says a person decides.
 */
candidatePages.get("/c/status/:token", async (c) => {
  const container = c.get("container");
  const db = container.db;
  const [app] = await db.select().from(applications).where(eq(applications.statusToken, c.req.param("token"))).limit(1);
  if (app && (await anonymizedFor(container, app.candidateId))) return linkGone(c);
  if (!app) return c.notFound();
  const [cand] = await db.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await db.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await db.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const view = await visibleStage(container, app);
  const record = await withTenant(db, app.companyId, async (tx) => {
    const all = await screensOf(tx, app.id);
    const packet = await packetOf(tx, app.roleId, app.packetVersion);
    // Only what left us: a close-out note still waiting has told them nothing yet.
    const closedOut = !!app.lockedAt && (await tx.select({ id: communications.id }).from(communications).where(and(eq(communications.applicationId, app.id), eq(communications.templateKey, CLOSE_OUT_TEMPLATE), inArray(communications.status, ["sent", "delivered", "opened", "clicked"]))).limit(1)).length > 0;
    return { screens: all, packet, closedOut, sent: sentAnswersFor({ app, packet, interviewPacket: await sentInterviewPacket(tx, app, all, packet), screens: all }) };
  });
  const newest = record.screens[0];
  const jobClosed = role?.status === "closed";
  // A private decision closed their AI interview: nothing of it is offered, and the page stands where it was. Nor is one
  // offered on a job that has closed.
  const open = !view.hidden && !jobClosed && newest && SCREEN_ACTIVE_STATUSES.includes(newest.status as ScreenStatus) ? newest : null;
  const shownStage = view.hidden ? view.before ?? "triaged" : app.stage;
  const step = candidateStep(app.stage, app.toldState, view.before);
  // The AI interview is a step for someone at it, and behind someone who began or sent one; never one that did not happen.
  const interviewed = !!newest && (screenAnswersSent(newest) || !!newest.startedAt);
  const steps: CandidateStep[] = ["received", "under_review", ...(step === "interview" || (step === "decision" && interviewed) ? (["interview"] as const) : []), ...(step === "decision" ? (["decision"] as const) : [])];
  // Dates on the page are the company's days, never the server's.
  const companyZone = company?.timezone ?? "America/Los_Angeles";
  const companyName = company?.name ?? "the company";
  const onFile: OnFile | null = app.lockedAt ? { byDay: closeOutDayWords(closeOutDueAt(app.createdAt), companyZone), closedOut: record.closedOut, datePassed: container.engine.clock().getTime() >= closeOutDueAt(app.createdAt).getTime(), jobClosed } : null;
  const decision = decisionHeadline(step, shownStage);
  const jobHref = company && role && isCompanyLive(company.settings) && role.currentPacketVersion && role.status !== "draft" ? `/careers/${company.slug}/jobs/${role.id}` : null;
  const jump = [
    { href: "#answers", label: "Your answers" },
    ...(record.packet ? [{ href: "#job", label: "The job" }] : []),
    { href: "#choices", label: "Your choices" },
    { href: "#help", label: "Help" },
  ];
  return c.html(
    <Layout title={`Your application at ${company?.name ?? ""}`} extraCss={STATUS_CSS}>
      {/* The employer's name above the job's title: the heading is the job, and nothing else near the top names the employer. */}
      {company?.name ? <p class="eyebrow">{company.name}</p> : null}
      <h1>{role?.title}</h1>
      <ProgressLine steps={steps} current={step} />
      <JumpLinks items={jump} />
      {/* Where things stand, then the one thing to do now. */}
      <div class="next-step">
        <h2>What happens next</h2>
        <p>{nextLine({ step, stage: shownStage, interview: open ? (open.status === "in_progress" ? "started" : "open") : shownStage === "screen_complete" ? "sent" : null, interviewUntil: open?.expiresAt ? statusDay(open.expiresAt, companyZone) : null, companyName: company?.name ?? "The company", onFile, jobClosed })}</p>
        {open ? <a class="btn" href={`/c/screen/${open.token}`}>{open.status === "in_progress" ? "Continue your AI interview" : "Start your AI interview"}</a> : null}
        {c.req.query("withdrawn") === "1" ? <div class="card" role="status"><strong>Your application is withdrawn.</strong><p>Thank you for your time. If you have a question, reply to any of our emails.</p></div> : null}
      </div>
      {/* One line that people decide; how the AI helps is one click away. */}
      <p class="meta">People on the hiring team at {companyName} make every decision about your application.</p>
      <details class="more">
        <summary>How AI is used</summary>
        <p class="meta">An AI assistant reads applications and runs the AI interview for them; who is interviewed, hired or turned down is always a person's decision.</p>
      </details>
      <div class="card status">
        <div><span>Status</span><strong>{CANDIDATE_STEP_LABEL[step]}</strong></div>
        <div><span>Applied</span><span>{statusDay(app.createdAt, companyZone)}</span></div>
        <div><span>Last update</span><span>{statusDay(view.since, companyZone)}</span></div>
      </div>
      {decision ? <DecisionCard headline={decision} since={statusDay(view.since, companyZone)} /> : null}
      <AnswersSection sent={record.sent} companyName={companyName} timeZone={companyZone} details={{ email: cand?.email ?? null, resume: !!app.resumeDocumentId }} />
      {record.packet ? <JobSection packet={record.packet} href={jobHref} /> : null}
      <h2 id="choices">Your choices</h2>
      {/* Open to anyone still in the process, and to anyone whose decision they have not been told. One click away; open
          when a send without the confirmation box came back (?confirm=withdraw). */}
      {mayWithdraw(app.stage, app.toldState) ? (
        <details class="more" open={c.req.query("confirm") === "withdraw"}>
          <summary>No longer interested?</summary>
          <form method="post" action={`/c/status/${app.statusToken}/withdraw`} class="card">
            <p>One click withdraws your application; we will confirm by email and keep your information only as long as the law requires.</p>
            <label class="check"><input type="checkbox" name="confirm" value="yes" required /> Yes, withdraw my application.</label>
            <button class="btn secondary" type="submit">Withdraw my application</button>
          </form>
        </details>
      ) : null}
      <h2 id="help">Need something?</h2>
      <p>To reach a person, email <ContactLink contact={contactLineFor(company?.settings, container.env)} />, or make a request below.</p>
      {c.req.query("request") ? <div class="card" role="status"><strong>We have your request.</strong><p>A confirmation with the completion date is on its way to {cand?.email ?? "your email"}. Reference {c.req.query("request")}.</p></div> : null}
      {/* Requests about their information, and a review by a person, one click away. */}
      <details class="more">
        <summary>{CORRECTION_REQUEST}</summary>
        <p>To request, correct, or delete your information you can also email <a href={`mailto:${container.env.PRIVACY_EMAIL}`}>{container.env.PRIVACY_EMAIL}</a>; see <a href="/privacy">how we handle your information</a>.</p>
        <form method="post" action={`/c/status/${app.statusToken}/privacy`} class="card">
          <label for="pk" class="flush">What would you like?</label>
          <select id="pk" name="kind" required>
            <option value="access">Send me a copy of my information</option>
            <option value="correct">Correct something in my information</option>
            <option value="delete">Delete my information</option>
            <option value="human_review">Have a person review my application</option>
          </select>
          <label for="pd">Details (optional)</label>
          <textarea id="pd" name="details" rows={3} maxlength={2000} placeholder="For example: my phone number is wrong, it should be ..."></textarea>
          <p class="notice">Requests made from this page are verified by the link itself. We confirm receipt and completion by email. Deleting keeps only what the law requires, without your name or contact details. A person handles every request; nothing is decided by software.</p>
          <button class="btn secondary" type="submit">Send request</button>
        </form>
      </details>
      {/* A link shared by mistake can be replaced; the new one goes only to the email on file. */}
      <details class="more">
        <summary>Shared this link by mistake?</summary>
        <form method="post" action={`/c/status/${app.statusToken}/new-link`} class="card">
          <p>Get a new link and this one stops working. We email the new link to the address on your application.</p>
          <button class="btn secondary" type="submit">Get a new link</button>
        </form>
      </details>
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
    </Layout>,
  );
});

/** Privacy requests from the candidate's own status link: verified by the link, recorded, acknowledged, tracked to a deadline. */
candidatePages.post("/c/status/:token/privacy", rateLimit(POLICIES.privacy), async (c) => {
  const container = c.get("container");
  const [app] = await container.db.select().from(applications).where(eq(applications.statusToken, c.req.param("token") ?? "")).limit(1);
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  const form = await c.req.parseBody();
  const parsed = CandidatePrivacyRequest.safeParse({ kind: form.kind, details: form.details || undefined });
  if (!parsed.success) return c.redirect(`/c/status/${app.statusToken}`);
  const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [company] = await container.db.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const actor = { kind: "candidate" as const, id: app.candidateId };
  // Trust boundary: everything below comes from the application the token names. The form supplies only the kind and the
  // candidate's words; any other field is ignored. A repeat of the same request within a day answers the earlier record
  // instead of opening another.
  const row = await withPlatform(container.db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${app.id}))`).catch(() => undefined); // two clicks in flight become one request
    const since = new Date(container.engine.clock().getTime() - 24 * 3600_000).toISOString();
    const recent = await tx.select().from(dataRequests).where(and(eq(dataRequests.applicationId, app.id), eq(dataRequests.kind, parsed.data.kind), eq(dataRequests.channel, "status_page"), inArray(dataRequests.status, ["received", "in_progress", "awaiting_counsel"]))).orderBy(desc(dataRequests.createdAt)).limit(5);
    const same = recent.find((x) => (x.details ?? "") === (parsed.data.details ?? "") && Date.parse(x.createdAt) >= Date.parse(since));
    if (same) {
      await audit(tx, { companyId: app.companyId, actor, action: "data_request.replayed", target: { type: "candidate", id: app.candidateId }, reason: parsed.data.kind, details: { requestId: same.id } });
      return same;
    }
    let r = await createDataRequest(tx, { companyId: app.companyId, kind: parsed.data.kind, requesterEmail: cand?.email ?? `unknown+${app.candidateId}@example.invalid`, details: parsed.data.details, candidateId: app.candidateId, applicationId: app.id, channel: "status_page", verified: true, actor, now: container.engine.clock() });
    if (parsed.data.kind === "human_review") r = await openHumanReview(tx, r, { actor });
    await sendPrivacyAcknowledgment(tx, container.integrations, { row: r, companyName: company?.name ?? "the hiring team", privacyEmail: container.env.PRIVACY_EMAIL, actor });
    return r;
  });
  await container.kick();
  return c.redirect(`/c/status/${app.statusToken}?request=${row.id.slice(0, 8)}`);
});

/**
 * "Withdraw my application": anyone still in the process may withdraw, and so may someone whose decision they were never
 * told. Their AI interview closes with it, the team gets one update, and the withdrawal is also a recorded request,
 * fulfilled at once, so the audit trail and the confirmation are the same as for any other request.
 */
candidatePages.post("/c/status/:token/withdraw", rateLimit(POLICIES.withdraw), async (c) => {
  const container = c.get("container");
  const [app] = await container.db.select().from(applications).where(eq(applications.statusToken, c.req.param("token") ?? "")).limit(1);
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  const body = await c.req.parseBody();
  if (body.confirm !== "yes") return c.redirect(`/c/status/${app.statusToken}?confirm=withdraw`);
  if (await withTenant(container.db, app.companyId, (tx) => withdrawApplication(tx, container, { applicationId: app.id, via: "status_page" }))) {
    await recordWithdrawal(container, app, "status_page");
    await container.kick();
  }
  return c.redirect(`/c/status/${app.statusToken}?withdrawn=1`);
});

/**
 * "Get a new link": the status link is replaced by a new random one and this one stops working. The
 * new link goes by email to the address on file, never to this page: whoever pressed may be someone the link was
 * forwarded to. The answer is a page of its own, since the address it was pressed from no longer opens anything.
 */
candidatePages.post("/c/status/:token/new-link", rateLimit(POLICIES.withdraw), async (c) => {
  const container = c.get("container");
  // The token is looked up before any company is known: a platform read, not a raw query on the connection.
  const [app] = await withPlatform(container.db, (tx) => tx.select().from(applications).where(eq(applications.statusToken, c.req.param("token") ?? "")).limit(1));
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  const out = await rotateStatusLink(container, app.id, app.companyId);
  await container.kick();
  c.header("Cache-Control", "no-store");
  return c.html(
    <Layout title="Check your email" extraCss={CARD_PAGE_CSS}>
      <h1>Your new link is on its way</h1>
      <div class="card" role="status">
        <p><strong>The link you used no longer works.</strong></p>
        <p>{out.emailedTo ? `We emailed a new link to ${maskEmail(out.emailedTo)}. It can take a few minutes; look in your spam folder too.` : "We have no email address for this application, so reply to any of our emails and a person will send you a new link."}</p>
      </div>
      <p class="foot"><a href="/c/link-request">Lost the email? Get your link again</a> · <a href="/privacy">How we handle your information</a></p>
    </Layout>,
  );
});
