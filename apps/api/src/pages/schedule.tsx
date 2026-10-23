/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { CandidateAvailability, CandidateCancel, SelectSlot, type CancelNext } from "@ros/contracts";
import { CANCEL_STAGES, candidateNewTimesPromise, emit, formatInZone, freshSchedulingWindow, groupSlotsByDay, notify, openFollowUp, slotStillAhead, transition, type FollowUpRow, type NewTimesPromise } from "@ros/core";
import { MAX_CANDIDATE_RESCHEDULES, autoNewTimesPlan, interviewIcs, newTimesDayWords, participantsOf, sendInterviewCancelled, type AutoPlan } from "@ros/agents";
import { applications, candidates, communications, companies, interviewFollowups, interviews, jobs, rolePackets, roles, withTenant, type Db, type Tx } from "@ros/db";
import { armNewTimes } from "@ros/workflows";
import type { Vars } from "../middleware/session";
import { bookPickNow, routePick } from "../routes/interviews";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { Icon } from "./icons";
import { Layout } from "./layout";

/**
 * The candidate's scheduling pages (docs/04 §candidate; slice 5 step 9): pick a time in your own zone, say none work,
 * see the confirmation, download the invitation, reschedule (twice), cancel. Server-rendered, no JavaScript, keyboard
 * and screen-reader friendly. Reached only through the single-use token in the candidate's email.
 *
 * Cancelling asks what they would like next (founder decision 2A): new times later, or no longer interested. Either way
 * they go under Cancelled on the team's side (1A). Someone who asks for new times gets one set automatically after the
 * company's working days (3A) when nothing stops it; the page says so only when it is true for them, with the day.
 */
export const schedulePages = new Hono<Vars>();

/**
 * The scheduling pages' own styles (October 2026 redesign, the form card of the reference screens), on top of the
 * candidate stylesheet: each day's times as selectable rounded tiles in a grid under the day's name (a chosen tile in
 * lavender with a plum edge), the cancel choices as full-width option cards with their hint under each, and the
 * confirmed interview as label-over-value rows with the time first and largest. Tokens only, no button rules, no
 * motion; the radios stay real radios.
 */
export const SCHEDULE_CSS = `
fieldset > legend { margin: 0 0 4px; color: var(--ink); font-size: 15px; font-weight: 600; }
fieldset > .card { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(136px, 100%), 1fr)); gap: 8px; margin: 12px 0 0; padding: 16px; }
fieldset > .card > strong { grid-column: 1 / -1; margin: 0 0 2px; color: var(--ink); font-size: 14.5px; font-weight: 600; }
.slot { display: flex; align-items: center; gap: 10px; min-height: 48px; margin: 0; padding: 12px 14px; border: 1px solid var(--line-2); border-radius: 14px; background: var(--surface); color: var(--ink); font-size: 15px; font-weight: 600; line-height: 1.3; cursor: pointer; }
.slot:has(input:checked) { border-color: var(--primary); background: var(--tint); box-shadow: inset 0 0 0 1px var(--primary); }
.slot input { flex: none; margin: 0; }
#cancel fieldset > .slot { margin: 12px 0 0; }
#cancel fieldset > small { display: block; margin: 6px 0 0 14px; color: var(--ink-2); }
div.card.status { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: 16px 24px; margin: 20px 0; padding: 20px 22px; background: var(--surface); }
.card.status > div { display: grid; align-content: start; gap: 2px; margin: 0; padding: 0; border: 0; }
.card.status > div:first-child { grid-column: 1 / -1; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.card.status > div > :first-child { color: var(--ink-2); font-size: 13px; font-weight: 400; }
.card.status > div > :last-child { min-width: 0; font-size: 15px; font-weight: 600; text-align: left; overflow-wrap: anywhere; }
.card.status > div > :last-child:not(a) { color: var(--ink); }
.card.status > div:first-child > :last-child { font-family: var(--display); font-size: 22px; font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; }
@media (hover: hover) and (pointer: fine) { .slot:hover { border-color: var(--line-strong); } }
`;

const ZONES = ["America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago", "America/New_York", "America/Anchorage", "Pacific/Honolulu"];

async function loadByToken(db: Db, token: string) {
  if (!token) return null;
  const [iv] = await db.select().from(interviews).where(eq(interviews.scheduleToken, token)).limit(1);
  if (!iv) return null;
  const [app] = await db.select().from(applications).where(eq(applications.id, iv.applicationId)).limit(1);
  const [candidate] = await db.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await db.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await db.select().from(companies).where(eq(companies.id, iv.companyId)).limit(1);
  const [pv] = await db.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  const participants = await participantsOf(db, iv.id);
  // The application left the process (declined, withdrew, hired, talent pool) or the role closed (plan A9): nothing here can be booked or changed.
  const closed = ["hired", "withdrawn", "rejected", "declined", "talent_pool"].includes(app.stage) || ["closed", "filled"].includes(role.status);
  return { iv, app, candidate, role, company, packet: pv?.packet ?? null, participants, closed, expired: !!iv.scheduleTokenExpiresAt && Date.parse(iv.scheduleTokenExpiresAt) < Date.now() };
}
type Bundle = NonNullable<Awaited<ReturnType<typeof loadByToken>>>;

