/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { CandidatePrivacyRequest, CandidateSmsPreference, isCompanyVerified, type ApplicationStage, type CandidateScoreRow, type CandidateStep, type DecisionWording, type RolePacket } from "@ros/contracts";
import { newTimesDayWords, sendPrivacyAcknowledgment } from "@ros/agents";
import { DECISION_STAGES, audit, candidateNewTimesPromise, candidateStep, createDataRequest, decisionTold, emit, fulfilSmsOptOut, mayWithdraw, notify, openFollowUpOf, openHumanReview, transition, type NewTimesPromise } from "@ros/core";
import { applications, candidates, communications, companies, dataRequests, events, interviewFollowups, interviews, rolePackets, roles, screens, withPlatform, withTenant, workflowRuns, type Tx } from "@ros/db";
import type { Vars } from "../middleware/session";
import type { Container } from "../container";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { OTHER_APPLICATION_LABEL, otherApplicationsFor, packetOf, recordScoreFor, screensOf, sentAnswersFor, type OtherApplication, type RecordScore, type SentAnswers } from "../services/application-record";
import { queueLinkRequest, recordWithdrawal, rotateStatusLink } from "../services/applications";
import { exitCleanup } from "../services/exit-cleanup";
import { learnedFactsFor } from "../services/profile-facts";
import { optBackIntoTalentPool, optOutOfTalentPool } from "../services/talent-pool";
import { CORRECTION_LINE, anonymizedFor, linkGone, maskEmail } from "./candidate-shared";
import { Icon } from "./icons";
import { JobFacts } from "./job-facts";
import { Layout } from "./layout";
import { LearnedFactsSection } from "./profile-pages";
import { MessageThread, THREAD_CSS, threadOf, toldWording } from "./thread";
import { forTheWeb } from "./web-wording";

/**
 * The candidate's application record (Wave S7, S7-0: moved as it was from pages/candidate.tsx): "Lost your link?", the
 * status page at /c/status/:token, and everything its forms do (privacy requests, withdrawing, a new link, texts, future
 * roles). Mounted on the candidate pages by pages/candidate.tsx.
 */
const candidatePages = new Hono<Vars>();
export { candidatePages as recordPages };

/* ------------------------------------------------------------------------------------------------------------ */
/* "Lost your link?" (Wave 0 item 0.1): the status link goes again to the address on file, never to the page.   */
/* ------------------------------------------------------------------------------------------------------------ */

/** The form's one field, checked here (the shared contracts stay as they are in this wave). */
const LinkRequestForm = z.object({ email: z.email().max(254) });