function tzOf(b: Bundle, override?: string | null): string {
  const tz = override || b.iv.schedulingWindow.candidateTimezone || b.candidate.location?.timezone || b.company.timezone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return b.company.timezone; }
}
const Expired = (props: { b: Bundle }) => (
  <Layout title="This link has expired">
    <h1>This scheduling link has expired</h1>
    <p>Reply to any email from {props.b.company.name}'s hiring team and a person will send fresh times.</p>
  </Layout>
);
/**
 * The page an old link shows once the interview is off, instead of a bare "not found" (plan A9). It says what is true
 * for the candidate (there is nothing to attend or pick) and nothing about why: a decision is told by a person.
 */
const NoLongerOn = (props: { b: Bundle }) => props.b.iv.startsAt ? (
  <Layout title="Interview cancelled">
    <h1>This interview was cancelled</h1>
    <p>There is no need to attend. If you have a question, reply to any email from {props.b.company.name}'s hiring team.</p>
  </Layout>
) : (
  <Layout title="No longer available">
    <h1>These interview times are no longer available</h1>
    <p>There is nothing to pick here now. If you have a question, reply to any email from {props.b.company.name}'s hiring team.</p>
  </Layout>
);
/** Nothing can be picked, asked for or moved on an interview that is off or for someone no longer in the process. */
const isOff = (b: Bundle) => b.iv.status === "cancelled" || b.closed;

/**
 * The application's row lock, taken before the interview is changed: the order a team cancel, a booking and a send of
 * new times take them (the Cancelled column), so two changes at the same moment take turns instead of deadlocking.
 */
/** A pick that found the interview moved on while it was being written: the transaction is undone and the page shown again. */
class PickChanged extends Error {}

async function lockApplication(tx: Tx, applicationId: string): Promise<void> {
  await tx.select({ id: applications.id }).from(applications).where(eq(applications.id, applicationId)).limit(1).for("update");
}

/**
 * The candidate's own cancel of this interview (the row it wrote under Cancelled), while it is still what last happened
 * to the interview: matched on the interview and its attempt, which the cancel itself set. Anything that touched the
 * interview since (reopened for new times, then cancelled by the team) moved the attempt, so that never reads as "You
 * cancelled".
 */
async function candidateCancelOf(tx: Tx, b: Bundle): Promise<FollowUpRow | null> {
  if (b.iv.status !== "cancelled") return null;
  const [row] = await tx.select().from(interviewFollowups).where(and(eq(interviewFollowups.kind, "candidate_cancelled"), eq(interviewFollowups.interviewId, b.iv.id), eq(interviewFollowups.interviewAttempt, b.iv.attempt))).limit(1);
  return row ?? null;
}
const ownCancelOf = (db: Db, b: Bundle) => withTenant(db, b.company.id, (tx) => candidateCancelOf(tx, b));

/**
 * What a page may say about new times after the candidate's own cancel: only what will happen (founder decision B6). A
 * day while the automatic set waits for it; "as soon as they are ready" while it waits for the ITS check or is being
 * prepared; nothing about times once the application closed (a decision they were not told, a withdrawal, a closed role),
 * the row was resolved, or the team stopped the set.
 */
function promiseOf(b: Bundle, row: FollowUpRow): { promise: NewTimesPromise; day: string | null } {
  const promise = candidateNewTimesPromise(row, { applicationClosed: b.closed });
  const day = promise === "date" && row.autoDueAt ? newTimesDayWords(row.autoDueAt, tzOf(b)) : null;
  return { promise: promise === "date" && !day ? "soon" : promise, day };
}

/** An old link of an interview the candidate cancelled themselves. */
const CandidateCancelled = (props: { b: Bundle; row: FollowUpRow }) => {
  const { promise, day } = promiseOf(props.b, props.row);
  const line = promise === "date" ? `We will email you new times on ${day}, unless the team gets in touch first.`
    : promise === "soon" ? "We will email you new times as soon as they are ready."
    : promise === "team" ? "Someone from the team will be in touch about new times."
    : promise === "not_interested" ? "You told the team you are no longer interested in this interview. If you change your mind, reply to any of our emails."
    : "The hiring team will be in touch.";
  return (
    <Layout title="Interview cancelled">
      <h1>You cancelled this interview</h1>
      <p>{line}</p>
    </Layout>
  );
};

/**
 * New times for someone under Cancelled whose email is not on its way yet: the times exist, but their email waits for
 * the ITS check (founder decision B7), or is still being written. An old link then says the times are being got ready,
 * and a pick from it is not taken: the candidate was not sent those times, and the offer's clock has not started.
 */
async function newTimesNotOut(db: Db, b: Bundle): Promise<boolean> {
  if (b.iv.status !== "scheduling") return false;
  return withTenant(db, b.company.id, async (tx) => {
    const [carrying] = await tx.select({ id: interviewFollowups.id }).from(interviewFollowups).where(and(eq(interviewFollowups.currentInterviewId, b.iv.id), isNull(interviewFollowups.resolvedAt))).limit(1);
    if (!carrying) return false;
    const [slots] = await tx.select({ status: communications.status }).from(communications).where(eq(communications.idempotencyKey, `slots:${b.iv.id}:${b.iv.attempt}`)).limit(1);
    return !slots || slots.status === "held";
  });
}