function LinkRequestPage(props: { error?: string; email?: string }) {
  return (
    <Layout title="Get your application link again">
      <p class="eyebrow">Your application</p>
      <h1>Lost your link?</h1>
      <p class="lead">Type the email address you applied with. If we have an application from it, we email your link there, never to this page.</p>
      {props.error ? <div class="err" role="alert">{props.error}</div> : null}
      <form method="post" action="/c/link-request" class="card">
        <div style="position:absolute;left:-10000px" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" type="text" tabindex={-1} autocomplete="off" /></div>
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
    <Layout title="Check your email">
      <p class="eyebrow">Your application</p>
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
 * The progress line the status page leads with (Wave S2, slice K4; Kanvis-like): a numbered circle per step joined by a
 * line, past steps filled with a tick, the current one ringed and in the ink colour (and announced as the current step).
 * Down the page on a phone, across it from 600 pixels. No motion. The messages about the application read as a
 * conversation (plan G7), in the screening conversation's look.
 */
export const STATUS_CSS = `
.track { display: grid; margin: 20px 0 8px; padding: 0; list-style: none; counter-reset: track; }
.track li { position: relative; display: flex; align-items: flex-start; gap: 12px; padding: 6px 0; color: var(--ink-3); font-size: 15px; font-weight: 600; line-height: 1.3; counter-increment: track; }
.track li > span:nth-child(2) { padding-top: 4px; }
.track li:not(:last-child)::after { content: ""; position: absolute; top: 34px; bottom: -6px; left: 13px; width: 2px; background: var(--line-2); }
.track li.done:not(:last-child)::after { background: var(--ink); }
.track .dot { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border: 2px solid var(--line-2); border-radius: 50%; background: var(--surface); font-size: 13px; font-variant-numeric: tabular-nums; }
.track .dot::before { content: counter(track); }
.track li.done .dot { border-color: var(--ink); background: var(--ink); color: var(--ground); }
.track li.done .dot::before { content: none; }
.track .dot .icon { width: 14px; height: 14px; stroke-width: 2.5; }
.track li.current .dot { border-color: var(--ink); box-shadow: 0 0 0 3px var(--surface-2); }
.track li.done, .track li.current { color: var(--ink); }
@media (min-width: 600px) {
  .track { grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); }
  .track li { flex-direction: column; align-items: center; gap: 8px; padding: 0 4px; font-size: 14px; text-align: center; }
  .track li > span:nth-child(2) { padding-top: 0; }
  .track li:not(:last-child)::after { top: 13px; bottom: auto; left: calc(50% + 14px); right: calc(-50% + 14px); width: auto; height: 2px; }
}
${THREAD_CSS}${recordCss()}`;

/**
 * The application record's own parts (Wave S7, S7-E): the pills that jump to each section, the match score with its
 * bars (native progress elements, so no inline style; the colour band from the tokens), the answers read back and the
 * other applications at the company. Tokens only, no motion. A function, so the status page's stylesheet above can
 * name it before this point in the file.
 */
function recordCss(): string {
  return `
.jump { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 20px; padding: 0; list-style: none; }
.jump a { display: inline-block; padding: 6px 12px; border: 1px solid var(--line-2); border-radius: var(--r-pill); background: var(--surface); color: var(--ink); font-size: 14px; font-weight: 600; text-decoration: none; }
.jump a:hover { border-color: var(--line-strong); }
.score-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin: 4px 0 6px; }
.score-num { color: var(--ink); font: 700 44px/1 var(--display); font-variant-numeric: tabular-nums; }
.score-num small { margin-left: 2px; color: var(--ink-3); font-size: 18px; }
.bars { display: grid; gap: 14px; margin: 12px 0; padding: 0; list-style: none; }
.bar-head { display: flex; justify-content: space-between; gap: 12px; font-size: 15px; }
.bar-head span:last-child { flex: none; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.bars progress { display: block; width: 100%; height: 8px; margin-top: 6px; overflow: hidden; border: 0; border-radius: var(--r-pill); background: var(--surface-2); -webkit-appearance: none; appearance: none; }
.bars progress::-webkit-progress-bar { border-radius: var(--r-pill); background: var(--surface-2); }
.bars progress::-webkit-progress-value { border-radius: var(--r-pill); background: var(--accent); }
.bars progress::-moz-progress-bar { border-radius: var(--r-pill); background: var(--accent); }
.bars .partial progress::-webkit-progress-value { background: var(--caution); }
.bars .partial progress::-moz-progress-bar { background: var(--caution); }
.bars .short progress::-webkit-progress-value { background: var(--critical); }
.bars .short progress::-moz-progress-bar { background: var(--critical); }
.said { display: grid; gap: 14px; margin: 8px 0 0; padding: 0; list-style: none; }
.said-q { margin: 0 0 4px; color: var(--ink); font-weight: 600; }
.said .pre { margin: 0; }
.said-note { margin: 8px 0 0; padding-left: 12px; border-left: 3px solid var(--line-2); color: var(--ink-2); font-size: 14.5px; }
.state { display: inline-block; padding: 2px 10px; border-radius: var(--r-pill); background: var(--surface-2); color: var(--ink-2); font-size: 13px; font-weight: 600; }
.state.needs_you { background: var(--accent-soft); color: var(--accent-ink); }
.details { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 8px 0 0; }
.details dt { color: var(--ink-3); }
.details dd { margin: 0; overflow-wrap: anywhere; }
.apps { display: grid; gap: 10px; margin: 8px 0 0; padding: 0; list-style: none; }
.apps li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.apps .meta { margin: 2px 0 0; }
.app-links { display: flex; flex-wrap: wrap; gap: 6px 16px; }
@media (max-width: 600px) { .details { grid-template-columns: 1fr; } .details dd { margin-bottom: 6px; } }
`;
}

/**
 * What the candidate may see of a decision (founder decision B6): a decline or a move to the talent pool shows only once
 * they were told. Until then the page stands where they last saw it: the stage the decision was made from, and the
 * date that stage began. Read off the stage history, never off marks or holds, which the candidate never sees.
 */
async function visibleStage(container: Container, app: typeof applications.$inferSelect): Promise<{ hidden: boolean; before: ApplicationStage | null; since: string }> {
  if (!DECISION_STAGES.includes(app.stage) || decisionTold(app.toldState)) return { hidden: false, before: null, since: app.stageChangedAt };
  const moves = await withTenant(container.db, app.companyId, (tx) => tx.select({ payload: events.payload, at: events.occurredAt }).from(events).where(and(eq(events.subjectType, "application"), eq(events.subjectId, app.id), eq(events.type, "application.stage_changed"))).orderBy(asc(events.id)));
  let i = moves.length - 1;
  while (i >= 0 && DECISION_STAGES.includes(moves[i].payload.to as ApplicationStage)) i -= 1;
  const before = i >= 0 ? (moves[i].payload.to as ApplicationStage) : ((moves[0]?.payload.from as ApplicationStage | undefined) ?? null);
  return { hidden: true, before, since: i >= 0 ? moves[i].at : app.createdAt };
}

/**
 * DRAFT WORDING PENDING COUNSEL (docs/spec/11-counsel-register.md item 23), except the standard decline line and the
 * plain talent-pool line, the release-1 wording. Each line restates a `DECISION_SENTENCE` wording in
 * `packages/agents/src/coordinator.ts` in the page's own words; change both together.
 *
 * A decision in the words of the message that told it (plan G6): the closing message of a closed role (Q30), a filled
 * position, a decline after an interview or on an eligibility answer. Any other approved wording, and a decision a
 * person told them themselves, read the standard way. Never a reason beyond the eligibility answer, which the candidate
 * can correct, and never before they were told (founder decision B6).
 */
function decisionLine(input: { stage: ApplicationStage; wording: DecisionWording | null; poolOptOut: boolean; companyName: string }): string {
  const { wording, poolOptOut, companyName } = input;
  if (input.stage === "talent_pool") {
    const pool = poolOptOut ? "As you asked, nobody will contact you about future openings." : "We are keeping you in mind for future openings.";
    if (wording === "role_closed") return `${companyName} has closed this position, so your application for it will not go any further. ${pool}`;
    if (wording === "position_filled") return `The position has been filled, so this role is not moving forward for you. ${pool}`;
    if (wording === "after_interview") return `Thank you for meeting the team. This role is not moving forward for you. ${pool}`;
    return `This role is not moving forward for you. ${pool}`;
  }
  const keep = poolOptOut ? "" : " We will keep you in mind for future openings unless you ask us not to.";
  if (wording === "eligibility") return `Based on your answers to the eligibility questions, this role needs something you said you do not have right now. If that has changed, or you answered in error, reply to our email and a person will take a look.${keep}`;
  if (wording === "role_closed") return `${companyName} has closed this position, so your application for it will not go any further.${keep}`;
  if (wording === "position_filled") return `The position has been filled, so your application for this role will not go any further. Thank you for applying.${keep}`;
  if (wording === "after_interview") return `Thank you for meeting the team. They have decided not to move forward with your application for this role.${keep}`;
  return poolOptOut ? "Thank you for applying. This role did not work out." : "Thank you for applying. This role did not work out, and we will keep you in mind for future openings unless you ask us not to.";
}

/**
 * What the newest interview says once it was cancelled, missed or reopened (the Cancelled column, founder decisions 1A to
 * 4A), in the candidate's words. `cancelled`: their own cancel, with what may be promised about new times
 * (`candidateNewTimesPromise`: never a decision, never times that will not come). `gettingReady`: they asked for new times
 * and they are being worked out. `lapsed`: the new times we sent passed without a pick. `noShow`: they did not come.
 * `missedByUs`: our interviewer did not come (founder decision L-12), so the page never thanks them for an interview
 * that did not happen; it says sorry and promises nothing about what comes next.
 */
type InterviewNews = { cancelled?: { promise: NewTimesPromise; day: string | null }; gettingReady?: boolean; lapsed?: boolean; noShow?: boolean; missedByUs?: boolean };

/**
 * The newest interview's news (above), read in the company's transaction. Their own cancel is matched on the interview
 * and its attempt, as the schedule pages match it, so an interview the team cancelled after reopening it never reads as
 * "You cancelled". `held`: the times of an interview carrying new times wait for the ITS check, so they are not offered
 * here yet.
 */
async function interviewNewsFor(tx: Tx, input: { iv: typeof interviews.$inferSelect; applicationId: string; closed: boolean; timeZone: string }): Promise<InterviewNews & { held: boolean }> {
  const { iv } = input;
  if (iv.status === "cancelled") {
    const [own] = await tx.select().from(interviewFollowups).where(and(eq(interviewFollowups.kind, "candidate_cancelled"), eq(interviewFollowups.interviewId, iv.id), eq(interviewFollowups.interviewAttempt, iv.attempt))).limit(1);
    if (!own) return { held: false };
    const promise = candidateNewTimesPromise(own, { applicationClosed: input.closed });
    return { held: false, cancelled: { promise, day: promise === "date" && own.autoDueAt ? newTimesDayWords(own.autoDueAt, input.timeZone) : null } };
  }
  const open = input.closed ? null : await openFollowUpOf(tx, input.applicationId);
  const noShow = (iv.status === "no_show" && iv.outcome === "no_show_candidate") || open?.kind === "candidate_no_show";
  const missedByUs = iv.status === "no_show" && iv.outcome === "no_show_interviewer";
  if (!open) return { held: false, noShow, missedByUs };
  const [slots] = iv.status === "scheduling" && open.currentInterviewId === iv.id ? await tx.select({ status: communications.status }).from(communications).where(eq(communications.idempotencyKey, `slots:${iv.id}:${iv.attempt}`)).limit(1) : [];
  const held = slots?.status === "held";
  const preparing = iv.status === "proposed" || (iv.status === "scheduling" && (!iv.offeredSlots.length || held));
  return { held, noShow, missedByUs, gettingReady: open.choice === "new_times" && preparing, lapsed: iv.status === "offer_expired" };
}

/** The line about the candidate's own cancel; null when nothing may be said beyond the standard line. */
function cancelledLine(news: InterviewNews): string | null {
  const c = news.cancelled;
  if (!c) return null;
  if (c.promise === "date" && c.day) return `You cancelled your interview and asked for new times. We will email them to you on ${c.day}, unless the team gets in touch first.`;
  if (c.promise === "date" || c.promise === "soon") return "You cancelled your interview and asked for new times. We will email them to you as soon as they are ready.";
  if (c.promise === "team") return "You cancelled your interview and asked for new times. The hiring team will be in touch about them.";
  if (c.promise === "not_interested") return "You cancelled your interview and told the team you are no longer interested. If you change your mind, reply to any of our emails. You can also withdraw your application below.";
  return null;
}

/**
 * Before the AI interview exists (20 Oct 2026, R20-5): `soon` while the résumé is being read (the link comes by email
 * within about ten minutes), `later` while the month's AI interviews are used up (Q17: it follows by email). Never said
 * for an application held on a must-have answer (E7).
 */
export type InterviewComing = "soon" | "later" | null;

/** `InterviewComing` from the AI interview's run (`screen:<id>`) while it is on and no interview exists yet; nothing for a held application. */
async function interviewComing(tx: Tx, app: { id: string; stage: string }): Promise<InterviewComing> {
  if (!["applied", "received", "eligible"].includes(app.stage)) return null;
  const [run] = await tx.select({ status: workflowRuns.status, state: workflowRuns.state, currentStep: workflowRuns.currentStep }).from(workflowRuns).where(eq(workflowRuns.idempotencyKey, `screen:${app.id}`)).limit(1);
  if (!run || ["completed", "failed", "cancelled"].includes(run.status) || run.currentStep === "after_hold") return null;
  return (run.state as { waitingForAllowance?: string }).waitingForAllowance ? "later" : "soon";
}

/** The line under the steps, in the candidate's words: what is happening now and what they can do. */
function nextLine(input: { step: CandidateStep; stage: ApplicationStage; poolOptOut: boolean; screen: { status: string } | null; interview: "booked" | "offered" | null; news?: InterviewNews; wording: DecisionWording | null; companyName: string; coming?: InterviewComing }): string {
  const { step, stage, poolOptOut } = input;
  const news = input.news ?? {};
  const coming = input.coming === "soon" ? "We are reading your application. Your AI interview link arrives by email within about 10 minutes." : input.coming === "later" ? "Your application is in. Your AI interview link follows by email as soon as it is ready." : null;
  if (step === "received") return coming ?? (stage === "applied" ? "We are confirming your application now." : "Your application is in. We are checking the basics.");
  if (step === "under_review") {
    // An interview they cancelled, or new times for it, is the newest thing that happened: it comes before an interview link.
    const cancelled = cancelledLine(news);
    if (cancelled) return cancelled;
    if (news.gettingReady) return "You asked for new times. We are getting them ready and will email them to you.";
    if (news.lapsed) return "The interview times we sent have passed. The hiring team will be in touch.";
    // The page calls it the AI interview throughout, as the progress line above does (one name for one step).
    if (input.screen?.status === "paused") return "Your AI interview is paused while we fix a problem on our end. Your answers so far are saved, and we will email you a link to finish.";
    if (input.screen) return input.screen.status === "in_progress" ? "Finish your AI interview whenever you are ready. Your answers so far are saved." : "Your next step is a short AI interview with the hiring team's AI assistant. It is waiting for you, whenever suits you.";
    if (coming) return coming;
    if (stage === "screen_complete") return "Thanks for completing the AI interview. The team is reviewing your answers.";
    return "The hiring team is reviewing your application. You will hear from them either way.";
  }
  if (step === "interview") {
    if (input.interview === "booked") return "Your interview is booked. The details are below and in your email.";
    if (input.interview === "offered") return "The team would like to interview you. Pick a time below.";
    if (news.lapsed) return "The interview times we sent have passed. The hiring team will be in touch.";
    if (news.noShow) return "The hiring team will be in touch about next steps.";
    if (news.missedByUs) return "We are sorry: the interviewer could not join your interview. The hiring team will be in touch about what happens next.";
    if (stage === "interview_complete" || stage === "debrief") return "Thanks for interviewing. The team is deciding, and you will hear from them either way.";
    return "The hiring team will be in touch about next steps.";
  }
  if (stage === "hired") return "You are on the team.";
  if (stage === "accepted" || stage === "onboarding") return "Welcome aboard.";
  // "Offer made" is a record the team keeps (founder decision Q29): the offer itself comes from them, never from this page or our emails.
  if (stage === "offer_sent" || stage === "negotiation") return "The team has made you an offer. They will go through it with you directly. If you have a question, reply to any of our emails.";
  if (stage === "declined") return "You turned down the offer. Thank you for your time with us.";
  if (stage === "withdrawn") return "You withdrew this application. Thank you for your time.";
  return decisionLine({ stage, wording: input.wording, poolOptOut, companyName: input.companyName });
}

/** The steps of the progress line the status page leads with (Wave S2, slice K4), in the candidate's words. */
export type ProgressStep = "applied" | "screening" | "review" | "interview" | "decision";
export const PROGRESS_STEP_LABEL: Record<ProgressStep, string> = { applied: "Applied", screening: "AI interview", review: "Review", interview: "Interview", decision: "Decision" };

/**
 * The progress line (Kanvis-like): Applied, AI interview, Review, Interview, Decision. It is read off the candidate's
 * step (`candidateStep`, which never shows a private decision): Received is Applied; Under review is the AI interview
 * while one is open or paused, else Review. The AI interview is a step only for an application that has, or had, one
 * (so an eligibility answer that did not match is never hinted at, E7); at the decision, the interview is a step only
 * when there was one. Every step before the current one is done.
 */
export function progressLine(input: { step: CandidateStep; hasChat: boolean; chatOpen: boolean; hadInterview: boolean }): { steps: ProgressStep[]; current: ProgressStep } {
  const current: ProgressStep = input.step === "received" ? "applied" : input.step === "under_review" ? (input.hasChat && input.chatOpen ? "screening" : "review") : input.step;
  const steps: ProgressStep[] = ["applied", ...(input.hasChat ? (["screening"] as const) : []), "review", ...(current !== "decision" || input.hadInterview ? (["interview"] as const) : []), "decision"];
  return { steps, current };
}

/**
 * Whether the AI interview is a step on the progress line: while one is open or paused, or once one really happened
 * (finished, or closed after the candidate started it). A chat they skipped ("send without the chat"), one that expired
 * unanswered, one cancelled before it started, or one handed to a person is never ticked as done (as with interviews:
 * nobody sees a tick for one that never happened).
 */
export function chatCounts(screen: { status: string; startedAt?: Date | string | null } | null | undefined, openOrPaused: boolean): boolean {
  if (!screen) return false;
  if (openOrPaused) return true;
  if (screen.status === "completed") return true;
  if (["declined_by_candidate", "human_requested"].includes(screen.status)) return false;
  return !!screen.startedAt;
}

/** A day on the status page ("Oct 14, 2026"), in the company's time zone. */
export function statusDay(at: string | Date, timeZone: string): string {
  return new Date(at).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
}

/** The progress line as the page draws it: a circle per step (a tick once done), the words, and "done" for a screen reader. */
function ProgressLine(props: { steps: ProgressStep[]; current: ProgressStep }) {
  const at = props.steps.indexOf(props.current);
  return (
    <ol class="track" aria-label="Where your application is">
      {props.steps.map((s, i) => {
        const state = i < at ? "done" : i === at ? "current" : undefined;
        return (
          <li class={state} aria-current={state === "current" ? "step" : undefined}>
            <span class="dot" aria-hidden="true">{state === "done" ? <Icon name="check" /> : null}</span>
            <span>{PROGRESS_STEP_LABEL[s]}</span>
            {state === "done" ? <span class="sr-only"> (done)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The application record (Wave S7, slice S7-E; spec-s7-apply-flow.md steps 8, 9 and 11; redesign spec C8)       */
/* ------------------------------------------------------------------------------------------------------------ */

/** The pills under the progress line that jump to each part of the record (redesign spec C8): plain links, no script. */
function JumpLinks(props: { items: Array<{ href: string; label: string }> }) {
  return (
    <nav aria-label="On this page">
      <ul class="jump">{props.items.map((i) => <li><a href={i.href}>{i.label}</a></li>)}</ul>
    </nav>
  );
}

/**
 * The decision as the candidate knows it (spec step 9: "later when I come back to this job posting I can see the
 * decision as well"): only once they were told or it is their own act (`candidateStep`, founder decision B6), in plain
 * words. Null before then, so nothing hints at a decision kept private.
 */
export function decisionHeadline(step: CandidateStep, stage: ApplicationStage): string | null {
  if (step === "interview") return "Interview";
  if (step !== "decision") return null;
  if (stage === "offer_sent" || stage === "negotiation") return "Offer";
  if (stage === "hired" || stage === "accepted" || stage === "onboarding") return "Hired";
  if (stage === "withdrawn") return "You withdrew";
  if (stage === "declined") return "You turned down the offer";
  return "Not moving forward";
}

function DecisionCard(props: { headline: string; since: string; messages: boolean }) {
  return (
    <section class="card" aria-labelledby="decision">
      <p class="eyebrow">Decision</p>
      <h2 id="decision">{props.headline}</h2>
      <p class="meta">Since {props.since}</p>
      {props.messages ? <p>What we wrote to you about it is under <a href="#messages">Messages about your application</a> below.</p> : null}
    </section>
  );
}

/** One bar of the breakdown: the requirement's public name, how much of it was met in words and as a bar, its colour band. */
function ScoreBar(props: { row: CandidateScoreRow }) {
  const { row } = props;
  return (
    <li class={row.tone}>
      <div class="bar-head"><span>{row.label}</span><span>{row.key === "other" ? `${row.pctMet}% met` : `${row.pctMet}% met · ${row.words}`}</span></div>
      <progress max="100" value={row.pctMet} aria-label={`${row.label}: ${row.pctMet}% met`}>{row.pctMet}%</progress>
    </li>
  );
}

/**
 * The match score after sending (founder decision S7-1; DRAFT WORDING PENDING COUNSEL, register items 1 and 21: lawyer
 * review before real candidates in NYC, IL, CA or CO). While it is worked out: "Working out your match score…", with a
 * plain "Check again" link (never a timed reload: the page holds forms a candidate may be typing in, WCAG 2.2.1). Then the number, its band and the bars: only the
 * job page's must-haves by name, every other requirement in one line; what nothing showed yet is listed as not shown,
 * never held against them. Nothing at all when ITS switched it off for the company.
 */
function ScoreSection(props: { score: RecordScore; companyName: string; chatSent: boolean; statusPath: string }) {
  const { score } = props;
  if (score.state === "off") return null;
  if (score.state === "reviewing") {
    return (
      <section class="card" id="score" aria-labelledby="score-h" role="status">
        <p class="eyebrow">Your match score</p>
        <h2 id="score-h">Working out your match score…</h2>
        <p>This usually takes under a minute. <a href={`${props.statusPath}#score`}>Check again</a> in a moment, or come back to it later from the link in your email.</p>
      </section>
    );
  }
  if (score.state !== "ready" || !score.view) {
    return (
      <section class="card" id="score" aria-labelledby="score-h">
        <p class="eyebrow">Your match score</p>
        <h2 id="score-h">{score.state === "after_chat" ? "Shown once your AI interview is sent" : "Not ready yet"}</h2>
        <p>{score.state === "after_chat" ? "Your match score is worked out from what you send, so it shows here after your AI interview." : "Your match score shows here once it is ready."} The hiring team reads every application themselves either way.</p>
      </section>
    );
  }
  const v = score.view;
  return (
    <section class="card" id="score" aria-labelledby="score-h">
      <p class="eyebrow">Your match score is ready</p>
      <h2 id="score-h" class="score-head"><span class="score-num">{v.score}<small>/100</small></span><span>{v.bandLabel} match</span></h2>
      <p class="meta">{v.coverage}. Anything the team could not see in what you sent is left out of the number, never held against you.</p>
      {v.capped ? <p>What you sent shows a must-have from the job page as not met, so the score stays below 55 however much else is shown.</p> : null}
      <h3>How it breaks down</h3>
      <ul class="bars">
        {v.rows.map((row) => <ScoreBar row={row} />)}
        {v.other ? <ScoreBar row={v.other} /> : null}
      </ul>
      {v.notYetShown.length ? <p><strong>Not shown yet:</strong> {v.notYetShown.join("; ")}. Nothing you sent says either way, so these are left out.</p> : null}
      <p>The hiring team at {props.companyName} sees this score with your application{props.chatSent ? " and your chat" : ""}.</p>
      <p class="meta">The team sees what you sent; their private notes are never shared with you. A person makes every decision: the score never decides anything on its own.</p>
    </section>
  );
}

/** "Changed by you", "Skipped", "Not answered": how an answer came to be, beside it. */
const SENT_MARK: Record<"skipped" | "changed" | "not_given", string> = { skipped: "Skipped", changed: "Changed by you", not_given: "Not answered" };

/**
 * "Your answers" (founder decision S7-2): exactly what the candidate sent, read only. Their details on file, the
 * company's questions from the form in the one wording every reader uses, and the chat they sent: each question with
 * its answer (the written-up one, in their words, when there is one) and, apart and labelled, the assistant's note;
 * the whole chat word for word one click away. Never an answer they did not send, never the team's notes.
 */
function AnswersSection(props: { sent: SentAnswers; companyName: string; timeZone: string; details: { email: string | null; location: string | null; workSummary: string | null; resume: boolean } }) {
  const { sent, details } = props;
  return (
    <section id="answers" aria-labelledby="answers-h">
      <h2 id="answers-h">Your answers</h2>
      <p class="meta">What you sent to {props.companyName}, as they read it. {CORRECTION_LINE}</p>
      <div class="card">
        <h3>Your details</h3>
        <dl class="details">
          {details.email ? <><dt>Email</dt><dd>{maskEmail(details.email)}</dd></> : null}
          {details.location ? <><dt>Where you are</dt><dd>{details.location}</dd></> : null}
          {details.workSummary ? <><dt>Your work</dt><dd>{details.workSummary}</dd></> : null}
          <dt>Sent with it</dt><dd>{details.resume ? "Your resume" : "Your own words about your work, instead of a resume"}</dd>
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
          <h3>From your chat</h3>
          {sent.chat.sentAt ? <p class="meta">Sent {statusDay(sent.chat.sentAt, props.timeZone)}</p> : null}
          <ol class="said">
            {sent.chat.answers.map((a, i) => (
              <li>
                <p class="said-q">{i + 1}. {a.question}</p>
                {a.mark ? <p><span class="state">{SENT_MARK[a.mark]}</span></p> : null}
                <p class="pre">{a.answer ?? (a.mark === "skipped" ? "You skipped this question." : "No answer was given.")}</p>
                {a.note ? <p class="said-note"><strong>Note from the assistant:</strong> {a.note}</p> : null}
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

/** "The job" (redesign spec C8): the job as it was when they applied, what the team looks for, and its page while it is public. */
function JobSection(props: { packet: RolePacket; companyName: string; href: string | null }) {
  const { packet } = props;
  const mustHaves = packet.requirements.mustHaves.map((m) => m.text.trim()).filter(Boolean);
  return (
    <section class="card" id="job" aria-labelledby="job-h">
      <h2 id="job-h">The job</h2>
      <p><strong>{packet.identity.title}</strong> at {props.companyName}</p>
      <JobFacts packet={packet} pay="" small schedule={false} />
      {mustHaves.length ? <><h3>What the team is looking for</h3><ul>{mustHaves.map((t) => <li>{t}</li>)}</ul></> : null}
      {props.href ? <p><a href={props.href}>See the job page</a></p> : null}
    </section>
  );
}

/**
 * "Your applications at <Company>" (spec step 11; D-01 revised: per company, never across companies): the candidate's
 * other applications here, each with a pill (Needs you, Waiting, Closed). Nothing about a decision they were not told.
 * No link to them: a forwarded link opens only its own application, so each other one opens from its own email, or from
 * "Get your links again", which emails every link to the address on file only.
 */
function OtherApplications(props: { others: OtherApplication[]; companyName: string; timeZone: string }) {
  if (!props.others.length) return null;
  return (
    <section id="applications" aria-labelledby="applications-h">
      <h2 id="applications-h">Your applications at {props.companyName}</h2>
      <p class="meta">Your other applications here. Each has its own page: open it from the email we sent you about it, or <a href="/c/link-request">get your links again</a> by email.</p>
      <ul class="apps">
        {props.others.map((o) => (
          <li class="card">
            <div>
              <strong>{o.roleTitle}</strong> <span class={`state ${o.state}`}>{OTHER_APPLICATION_LABEL[o.state]}</span>
              <p class="meta">Applied {statusDay(o.appliedAt, props.timeZone)}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The candidate's status page (plan A1). It leads with the progress line (Wave S2, slice K4) and the one line on what
 * happens next; its status card speaks in the four candidate steps (Received, Under review, Interview, Decision). Never
 * the team's stage names: the assistant's suggestions, an eligibility hold and "finalist" read as Under
 * review. A decision shows only once the candidate was told (founder decision B6), in the words of the message that
 * told it (plan G6); until then the page stands where it was and withdrawing stays open. The messages about the
 * application read as a conversation (plan G7): only messages that actually reached them, and their own replies. A line
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
  const told = !view.hidden && DECISION_STAGES.includes(app.stage);
  const { thread, wording } = await withTenant(container.db, app.companyId, async (tx) => ({
    thread: await threadOf(tx, app.id),
    wording: told ? await toldWording(tx, { applicationId: app.id, decidedAt: app.stageChangedAt }) : null,
  }));
  // Nothing about a private decision shows, and nothing it closed is offered (its screens and interviews were cancelled with it).
  // A conversation paused while the assistant is down (plan E5) is mentioned, without a link: an email brings it back.
  // Whether there ever was one only decides whether the progress line has an AI interview step, the same before and after a private decision.
  const lastScreen = (await db.select().from(screens).where(eq(screens.applicationId, app.id)).orderBy(desc(screens.createdAt)).limit(1))[0];
  const latestScreen = view.hidden ? undefined : lastScreen;
  const openScreen_ = latestScreen && ["invited", "reminded", "in_progress"].includes(latestScreen.status) ? latestScreen : undefined;
  const pausedScreen = latestScreen?.status === "paused" ? latestScreen : undefined;
  const iv = view.hidden ? undefined : (await db.select().from(interviews).where(eq(interviews.applicationId, app.id)).orderBy(desc(interviews.createdAt)).limit(1))[0];
  const ivTz = iv?.schedulingWindow.candidateTimezone ?? cand?.location?.timezone ?? company?.timezone ?? "America/Los_Angeles";
  const closed = ["hired", "withdrawn", "rejected", "declined", "talent_pool"].includes(app.stage) || ["closed", "filled"].includes(role?.status ?? "");
  const news = iv ? await withTenant(container.db, app.companyId, (tx) => interviewNewsFor(tx, { iv, applicationId: app.id, closed, timeZone: ivTz })) : { held: false };
  // New times whose email waits for the ITS check (founder decision B7) are not offered here either: the times are not out yet.
  const offered = !!iv && iv.status === "scheduling" && !!iv.scheduleToken && iv.offeredSlots.length > 0 && !news.held;
  const booked = !!iv && iv.status === "scheduled" && !!iv.startsAt && !!iv.scheduleToken && Date.parse(iv.endsAt ?? iv.startsAt) > Date.now();
  // What to prepare (D15): the purpose of the booked round, from the packet version this application runs on.
  const prepare = booked ? await withTenant(container.db, app.companyId, async (tx) => (await tx.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1))[0]?.packet.interviews.plan.find((r) => r.key === iv!.roundKey)?.purpose ?? null) : null;
  const smsEnabled = container.env.SMS_ENABLED;
  const smsOn = !!cand?.consent.sms?.granted && !cand?.preferences.smsOptOut;
  const poolOptOut = !!cand?.preferences.talentPoolOptOut;
  const shownStage = view.hidden ? view.before ?? "triaged" : app.stage;
  // Times a person approved and offered are an interview to the candidate, whatever the team's own stage says.
  const baseStep = candidateStep(app.stage, app.toldState, view.before);
  const step: CandidateStep = baseStep === "under_review" && (offered || booked) ? "interview" : baseStep;
  // An interview counts on the line once times were offered to them or one was booked, never one still waiting for approval.
  const invitedToInterview = (!!iv && iv.status !== "proposed" && (!!iv.startsAt || iv.offeredSlots.length > 0)) || wording === "after_interview";
  // A private decision cancels an open chat: the line keeps its step as it was, so nothing hints at the decision.
  const chatStep = chatCounts(lastScreen, !!(openScreen_ ?? pausedScreen) || (view.hidden && lastScreen?.status === "cancelled"));
  const progress = progressLine({ step, hasChat: chatStep, chatOpen: !!(openScreen_ ?? pausedScreen), hadInterview: invitedToInterview });
  // The AI interview still being prepared (20 Oct 2026): its run waits for the reading, or for more interviews (Q17).
  const coming = !lastScreen && !view.hidden ? await withTenant(container.db, app.companyId, (tx) => interviewComing(tx, app)) : null;
  // "Don't keep me for future roles", from the decision message's link (#future-roles) or the button: it says it was saved.
  const pool = c.req.query("pool");
  const poolSaved = (pool === "out" && poolOptOut) || (pool === "in" && !poolOptOut);
  // Dates on the page are the company's days, never the server's (known-bugs row 73).
  const companyZone = company?.timezone ?? "America/Los_Angeles";
  // The record's own parts (Wave S7, S7-E): the score, what they sent, the job, their other applications here, and what
  // their sent chats taught their record. All read in the company's transaction, from what the team may see.
  const companyName = company?.name ?? "the company";
  const record = await withTenant(container.db, app.companyId, async (tx) => {
    const all = await screensOf(tx, app.id);
    const packet = await packetOf(tx, app.roleId, app.packetVersion);
    return {
      packet,
      score: await recordScoreFor(tx, { app, companySettings: company?.settings, screens: all, hiddenDecision: view.hidden, now: container.engine.clock() }),
      sent: sentAnswersFor({ app, packet, screens: all }),
      others: await otherApplicationsFor(tx, { companyId: app.companyId, candidateId: app.candidateId, exceptId: app.id }),
      facts: await learnedFactsFor(tx, { companyId: app.companyId, candidateId: app.candidateId }),
    };
  });
  const decision = decisionHeadline(step, shownStage);
  const jobHref = company && role && isCompanyVerified(company.settings) && role.currentPacketVersion && role.status !== "draft" ? `/careers/${company.slug}/jobs/${role.id}` : null;
  const jump = [
    ...(record.score.state !== "off" ? [{ href: "#score", label: "Your match score" }] : []),
    { href: "#answers", label: "Your answers" },
    { href: "#learned", label: "What your chats added" },
    ...(record.packet ? [{ href: "#job", label: "The job" }] : []),
    ...(record.others.length ? [{ href: "#applications", label: `Your applications at ${companyName}` }] : []),
    { href: "#choices", label: "Your choices" },
    ...(thread.messages.length ? [{ href: "#messages", label: "Messages" }] : []),
    { href: "#help", label: "Help" },
  ];
  return c.html(
    <Layout title={`Your application at ${company?.name ?? ""}`} extraCss={STATUS_CSS}>
      <p class="eyebrow">{company?.name ? `${company.name} · ` : ""}Your application</p>
      <h1>{role?.title}</h1>
      <ProgressLine steps={progress.steps} current={progress.current} />
      <JumpLinks items={jump} />
      {/* Where things stand, then the one thing to do now (founder brief, 14 October 2026): the line, and the button or card. */}
      <h2>What happens next</h2>
      <p>{nextLine({ step, stage: shownStage, poolOptOut, screen: openScreen_ ?? pausedScreen ?? null, interview: booked ? "booked" : offered ? "offered" : null, news, wording, companyName: company?.name ?? "The company", coming })}</p>
      {/* The choice the decision message points to (Q30), one click away from the decision itself. */}
      {told && !poolOptOut ? <p>Would you rather we did not keep your details for future roles? <a href="#future-roles">Say so below</a>; it takes one click.</p> : null}
      {openScreen_ ? <a class="btn" href={`/c/screen/${openScreen_.token}`}>{openScreen_.status === "in_progress" ? "Continue your AI interview" : "Start your AI interview"}</a> : null}
      {offered ? <div class="card"><strong>Pick a time for your {iv!.title.toLowerCase()}.</strong><p>{company?.name} would like to interview you.</p><a class="btn" href={`/c/schedule/${iv!.scheduleToken}`}><Icon name="calendar" />Choose a time</a></div> : null}
      {booked ? <div class="card"><strong>Your interview: {iv!.title}</strong><p>{new Intl.DateTimeFormat("en-US", { timeZone: ivTz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iv!.startsAt!))}{iv!.meetingUrl ? <span> · <a href={iv!.meetingUrl}>Join link</a></span> : null}</p>{prepare ? <p><strong>What to prepare:</strong> {prepare} Bring examples from your own work, and any questions you have for the team.</p> : null}<p><a href={`/c/schedule/${iv!.scheduleToken}/confirmed`}>Details, calendar file, reschedule or cancel</a></p></div> : null}
      {c.req.query("withdrawn") === "1" ? <div class="card" role="status"><strong>Your application is withdrawn.</strong><p>Thank you for your time. If you have a question, reply to any of our emails.</p></div> : null}
      {/* One line that people decide; how the AI helps is one click away. */}
      <p class="meta">People on the hiring team at {company?.name ?? "the company"} make every decision about your application.</p>
      <details class="more">
        <summary>How AI is used</summary>
        <p class="meta">An AI assistant reads applications and runs the AI interview for them; who is interviewed, hired or turned down is always a person's decision.</p>
      </details>
      <div class="card status">
        {/* The same name for where they are as the progress line above: one vocabulary on the page. */}
        <div><span>Status</span><strong>{PROGRESS_STEP_LABEL[progress.current]}</strong></div>
        <div><span>Applied</span><span>{statusDay(app.createdAt, companyZone)}</span></div>
        <div><span>Last update</span><span>{statusDay(view.since, companyZone)}</span></div>
      </div>
      {decision ? <DecisionCard headline={decision} since={statusDay(view.since, companyZone)} messages={thread.messages.length > 0} /> : null}
      <ScoreSection score={record.score} companyName={companyName} chatSent={!!record.sent.chat} statusPath={`/c/status/${app.statusToken}`} />
      <AnswersSection sent={record.sent} companyName={companyName} timeZone={companyZone} details={{ email: cand?.email ?? null, location: cand?.locationText ?? null, workSummary: app.answers.workSummary ?? null, resume: !!app.resumeDocumentId }} />
      <LearnedFactsSection facts={record.facts} statusToken={app.statusToken} companyName={companyName} timeZone={cand?.location?.timezone ?? companyZone} saved={c.req.query("facts") ?? null} />
      {record.packet ? <JobSection packet={record.packet} companyName={companyName} href={jobHref} /> : null}
      <OtherApplications others={record.others} companyName={companyName} timeZone={companyZone} />
      <h2 id="choices">Your choices</h2>
      {smsEnabled || smsOn ? (
        <div class="card">
          <p><strong>Text messages:</strong> {smsOn ? "on" : "off"}. {cand?.phone || !smsEnabled ? "" : "Add a mobile number by replying to our email to receive texts."}</p>
          {cand?.phone && (smsOn || smsEnabled) ? (
            <form method="post" action={`/c/status/${app.statusToken}/sms`}>
              <input type="hidden" name="pref" value={smsOn ? "off" : "on"} />
              <button class="btn secondary" type="submit">{smsOn ? "Stop text messages" : "Allow text messages"}</button>
            </form>
          ) : null}
        </div>
      ) : null}
      {/* Open to anyone still in the process, and to anyone whose decision they have not been told (plan A1). One click
          away (founder brief, 14 October 2026); open when a send without the confirmation box came back (?confirm=withdraw). */}
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
      {/* Wave 0 item 0.11: the talent-pool choice is one click either way, and it only ever affects future roles. The
          decision and closing messages link straight here (#future-roles, Q30). */}
      {poolOptOut ? (
        <form method="post" action={`/c/status/${app.statusToken}/talent-pool`} class="card" id="future-roles">
          {poolSaved ? <p role="status"><strong>Saved.</strong></p> : null}
          <p><strong>Future roles:</strong> you asked us not to keep your details for future roles, so nobody will contact you about other openings at {company?.name}.</p>
          <input type="hidden" name="pref" value="in" />
          <button class="btn secondary" type="submit">Keep me for future roles again</button>
        </form>
      ) : (
        <form method="post" action={`/c/status/${app.statusToken}/talent-pool`} class="card" id="future-roles">
          {poolSaved ? <p role="status"><strong>Saved.</strong></p> : null}
          <p><strong>Future roles:</strong> {company?.name} may keep your details to tell you about other openings later. This does not change your current application.</p>
          <button class="btn secondary" type="submit">Don't keep me for future roles</button>
        </form>
      )}
      <MessageThread messages={thread.messages} more={thread.more} companyName={company?.name ?? "The hiring team"} timeZone={cand?.location?.timezone ?? company?.timezone ?? "America/Los_Angeles"} />
      <h2 id="help">Need something?</h2>
      <p>Reply to any of our emails with HUMAN to reach a person, or make a request below.</p>
      {c.req.query("request") ? <div class="card" role="status"><strong>We have your request.</strong><p>A confirmation with the completion date is on its way to {cand?.email ?? "your email"}. Reference {c.req.query("request")}.</p></div> : null}
      {/* Requests about their information, and a review by a person, one click away (founder brief, 14 October 2026). */}
      <details class="more">
        <summary>Ask for a copy, a fix, deletion, or a person's review</summary>
        <p>To request, correct, or delete your information you can also email <a href={`mailto:${c.get("container").env.PRIVACY_EMAIL}`}>{c.get("container").env.PRIVACY_EMAIL}</a>; see <a href="/privacy">how we handle your information</a>.</p>
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
      {/* Known-bugs row 48: a link shared by mistake can be replaced; the new one goes only to the email on file. */}
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

/* ------------------------------------------------------------------------------------------------------------ */
/* Candidate self-service (docs/FOUNDER-CONTEXT.md §12): withdraw in one click; text-message preference.        */
/* ------------------------------------------------------------------------------------------------------------ */

/** Privacy requests from the candidate's own status link (correction 7): verified by the link, recorded, acknowledged, tracked to a deadline. */
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
  // Trust boundary (docs/readiness/14): everything below comes from the application the token names. The form supplies only
  // the kind and the candidate's words; any other field is ignored. A repeat of the same request within a day answers the
  // earlier record instead of opening another (replays are idempotent).
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
    if (parsed.data.kind === "human_review") r = await openHumanReview(tx, r, { roleId: app.roleId, actor });
    await sendPrivacyAcknowledgment(tx, container.integrations, { row: r, companyName: company?.name ?? "the hiring team", privacyEmail: container.env.PRIVACY_EMAIL, actor });
    return r;
  });
  await container.kick();
  return c.redirect(`/c/status/${app.statusToken}?request=${row.id.slice(0, 8)}`);
});

candidatePages.post("/c/status/:token/withdraw", rateLimit(POLICIES.withdraw), async (c) => {
  const container = c.get("container");
  const [app] = await container.db.select().from(applications).where(eq(applications.statusToken, c.req.param("token") ?? "")).limit(1);
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  const body = await c.req.parseBody();
  if (body.confirm !== "yes") return c.redirect(`/c/status/${app.statusToken}?confirm=withdraw`);
  // Anyone still in the process may withdraw, and so may someone whose decision they were never told: for them nothing
  // has been decided yet (plan A1). Leaving cleans up: their screens close, and an interview they knew about is called
  // off with a short note confirming it (plan A9).
  if (mayWithdraw(app.stage, app.toldState)) {
    await withTenant(container.db, app.companyId, async (tx) => {
      const actor = { kind: "candidate" as const, id: app.candidateId };
      await transition(tx, { applicationId: app.id, companyId: app.companyId, to: "withdrawn", by: "candidate", actor, reason: "withdrawn from the status page" });
      await emit(tx, { type: "application.withdrawn", companyId: app.companyId, actor, subject: { type: "application", id: app.id }, payload: { via: "status_page", fromStage: app.stage } });
      await exitCleanup(tx, container, { companyId: app.companyId, applicationId: app.id, reason: "the candidate withdrew", actor, candidateEmail: "send_cancellation" });
      const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
      const [role] = await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
      await notify(tx, { companyId: app.companyId, kind: "candidate.withdrawn", title: `${cand.firstName} ${cand.lastName} withdrew`, body: `They withdrew from ${role.title} using the link on their status page.`, action: { label: "See talent", href: `/roles/${app.roleId}/talent?open=${app.id}` } });
    });
    // the withdrawal is also a recorded request, fulfilled at once, so the audit trail and the confirmation are the same as for any other request
    await recordWithdrawal(container, app, "status_page");
    await container.kick();
  }
  return c.redirect(`/c/status/${app.statusToken}?withdrawn=1`);
});

/**
 * "Get a new link" (known-bugs row 48): the status link is replaced by a new random one and this one stops working. The
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
    <Layout title="Check your email">
      <p class="eyebrow">Your application</p>
      <h1>Your new link is on its way</h1>
      <div class="card" role="status">
        <p><strong>The link you used no longer works.</strong></p>
        <p>{out.emailedTo ? `We emailed a new link to ${maskEmail(out.emailedTo)}. It can take a few minutes; look in your spam folder too.` : "We have no email address for this application, so reply to any of our emails and a person will send you a new link."}</p>
      </div>
      <p class="foot"><a href="/c/link-request">Lost the email? Get your link again</a> · <a href="/privacy">How we handle your information</a></p>
    </Layout>,
  );
});

candidatePages.post("/c/status/:token/sms", rateLimit(POLICIES.smsPref), async (c) => {
  const container = c.get("container");
  const [app] = await container.db.select().from(applications).where(eq(applications.statusToken, c.req.param("token") ?? "")).limit(1);
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  const body = await c.req.parseBody();
  const parsed = CandidateSmsPreference.safeParse({ pref: typeof body.pref === "string" ? body.pref : "" });
  if (!parsed.success) return c.redirect(`/c/status/${app.statusToken}`);
  const on = parsed.data.pref === "on";
  if (on && !container.env.SMS_ENABLED) return c.redirect(`/c/status/${app.statusToken}`); // texting is off (decision M2): nothing to opt in to
  const [current] = await container.db.select({ preferences: candidates.preferences, consent: candidates.consent }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const currentlyOn = !!current?.consent.sms?.granted && !current?.preferences.smsOptOut;
  if (currentlyOn === on) return c.redirect(`/c/status/${app.statusToken}`); // already so: a repeat changes and records nothing
  await withTenant(container.db, app.companyId, async (tx) => {
    const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
    const actor = { kind: "candidate" as const, id: cand.id };
    const now = new Date().toISOString();
    await tx.update(candidates).set({ preferences: { ...cand.preferences, smsOptOut: !on }, consent: { ...cand.consent, sms: { granted: on, at: now, source: "status_page" } } }).where(eq(candidates.id, cand.id));
    await emit(tx, { type: on ? "consent.granted" : "consent.revoked", companyId: app.companyId, actor, subject: { type: "candidate", id: cand.id }, payload: { purpose: "sms", source: "status_page" } });
  });
  if (!on) {
    // an opt-out is a recorded request too: applied at once, confirmed, kept for the audit trail
    await withPlatform(container.db, async (tx) => {
      const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
      const actor = { kind: "candidate" as const, id: app.candidateId };
      const req = await createDataRequest(tx, { companyId: app.companyId, kind: "sms_opt_out", requesterEmail: cand?.email ?? `unknown+${app.candidateId}@example.invalid`, candidateId: app.candidateId, applicationId: app.id, channel: "status_page", verified: true, actor, now: container.engine.clock() });
      await fulfilSmsOptOut(tx, req, actor, container.engine.clock());
    });
  }
  return c.redirect(`/c/status/${app.statusToken}`);
});

/**
 * "Don't keep me for future roles" (Wave 0 item 0.11): one click on the status link, confirmed by email; a repeat
 * changes nothing. `pref=in` ("Keep me for future roles again") takes the choice back, with nothing sent. Either way the
 * page comes back at the choice, saying it was saved.
 */
candidatePages.post("/c/status/:token/talent-pool", rateLimit(POLICIES.talentPoolPref), async (c) => {
  const container = c.get("container");
  const [app] = await container.db.select().from(applications).where(eq(applications.statusToken, c.req.param("token") ?? "")).limit(1);
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const back = body.pref === "in";
  if (back) await withTenant(container.db, app.companyId, (tx) => optBackIntoTalentPool(tx, { application: app }));
  else if (await withTenant(container.db, app.companyId, (tx) => optOutOfTalentPool(tx, container, { application: app, source: "status_page" }))) await container.kick();
  return c.redirect(`/c/status/${app.statusToken}?pool=${back ? "in" : "out"}#future-roles`);
});