/** A reopened interview whose new times are still being worked out: the link is fine, the times are not there yet. */
const TimesBeingReady = (props: { b: Bundle }) => (
  <Layout title="New times are on the way">
    <h1>We are getting new times ready</h1>
    <p>We will email you as soon as there are times to pick from. If you have a question, reply to any email from {props.b.company.name}'s hiring team.</p>
  </Layout>
);

/** The sentence under "Send me new times later": what will happen for this candidate now, with the day when there is one. */
function newTimesHint(plan: AutoPlan, b: Bundle): string {
  if (plan.arm) return `We will email you new times on ${newTimesDayWords(plan.dueAt, tzOf(b))}, unless the team gets in touch first.`;
  if (plan.reason === "reschedules_used") return "You have moved this interview twice, so someone from the team will be in touch to arrange a time.";
  return "Someone from the team will be in touch about new times.";
}

schedulePages.get("/c/schedule/:token", async (c) => {
  const container = c.get("container");
  const b = await loadByToken(container.db, c.req.param("token") ?? "");
  if (!b) return c.notFound();
  if (b.iv.status === "scheduled") return c.redirect(`/c/schedule/${b.iv.scheduleToken}/confirmed`);
  if (isOff(b)) {
    const own = await ownCancelOf(container.db, b);
    return c.html(own ? <CandidateCancelled b={b} row={own} /> : <NoLongerOn b={b} />, 410);
  }
  // New times being prepared (reopened, nothing offered yet), or in an email still waiting to leave: not an expired link.
  if (b.iv.status === "scheduling" && !b.expired && (!b.iv.offeredSlots.length || (await newTimesNotOut(container.db, b)))) return c.html(<TimesBeingReady b={b} />);
  if (b.expired || !["scheduling"].includes(b.iv.status) || !b.iv.offeredSlots.length) return c.html(<Expired b={b} />, 410);
  // Times that have passed (or start within the hour) are never offered: an old set left on the interview shows only
  // what can still be booked; with none left the times are as good as expired.
  const ahead = b.iv.offeredSlots.filter((s) => slotStillAhead(s, container.engine.clock()));
  if (!ahead.length) return c.html(<Expired b={b} />, 410);
  const tz = tzOf(b, c.req.query("tz"));
  const groups = groupSlotsByDay(ahead, tz);
  const error = c.req.query("error");
  return c.html(
    <Layout title={`Pick a time: ${b.iv.title} at ${b.company.name}`} extraCss={SCHEDULE_CSS}>
      {/* Kept through the fewer-words pass (23 October 2026): the only words on the page that say which employer and job this is. */}
      <p class="eyebrow">{b.company.name} · {b.packet?.identity.title ?? b.role.title}</p>
      <h1>Pick a time for your {b.iv.title.toLowerCase()}</h1>
      <p class="lead">{b.iv.durationMinutes} minutes, {b.iv.format.replace("_", " ")}{b.participants.length ? ` with ${b.participants.map((p) => p.firstName).join(" and ")}` : ""}. Times are shown in <strong>{tz.replace(/_/g, " ")}</strong>.</p>
      {/* Another time zone, one click away (founder brief, 14 October 2026): the line above already names the one shown. */}
      <details class="more">
        <summary>Change the time zone</summary>
        <form method="get" action={`/c/schedule/${b.iv.scheduleToken}`} class="card">
          <label for="tz" class="flush">Show times in</label>
          <select id="tz" name="tz">{[...new Set([tz, ...ZONES])].map((z) => <option value={z} selected={z === tz}>{z.replace(/_/g, " ")}</option>)}</select>
          <button class="btn secondary" type="submit">Show times</button>
        </form>
      </details>
      {error === "slot_unknown" ? <div class="err">That time is no longer available. Choose another.</div> : error === "slot_taken" ? <div class="err" role="alert">That time was just booked for another interview. Choose another.</div> : null}
      <form method="post" action={`/c/schedule/${b.iv.scheduleToken}`}>
        <input type="hidden" name="timezone" value={tz} />
        <fieldset>
          <legend>Available times</legend>
          {groups.map((g) => (
            <div class="card">
              <strong>{g.label}</strong>
              {g.slots.map((s) => (
                <label class="check slot" for={`slot-${s.id}`}><input type="radio" id={`slot-${s.id}`} name="slotId" value={s.id} required /> {s.label}</label>
              ))}
            </div>
          ))}
        </fieldset>
        <label for="access">Anything that would make the interview easier for you? (optional)</label>
        <input type="text" id="access" name="accessibilityNote" maxlength={500} placeholder="For example: captions on, or a phone call instead of video" />
        <button class="btn" type="submit">Confirm this time</button>
      </form>
      {/* Asking for other times, one click away (founder brief, 14 October 2026): picking a time is the page's one job. */}
      <details class="more">
        <summary>None of these work?</summary>
        <form method="post" action={`/c/schedule/${b.iv.scheduleToken}/none-work`} class="card">
          <input type="hidden" name="timezone" value={tz} />
          <label for="note" class="flush">Tell us what does</label>
          <textarea id="note" name="note" rows={3} maxlength={1000} placeholder="For example: mornings before 10, any day but Wednesday"></textarea>
          <button class="btn secondary" type="submit">Ask for other times</button>
        </form>
      </details>
      <p class="notice">Reply to any of our emails with HUMAN to reach a person. Nothing here is decided by software.</p>
    </Layout>,
  );
});

schedulePages.post("/c/schedule/:token", rateLimit(POLICIES.schedule), async (c) => {
  const container = c.get("container");
  const b = await loadByToken(container.db, c.req.param("token") ?? "");
  if (!b) return c.notFound();
  if (b.iv.status === "scheduled") return c.redirect(`/c/schedule/${b.iv.scheduleToken}/confirmed`);
  if (isOff(b)) return c.html(<NoLongerOn b={b} />, 410);
  if (b.expired || b.iv.status !== "scheduling") return c.html(<Expired b={b} />, 410);
  if (await newTimesNotOut(container.db, b)) return c.redirect(`/c/schedule/${b.iv.scheduleToken}`);
  const form = await c.req.parseBody();
  const parsed = SelectSlot.safeParse({ slotId: form.slotId, timezone: form.timezone || undefined, accessibilityNote: form.accessibilityNote || undefined });
  if (!parsed.success) return c.redirect(`/c/schedule/${b.iv.scheduleToken}?error=slot_unknown`);
  // Booked by the run waiting for a pick, or straight away when none waits (after "none of these work", during "no
  // common times", after the collisions escalation): never silently lost. A time booked for an interviewer since is
  // refused with a plain line, and they choose another; so is a time that has passed, or one no longer on offer.
  const actor = { kind: "candidate" as const, id: b.candidate.id };
  const route = await withTenant(container.db, b.company.id, async (tx) => {
    await lockApplication(tx, b.app.id);
    // the interview as it is now, locked: the times on offer may have changed since the page was drawn
    const [current] = await tx.select().from(interviews).where(eq(interviews.id, b.iv.id)).limit(1).for("update");
    if (!current || current.status !== "scheduling") return { where: "changed" as const };
    const slot = current.offeredSlots.find((s) => s.id === parsed.data.slotId);
    if (!slot) return { where: "unknown" as const };
    const woken = await container.engine.signal(tx, { companyId: b.company.id, key: `${b.iv.id}:interview.slot_selected`, payload: { slotId: slot.id } });
    const where = await routePick(tx, { iv: current, slot, woken, now: container.engine.clock() });
    if (where === "taken" || where === "stale") return { where };
    const [picked] = await tx.update(interviews).set({ selectedSlot: slot, schedulingWindow: { ...current.schedulingWindow, candidateTimezone: tzOf(b, parsed.data.timezone) }, candidateAvailability: parsed.data.accessibilityNote ? { ...(current.candidateAvailability ?? {}), note: current.candidateAvailability?.note, timezone: tzOf(b, parsed.data.timezone), preferred: current.candidateAvailability?.preferred ?? [], at: new Date().toISOString(), accessibilityNote: parsed.data.accessibilityNote } as never : current.candidateAvailability }).where(and(eq(interviews.id, b.iv.id), eq(interviews.attempt, current.attempt), eq(interviews.status, "scheduling"))).returning({ id: interviews.id });
    if (!picked) return { where: "changed" as const };
    await emit(tx, { type: "interview.slot_selected", companyId: b.company.id, actor, subject: { type: "interview", id: b.iv.id }, payload: { slotId: slot.id, timezone: tzOf(b, parsed.data.timezone), accessibilityNote: !!parsed.data.accessibilityNote, booking: where } });
    if (parsed.data.accessibilityNote) await notify(tx, { companyId: b.company.id, kind: "interview.accessibility", title: `${b.candidate.firstName} asked for an accommodation`, body: parsed.data.accessibilityNote, action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
    // a direct booking that finds the interview moved on undoes the pick: the page is shown again with what is on offer now
    if (where === "direct" && !(await bookPickNow(tx, container, { iv: current, roleId: b.app.roleId, actor }))) throw new PickChanged();
    return { where, resignal: where === "workflow" && woken === 0, slotId: slot.id };
  }).catch((err: unknown) => {
    if (err instanceof PickChanged) return { where: "changed" as const };
    throw err;
  });
  if (route.where === "taken") return c.redirect(`/c/schedule/${b.iv.scheduleToken}?error=slot_taken`);
  if (route.where === "stale" || route.where === "unknown") return c.redirect(`/c/schedule/${b.iv.scheduleToken}?error=slot_unknown`);
  if (route.where === "changed") return c.redirect(`/c/schedule/${b.iv.scheduleToken}`);
  // A run that was mid-step when the pick was written (it read no pick, and now waits): told again after the commit.
  if ("resignal" in route && route.resignal) await withTenant(container.db, b.company.id, (tx) => container.engine.signal(tx, { companyId: b.company.id, key: `${b.iv.id}:interview.slot_selected`, payload: { slotId: route.slotId } }));
  await container.kick();
  return c.redirect(`/c/schedule/${b.iv.scheduleToken}/confirmed`);
});

schedulePages.post("/c/schedule/:token/none-work", rateLimit(POLICIES.scheduleNoneWork), async (c) => {
  const container = c.get("container");
  const b = await loadByToken(container.db, c.req.param("token") ?? "");
  if (!b) return c.notFound();
  if (isOff(b)) return c.html(<NoLongerOn b={b} />, 410);
  if (b.expired || b.iv.status !== "scheduling") return c.html(<Expired b={b} />, 410);
  const form = await c.req.parseBody();
  const parsed = CandidateAvailability.safeParse({ timezone: form.timezone || undefined, note: form.note || undefined, preferred: [] });
  const data = parsed.success ? parsed.data : { preferred: [] as never[] };
  await withTenant(container.db, b.company.id, async (tx) => {
    await tx.update(interviews).set({ candidateAvailability: { ...data, at: new Date().toISOString() } }).where(eq(interviews.id, b.iv.id));
    await emit(tx, { type: "interview.candidate_availability", companyId: b.company.id, actor: { kind: "candidate", id: b.candidate.id }, subject: { type: "interview", id: b.iv.id }, payload: { hasNote: !!data.note } });
    await container.engine.signal(tx, { companyId: b.company.id, key: `${b.iv.id}:interview.none_work`, payload: {} });
  });
  await container.kick();
  return c.html(
    <Layout title="Thanks, we will find other times">
      <h1>Thanks, {b.candidate.firstName}</h1>
      <p>{b.company.name}'s team has your note and will send new times. You can reply to any of our emails if anything changes.</p>
    </Layout>,
  );
});

schedulePages.get("/c/schedule/:token/confirmed", async (c) => {
  const container = c.get("container");
  const b = await loadByToken(container.db, c.req.param("token") ?? "");
  if (!b) return c.notFound();
  const tz = tzOf(b, c.req.query("tz"));
  if (b.iv.status === "cancelled") {
    const own = await ownCancelOf(container.db, b);
    return c.html(own ? <CandidateCancelled b={b} row={own} /> : <NoLongerOn b={b} />);
  }
  if (b.closed && b.iv.status !== "scheduled") return c.html(<NoLongerOn b={b} />, 410);
  if (b.iv.status === "completed" || b.iv.status === "no_show") {
    return c.html(
      <Layout title="This interview time has passed">
        <h1>This interview time has passed</h1>
        <p>If you have a question, reply to any email from {b.company.name}'s hiring team.</p>
      </Layout>,
    );
  }
  if (b.iv.status !== "scheduled" || !b.iv.startsAt) {
    return c.html(
      <Layout title="Booking your time">
        <h1>Booking your time</h1>
        <p>{b.iv.selectedSlot ? "We are putting it on everyone's calendar. This usually takes a moment; refresh this page." : "No time is booked yet."} {b.iv.status === "scheduling" && !b.iv.selectedSlot ? <a href={`/c/schedule/${b.iv.scheduleToken}`}>Pick a time</a> : null}</p>
      </Layout>,
    );
  }
  const start = b.iv.startsAt;
  // What "Send me new times later" would bring them, worked out now so the page only says what is true for them.
  const now = container.engine.clock();
  // Once the interview has started it can no longer be moved or cancelled from here (audit 06, bug 96).
  const ahead = Date.parse(start) > now.getTime();
  const plan = !b.closed && ahead ? await withTenant(container.db, b.company.id, (tx) => autoNewTimesPlan(tx, { companyId: b.company.id, roleId: b.app.roleId, applicationId: b.app.id, rescheduleCount: b.iv.rescheduleCountCandidate, now })) : null;
  const missing = c.req.query("error") === "cancel";
  return c.html(
    <Layout title={`Confirmed: ${b.iv.title} at ${b.company.name}`} extraCss={SCHEDULE_CSS}>
      {/* The employer and job, said nowhere else on the page (kept, as on the page that picks the time). */}
      <p class="eyebrow">{b.company.name} · {b.packet?.identity.title ?? b.role.title}</p>
      <h1>You're confirmed</h1>
      <div class="card status">
        <div><span>When</span><strong>{formatInZone(start, tz)}</strong></div>
        {tz !== b.company.timezone ? <div><span>For the team</span><span>{formatInZone(start, b.company.timezone)}</span></div> : null}
        <div><span>How long</span><span>{b.iv.durationMinutes} minutes</span></div>
        <div><span>Who</span><span>{b.participants.map((p) => p.firstName).join(", ") || "the hiring team"}</span></div>
        {b.iv.meetingUrl && /^https?:\/\//i.test(b.iv.meetingUrl) ? <div><span>Join</span><a href={b.iv.meetingUrl} rel="noopener">{b.iv.meetingUrl}</a></div> : <div><span>Format</span><span>{b.iv.format.replace("_", " ")}</span></div>}
      </div>
      <a class="btn" href={`/c/schedule/${b.iv.scheduleToken}/ics`}><Icon name="calendar" />Add to my calendar</a>
      {/* The time stays on record for someone no longer in the process (it had already started); it can no longer be moved. */}
      {b.closed ? null : <h2>Need to change it?</h2>}
      {b.closed ? null : !ahead ? (
        <div class="card"><p>This interview has started, so it can no longer be moved here. If something went wrong, reply to any of our emails.</p></div>
      ) : b.iv.rescheduleCountCandidate < MAX_CANDIDATE_RESCHEDULES ? (
        <form method="post" action={`/c/schedule/${b.iv.scheduleToken}/reschedule`} class="card">
          <p>We will send new times. You can do this {MAX_CANDIDATE_RESCHEDULES - b.iv.rescheduleCountCandidate === 1 ? "one more time" : "twice"}.</p>
          <button class="btn secondary" type="submit">Ask for a different time</button>
        </form>
      ) : (
        <div class="card"><p>You have rescheduled twice. Reply to any of our emails and a person will arrange a time with you.</p></div>
      )}
      {/* Cancelling, with what they would like next (founder decision 2A), only while the interview is still ahead. One
          click away (founder brief, 14 October 2026), and open when a send came back incomplete (?error=cancel#cancel). */}
      {plan ? (
        <details class="more" open={missing}>
          <summary>I need to cancel</summary>
          <form method="post" action={`/c/schedule/${b.iv.scheduleToken}/cancel`} class="card" id="cancel">
            {missing ? <div class="err" role="alert" id="cancel-error">Choose what you would like next, and tick the box to confirm.</div> : null}
            <fieldset aria-describedby={missing ? "cancel-error" : undefined}>
              <legend class="question-legend">If you cancel, what would you like next?</legend>
              <label class="check slot" for="next-new-times"><input type="radio" id="next-new-times" name="next" value="new_times" required aria-describedby="next-new-times-hint" /> Send me new times later</label>
              <small id="next-new-times-hint">{newTimesHint(plan, b)}</small>
              <label class="check slot" for="next-not-interested"><input type="radio" id="next-not-interested" name="next" value="not_interested" aria-describedby="next-not-interested-hint" /> I'm no longer interested</label>
              <small id="next-not-interested-hint">We will let the team know. Your application stays open unless you withdraw it.</small>
            </fieldset>
            <label for="cancel-reason">Tell us why, if you like (optional)</label>
            <input type="text" id="cancel-reason" name="reason" maxlength={500} placeholder="For example: I accepted another offer" />
            <label class="check"><input type="checkbox" name="confirm" value="yes" required aria-invalid={missing ? "true" : undefined} aria-describedby={missing ? "cancel-error" : undefined} /> Yes, cancel this interview.</label>
            <button class="btn secondary" type="submit">Cancel the interview</button>
          </form>
        </details>
      ) : null}
    </Layout>,
  );
});

schedulePages.get("/c/schedule/:token/ics", async (c) => {
  const container = c.get("container");
  const b = await loadByToken(container.db, c.req.param("token") ?? "");
  if (!b?.packet) return c.notFound();
  if (b.iv.status !== "scheduled" || !b.iv.startsAt) return c.notFound();
  const ics = interviewIcs({ interview: b.iv, company: b.company, packet: b.packet, candidate: b.candidate, fromAddress: container.integrations.env.fromAddress, method: "REQUEST", appBaseUrl: container.env.APP_BASE_URL });
  return c.body(ics, 200, { "content-type": "text/calendar; charset=utf-8; method=REQUEST", "content-disposition": 'attachment; filename="interview.ics"', "cache-control": "no-store" });
});

schedulePages.post("/c/schedule/:token/reschedule", rateLimit(POLICIES.reschedule), async (c) => {
  const container = c.get("container");
  const b = await loadByToken(container.db, c.req.param("token") ?? "");
  if (!b) return c.notFound();
  if (b.closed) return c.redirect(`/c/schedule/${b.iv.scheduleToken}/confirmed`); // nothing can be moved for someone no longer in the process
  if (b.iv.status !== "scheduled") return c.redirect(`/c/schedule/${b.iv.scheduleToken}`);
  // An interview that has started (or is over and not yet closed) is never reopened from the candidate's page.
  if (!b.iv.startsAt || Date.parse(b.iv.startsAt) <= container.engine.clock().getTime()) return c.redirect(`/c/schedule/${b.iv.scheduleToken}/confirmed`);
  if (b.iv.rescheduleCountCandidate >= MAX_CANDIDATE_RESCHEDULES) {
    await withTenant(container.db, b.company.id, (tx) => notify(tx, { companyId: b.company.id, kind: "interview.reschedule_limit", title: `${b.candidate.firstName} wants to reschedule again`, body: "They have used both self-service reschedules; please arrange a time with them directly.", action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } }));
    return c.redirect(`/c/schedule/${b.iv.scheduleToken}/confirmed`);
  }
  const actor = { kind: "candidate" as const, id: b.candidate.id };
  const now = container.engine.clock();
  const hadEvents = Object.keys((b.iv.calendarRefs ?? {}) as Record<string, unknown>).length > 0;
  await withTenant(container.db, b.company.id, async (tx) => {
    await lockApplication(tx, b.app.id);
    // New times over a fresh window from tomorrow, as long as the old one: never the old dates, which may have passed.
    await tx.update(interviews).set({ status: "scheduling", attempt: b.iv.attempt + 1, selectedSlot: null, offeredSlots: [], startsAt: null, endsAt: null, reminders: {}, schedulingWindow: freshSchedulingWindow(b.iv.schedulingWindow, now, b.company.timezone), rescheduleCountCandidate: b.iv.rescheduleCountCandidate + 1, meetingUrl: b.iv.linkSource === "pasted" ? b.iv.meetingUrl : null, scheduleTokenExpiresAt: new Date(now.getTime() + 14 * 86_400_000).toISOString() }).where(eq(interviews.id, b.iv.id));
    await emit(tx, { type: "interview.rescheduled", companyId: b.company.id, actor, subject: { type: "interview", id: b.iv.id }, payload: { byCandidate: true, attempt: b.iv.attempt + 1, hadEvents } });
    if (b.app.stage === "interview_scheduled") await transition(tx, { applicationId: b.app.id, companyId: b.company.id, to: "interview_recommended", by: "system", actor, reason: "candidate asked to reschedule" });
    await notify(tx, { companyId: b.company.id, kind: "interview.rescheduled", title: `${b.candidate.firstName} ${b.candidate.lastName} asked to reschedule`, body: "New times are being offered automatically.", action: { label: "Open the interview", href: `/interviews/${b.iv.id}` }, userIds: b.participants.map((p) => p.userId) });
    if (hadEvents) await tx.insert(jobs).values({ kind: "interview.cancel_events", payload: { interviewId: b.iv.id, companyId: b.company.id, actor }, runAt: now.toISOString(), maxAttempts: 5 });
    await container.engine.start(tx, { workflowKey: "schedule_interview", companyId: b.company.id, subject: { type: "interview", id: b.iv.id }, state: { interviewId: b.iv.id, applicationId: b.app.id, roleId: b.app.roleId, roundKey: b.iv.roundKey, attempt: b.iv.attempt + 1, rescheduled: true }, idempotencyKey: `schedule:${b.iv.id}:${b.iv.attempt + 1}`, actor });
  });
  await container.kick();
  return c.redirect(`/c/schedule/${b.iv.scheduleToken}`);
});

/** What the team reads after "They said ...", by what the candidate chose and what happens next (founder decisions 2A and 3A). */
function teamCancelNote(next: CancelNext, plan: AutoPlan | { arm: false; reason: "not_asked" }, b: Bundle): string {
  if (next === "not_interested") return "They said they are no longer interested. Nothing goes to them automatically; decide when you are ready.";
  if (plan.arm) return `They asked for new times. New times go to them automatically on ${newTimesDayWords(plan.dueAt, b.company.timezone)}, once, as your settings say. To send them sooner, or to stop them, open them under Cancelled.`;
  switch (plan.reason) {
    case "switched_off":
      return "They asked for new times. Automatic new times are off in Settings, so nothing goes to them until you send times or decide.";
    case "already_used":
      return "They asked for new times. They already had their one automatic set, so nothing more goes automatically: send new times or decide.";
    case "reschedules_used":
      return "They asked for new times after moving this interview twice, so a person should arrange the time with them. Nothing goes to them automatically.";
    case "takeover":
      return "They asked for new times. An ITS recruiter is running this role, so nothing goes automatically: you or the recruiter decide.";
    case "was_on_hold":
      return "They asked for new times. You had put them on hold; that hold has ended and nothing goes automatically: send new times or decide.";
    case "company_not_checked":
      return "They asked for new times. ITS has not confirmed your company yet, so nothing can go to them automatically. Once ITS confirms it, send new times from their page.";
    default:
      return "They asked for new times. Nothing goes to them automatically: send new times or decide.";
  }
}

/**
 * The candidate cancels their booked interview (founder decisions 1A to 3A). Only a booked interview still ahead, of
 * someone still in the process: anything else (pressed twice, a stale tab, an interview they missed, an application
 * that closed) changes nothing and shows the page as it is. With their choice they go under Cancelled; someone who asked
 * for new times gets the one automatic set when nothing stops it (`autoNewTimesPlan`), armed for its day. A hold a person
 * had put on them ends, and nothing goes automatically for them then. The team and the interviewers are told, the
 * calendar events are removed by the worker, and the candidate gets a confirmation that says what comes next. Then
 * Post/Redirect/Get, so a refresh never cancels twice.
 */
schedulePages.post("/c/schedule/:token/cancel", rateLimit(POLICIES.cancelInterview), async (c) => {
  const container = c.get("container");
  const b = await loadByToken(container.db, c.req.param("token") ?? "");
  if (!b?.packet) return c.notFound();
  const confirmed = `/c/schedule/${b.iv.scheduleToken}/confirmed`;
  const now = container.engine.clock();
  if (b.iv.status !== "scheduled" || b.closed || !b.iv.startsAt || Date.parse(b.iv.startsAt) <= now.getTime()) return c.redirect(confirmed);
  const confirmBody = await c.req.parseBody();
  // The candidate's own words, if any, travel with the cancellation so the team sees why (docs/spec/04: "Optional reason; confirm"). A long note is cut, never refused.
  const parsed = CandidateCancel.safeParse({ confirm: confirmBody.confirm, next: confirmBody.next, reason: typeof confirmBody.reason === "string" && confirmBody.reason.trim() ? confirmBody.reason.trim().slice(0, 500) : undefined });
  if (!parsed.success) return c.redirect(`${confirmed}?error=cancel#cancel`);
  const { next } = parsed.data;
  const reason = parsed.data.reason || null;
  const actor = { kind: "candidate" as const, id: b.candidate.id };
  const hadEvents = Object.keys((b.iv.calendarRefs ?? {}) as Record<string, unknown>).length > 0;
  const packet = b.packet;
  const done = await withTenant(container.db, b.company.id, async (tx) => {
    // The application first, then the interview: the order a team cancel, a booking and a send of new times take them,
    // so two at the same moment take turns. Guarded: a second press, or the team acting a moment ago, finds the interview
    // changed and writes nothing.
    await lockApplication(tx, b.app.id);
    const [cancelled] = await tx.update(interviews).set({ status: "cancelled", cancelReason: reason ? `cancelled by the candidate: ${reason}` : "cancelled by the candidate", attempt: b.iv.attempt + 1 }).where(and(eq(interviews.id, b.iv.id), eq(interviews.status, "scheduled"), eq(interviews.attempt, b.iv.attempt))).returning({ id: interviews.id });
    if (!cancelled) return false;
    await emit(tx, { type: "interview.cancelled", companyId: b.company.id, actor, subject: { type: "interview", id: b.iv.id }, payload: { byCandidate: true, cause: "candidate_page", next, hadEvents, hasReason: !!reason } });
    if (b.app.stage === "interview_scheduled") await transition(tx, { applicationId: b.app.id, companyId: b.company.id, to: "interview_recommended", by: "system", actor, reason: "candidate cancelled the interview", now });
    const [app] = await tx.select({ stage: applications.stage }).from(applications).where(eq(applications.id, b.app.id)).limit(1);
    const underCancelled = !!app && CANCEL_STAGES.includes(app.stage);
    // Read before the row is written, so it says what was true when they chose (a hold still counts).
    // Under a share lock on the company row: switching automatic times off waits for this cancel, or this cancel reads it off.
    const plan: AutoPlan | { arm: false; reason: "not_asked" } = next === "new_times" && underCancelled ? await autoNewTimesPlan(tx, { companyId: b.company.id, roleId: b.app.roleId, applicationId: b.app.id, rescheduleCount: b.iv.rescheduleCountCandidate, now, lock: true }) : { arm: false, reason: "not_asked" };
    if (underCancelled) {
      const { row } = await openFollowUp(tx, { companyId: b.company.id, applicationId: b.app.id, interviewId: b.iv.id, interviewAttempt: b.iv.attempt + 1, kind: "candidate_cancelled", choice: next, auto: plan.arm ? { state: "waiting", dueAt: plan.dueAt, workingDays: plan.workingDays, day: plan.day } : { state: "none", reason: plan.reason }, actor, now });
      if (plan.arm) await armNewTimes(tx, container.engine, { companyId: b.company.id, followUpId: row.id, applicationId: b.app.id, roleId: b.app.roleId, interviewId: b.iv.id, actor });
    }
    await notify(tx, { companyId: b.company.id, kind: "interview.cancelled", title: `${b.candidate.firstName} ${b.candidate.lastName} cancelled the interview`, body: `${reason ? `They said: "${reason}". ` : ""}${teamCancelNote(next, plan, b)}`, action: { label: "Open the candidate", href: `/roles/${b.app.roleId}/talent?open=${b.app.id}` } });
    if (b.participants.length) await notify(tx, { companyId: b.company.id, kind: "interview.cancelled", title: `Interview cancelled: ${b.iv.title}`, body: `The candidate cancelled, so this interview is off.${hadEvents ? " The calendar event is being removed." : ""}`, action: { label: "Open interviews", href: "/interviews" }, userIds: b.participants.map((p) => p.userId) });
    if (hadEvents) await tx.insert(jobs).values({ kind: "interview.cancel_events", payload: { interviewId: b.iv.id, companyId: b.company.id, actor }, runAt: now.toISOString(), maxAttempts: 5 });
    await sendInterviewCancelled(tx, container.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet, actor, appBaseUrl: container.env.APP_BASE_URL, interview: { ...b.iv, status: "cancelled" }, interviewerFirstNames: b.participants.map((p) => p.firstName), candidateTimezone: tzOf(b), companyTimezone: b.company.timezone, byCandidate: true, candidateChoice: { next, newTimesOn: plan.arm ? newTimesDayWords(plan.dueAt, tzOf(b)) : null } });
    return true;
  });
  if (!done) return c.redirect(confirmed);
  await container.kick();
  return c.redirect(`/c/schedule/${b.iv.scheduleToken}/cancelled`);
});

/** After the candidate's own cancel: what we did and what comes next, in their words (Post/Redirect/Get lands here). */
schedulePages.get("/c/schedule/:token/cancelled", async (c) => {
  const container = c.get("container");
  const b = await loadByToken(container.db, c.req.param("token") ?? "");
  if (!b) return c.notFound();
  const own = await ownCancelOf(container.db, b);
  if (!own) return c.redirect(`/c/schedule/${b.iv.scheduleToken}/confirmed`);
  const { promise, day } = promiseOf(b, own);
  const company = b.company.name;
  return c.html(
    <Layout title="Interview cancelled">
      <h1>Your interview is cancelled</h1>
      {promise === "date" ? <p>We let {company}'s team know. We will email you new times on {day}, unless the team gets in touch first.</p>
        : promise === "soon" ? <p>We let {company}'s team know. We will email you new times as soon as they are ready.</p>
        : promise === "team" ? <p>We let {company}'s team know you would like new times. Someone from the team will be in touch about them.</p>
        : promise === "not_interested" ? <p>We let {company}'s team know you are no longer interested in this interview. Your application stays open.{b.closed ? null : <span> To withdraw it, open your application page from our emails, or <a href="/c/link-request">get your link by email</a>.</span>}</p>
        : <p>We let {company}'s team know. The hiring team will be in touch.</p>}
      <p class="notice">Reply to any of our emails with HUMAN to reach a person.</p>
    </Layout>,
  );
});
