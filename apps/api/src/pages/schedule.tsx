/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { CandidateAvailability, CandidateCancel, SelectSlot } from "@ros/contracts";
import { emit, formatInZone, groupSlotsByDay, notify, transition } from "@ros/core";
import { interviewIcs, participantsOf, sendInterviewCancelled } from "@ros/agents";
import { applications, candidates, companies, interviews, jobs, rolePackets, roles, withTenant, type Db } from "@ros/db";
import type { Vars } from "../middleware/session";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { Layout } from "./layout";

/**
 * The candidate's scheduling pages (docs/04 §candidate; slice 5 step 9): pick a time in your own zone, say none work,
 * see the confirmation, download the invitation, reschedule (twice), cancel. Server-rendered, no JavaScript, keyboard
 * and screen-reader friendly. Reached only through the single-use token in the candidate's email.
 */
export const schedulePages = new Hono<Vars>();

const ZONES = ["America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago", "America/New_York", "America/Anchorage", "Pacific/Honolulu"];
const MAX_CANDIDATE_RESCHEDULES = 2;

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
  return { iv, app, candidate, role, company, packet: pv?.packet ?? null, participants, expired: !!iv.scheduleTokenExpiresAt && Date.parse(iv.scheduleTokenExpiresAt) < Date.now() };
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

schedulePages.get("/c/schedule/:token", async (c) => {
  const container = c.get("container");
  const b = await loadByToken(container.db, c.req.param("token") ?? "");
  if (!b) return c.notFound();
  if (b.iv.status === "scheduled") return c.redirect(`/c/schedule/${b.iv.scheduleToken}/confirmed`);
  if (b.expired || !["scheduling"].includes(b.iv.status) || !b.iv.offeredSlots.length) return c.html(<Expired b={b} />, 410);
  const tz = tzOf(b, c.req.query("tz"));
  const groups = groupSlotsByDay(b.iv.offeredSlots, tz);
  const error = c.req.query("error");
  return c.html(
    <Layout title={`Pick a time: ${b.iv.title} at ${b.company.name}`}>
      <p class="meta">{b.company.name} · {b.packet?.identity.title ?? b.role.title}</p>
      <h1>Pick a time for your {b.iv.title.toLowerCase()}</h1>
      <p>{b.iv.durationMinutes} minutes, {b.iv.format.replace("_", " ")}{b.participants.length ? ` with ${b.participants.map((p) => p.firstName).join(" and ")}` : ""}. Times are shown in <strong>{tz.replace(/_/g, " ")}</strong>.</p>
      <form method="get" action={`/c/schedule/${b.iv.scheduleToken}`} class="card">
        <label for="tz">Show times in</label>
        <select id="tz" name="tz">{[...new Set([tz, ...ZONES])].map((z) => <option value={z} selected={z === tz}>{z.replace(/_/g, " ")}</option>)}</select>
        <button class="btn secondary" type="submit" style="width:auto;margin-top:8px">Show times</button>
      </form>
      {error === "slot_unknown" ? <div class="err">That time is no longer available. Choose another.</div> : null}
      <form method="post" action={`/c/schedule/${b.iv.scheduleToken}`}>
        <input type="hidden" name="timezone" value={tz} />
        <fieldset style="border:0;padding:0;margin:0">
          <legend class="meta">Available times</legend>
          {groups.map((g) => (
            <div class="card">
              <strong>{g.label}</strong>
              {g.slots.map((s) => (
                <label class="check" for={`slot-${s.id}`}><input type="radio" id={`slot-${s.id}`} name="slotId" value={s.id} required /> {s.label}</label>
              ))}
            </div>
          ))}
        </fieldset>
        <label for="access">Anything that would make the interview easier for you? (optional)</label>
        <input type="text" id="access" name="accessibilityNote" maxlength={500} placeholder="For example: captions on, or a phone call instead of video" />
        <button class="btn" type="submit">Confirm this time</button>
      </form>
      <h2>None of these work?</h2>
      <form method="post" action={`/c/schedule/${b.iv.scheduleToken}/none-work`} class="card">
        <input type="hidden" name="timezone" value={tz} />
        <label for="note">Tell us what does</label>
        <textarea id="note" name="note" rows={3} maxlength={1000} placeholder="For example: mornings before 10, any day but Wednesday"></textarea>
        <button class="btn secondary" type="submit">Ask for other times</button>
      </form>
      <p class="notice">Reply to any of our emails with HUMAN to reach a person. Nothing here is decided by software.</p>
    </Layout>,
  );
});

schedulePages.post("/c/schedule/:token", rateLimit(POLICIES.schedule), async (c) => {
  const container = c.get("container");
  const b = await loadByToken(container.db, c.req.param("token") ?? "");
  if (!b) return c.notFound();
  if (b.iv.status === "scheduled") return c.redirect(`/c/schedule/${b.iv.scheduleToken}/confirmed`);
  if (b.expired || b.iv.status !== "scheduling") return c.html(<Expired b={b} />, 410);
  const form = await c.req.parseBody();
  const parsed = SelectSlot.safeParse({ slotId: form.slotId, timezone: form.timezone || undefined, accessibilityNote: form.accessibilityNote || undefined });
  if (!parsed.success) return c.redirect(`/c/schedule/${b.iv.scheduleToken}?error=slot_unknown`);
  const slot = b.iv.offeredSlots.find((s) => s.id === parsed.data.slotId);
  if (!slot) return c.redirect(`/c/schedule/${b.iv.scheduleToken}?error=slot_unknown`);
  await withTenant(container.db, b.company.id, async (tx) => {
    await tx.update(interviews).set({ selectedSlot: slot, schedulingWindow: { ...b.iv.schedulingWindow, candidateTimezone: tzOf(b, parsed.data.timezone) }, candidateAvailability: parsed.data.accessibilityNote ? { ...(b.iv.candidateAvailability ?? {}), note: b.iv.candidateAvailability?.note, timezone: tzOf(b, parsed.data.timezone), preferred: b.iv.candidateAvailability?.preferred ?? [], at: new Date().toISOString(), accessibilityNote: parsed.data.accessibilityNote } as never : b.iv.candidateAvailability }).where(eq(interviews.id, b.iv.id));
    await emit(tx, { type: "interview.slot_selected", companyId: b.company.id, actor: { kind: "candidate", id: b.candidate.id }, subject: { type: "interview", id: b.iv.id }, payload: { slotId: slot.id, timezone: tzOf(b, parsed.data.timezone), accessibilityNote: !!parsed.data.accessibilityNote } });
    if (parsed.data.accessibilityNote) await notify(tx, { companyId: b.company.id, kind: "interview.accessibility", title: `${b.candidate.firstName} asked for an accommodation`, body: parsed.data.accessibilityNote, action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } });
    await container.engine.signal(tx, { companyId: b.company.id, key: `${b.iv.id}:interview.slot_selected`, payload: { slotId: slot.id } });
  });
  await container.kick();
  return c.redirect(`/c/schedule/${b.iv.scheduleToken}/confirmed`);
});

schedulePages.post("/c/schedule/:token/none-work", rateLimit(POLICIES.scheduleNoneWork), async (c) => {
  const container = c.get("container");
  const b = await loadByToken(container.db, c.req.param("token") ?? "");
  if (!b) return c.notFound();
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
  if (b.iv.status === "cancelled") return c.html(<Layout title="Interview cancelled"><h1>This interview was cancelled</h1><p>Reply to any email from {b.company.name}'s hiring team if you have questions.</p></Layout>);
  if (b.iv.status !== "scheduled" || !b.iv.startsAt) {
    return c.html(
      <Layout title="Booking your time">
        <h1>Booking your time</h1>
        <p>{b.iv.selectedSlot ? "We are putting it on everyone's calendar. This usually takes a moment; refresh this page." : "No time is booked yet."} {b.iv.status === "scheduling" && !b.iv.selectedSlot ? <a href={`/c/schedule/${b.iv.scheduleToken}`}>Pick a time</a> : null}</p>
      </Layout>,
    );
  }
  const start = b.iv.startsAt;
  return c.html(
    <Layout title={`Confirmed: ${b.iv.title} at ${b.company.name}`}>
      <p class="meta">{b.company.name} · {b.packet?.identity.title ?? b.role.title}</p>
      <h1>You're confirmed</h1>
      <div class="card status">
        <div><span>When</span><strong>{formatInZone(start, tz)}</strong></div>
        {tz !== b.company.timezone ? <div><span>For the team</span><span>{formatInZone(start, b.company.timezone)}</span></div> : null}
        <div><span>How long</span><span>{b.iv.durationMinutes} minutes</span></div>
        <div><span>Who</span><span>{b.participants.map((p) => p.firstName).join(", ") || "the hiring team"}</span></div>
        {b.iv.meetingUrl && /^https?:\/\//i.test(b.iv.meetingUrl) ? <div><span>Join</span><a href={b.iv.meetingUrl} rel="noopener">{b.iv.meetingUrl}</a></div> : <div><span>Format</span><span>{b.iv.format.replace("_", " ")}</span></div>}
      </div>
      <a class="btn" href={`/c/schedule/${b.iv.scheduleToken}/ics`}>Add to my calendar</a>
      <h2>Need to change it?</h2>
      {b.iv.rescheduleCountCandidate < MAX_CANDIDATE_RESCHEDULES ? (
        <form method="post" action={`/c/schedule/${b.iv.scheduleToken}/reschedule`} class="card">
          <p>We will send new times. You can do this {MAX_CANDIDATE_RESCHEDULES - b.iv.rescheduleCountCandidate === 1 ? "one more time" : "twice"}.</p>
          <button class="btn secondary" type="submit" style="width:auto">Ask for a different time</button>
        </form>
      ) : (
        <div class="card"><p>You have rescheduled twice. Reply to any of our emails and a person will arrange a time with you.</p></div>
      )}
      <form method="post" action={`/c/schedule/${b.iv.scheduleToken}/cancel`} class="card">
        <p>No longer interested in this interview?</p>
        <label for="cancel-reason">Tell us why, if you like (optional)</label>
        <input type="text" id="cancel-reason" name="reason" maxlength={500} placeholder="For example: I accepted another offer" />
        <label class="check"><input type="checkbox" name="confirm" value="yes" required /> Yes, cancel this interview.</label>
        <button class="btn secondary" type="submit" style="width:auto">Cancel the interview</button>
      </form>
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
  if (b.iv.status !== "scheduled") return c.redirect(`/c/schedule/${b.iv.scheduleToken}`);
  if (b.iv.rescheduleCountCandidate >= MAX_CANDIDATE_RESCHEDULES) {
    await withTenant(container.db, b.company.id, (tx) => notify(tx, { companyId: b.company.id, kind: "interview.reschedule_limit", title: `${b.candidate.firstName} wants to reschedule again`, body: "They have used both self-service reschedules; please arrange a time with them directly.", action: { label: "Open the interview", href: `/interviews/${b.iv.id}` } }));
    return c.redirect(`/c/schedule/${b.iv.scheduleToken}/confirmed`);
  }
  const actor = { kind: "candidate" as const, id: b.candidate.id };
  const now = container.engine.clock();
  const hadEvents = Object.keys((b.iv.calendarRefs ?? {}) as Record<string, unknown>).length > 0;
  await withTenant(container.db, b.company.id, async (tx) => {
    await tx.update(interviews).set({ status: "scheduling", attempt: b.iv.attempt + 1, selectedSlot: null, offeredSlots: [], startsAt: null, endsAt: null, reminders: {}, rescheduleCountCandidate: b.iv.rescheduleCountCandidate + 1, meetingUrl: b.iv.linkSource === "pasted" ? b.iv.meetingUrl : null, scheduleTokenExpiresAt: new Date(now.getTime() + 14 * 86_400_000).toISOString() }).where(eq(interviews.id, b.iv.id));
    await emit(tx, { type: "interview.rescheduled", companyId: b.company.id, actor, subject: { type: "interview", id: b.iv.id }, payload: { byCandidate: true, attempt: b.iv.attempt + 1, hadEvents } });
    if (b.app.stage === "interview_scheduled") await transition(tx, { applicationId: b.app.id, companyId: b.company.id, to: "interview_recommended", by: "system", actor, reason: "candidate asked to reschedule" });
    await notify(tx, { companyId: b.company.id, kind: "interview.rescheduled", title: `${b.candidate.firstName} ${b.candidate.lastName} asked to reschedule`, body: "New times are being offered automatically.", action: { label: "Open the interview", href: `/interviews/${b.iv.id}` }, userIds: b.participants.map((p) => p.userId) });
    if (hadEvents) await tx.insert(jobs).values({ kind: "interview.cancel_events", payload: { interviewId: b.iv.id, companyId: b.company.id, actor }, runAt: now.toISOString(), maxAttempts: 5 });
    await container.engine.start(tx, { workflowKey: "schedule_interview", companyId: b.company.id, subject: { type: "interview", id: b.iv.id }, state: { interviewId: b.iv.id, applicationId: b.app.id, roleId: b.app.roleId, roundKey: b.iv.roundKey, attempt: b.iv.attempt + 1 }, idempotencyKey: `schedule:${b.iv.id}:${b.iv.attempt + 1}`, actor });
  });
  await container.kick();
  return c.redirect(`/c/schedule/${b.iv.scheduleToken}`);
});

schedulePages.post("/c/schedule/:token/cancel", rateLimit(POLICIES.cancelInterview), async (c) => {
  const container = c.get("container");
  const b = await loadByToken(container.db, c.req.param("token") ?? "");
  if (!b?.packet) return c.notFound();
  if (["cancelled", "completed"].includes(b.iv.status)) return c.redirect(`/c/schedule/${b.iv.scheduleToken}/confirmed`);
  const confirmBody = await c.req.parseBody();
  // The candidate's own words, if any, travel with the cancellation so the team sees why (docs/spec/04: "Optional reason; confirm"). A long note is cut, never refused.
  const parsed = CandidateCancel.safeParse({ confirm: confirmBody.confirm, reason: typeof confirmBody.reason === "string" && confirmBody.reason.trim() ? confirmBody.reason.trim().slice(0, 500) : undefined });
  if (!parsed.success) return c.redirect(`/c/schedule/${b.iv.scheduleToken}?confirm=cancel`);
  const reason = parsed.data.reason || null;
  const actor = { kind: "candidate" as const, id: b.candidate.id };
  const now = container.engine.clock();
  const hadEvents = Object.keys((b.iv.calendarRefs ?? {}) as Record<string, unknown>).length > 0;
  await withTenant(container.db, b.company.id, async (tx) => {
    await tx.update(interviews).set({ status: "cancelled", cancelReason: reason ? `cancelled by the candidate: ${reason}` : "cancelled by the candidate", attempt: b.iv.attempt + 1 }).where(eq(interviews.id, b.iv.id));
    await emit(tx, { type: "interview.cancelled", companyId: b.company.id, actor, subject: { type: "interview", id: b.iv.id }, payload: { byCandidate: true, hadEvents, hasReason: !!reason } });
    if (b.app.stage === "interview_scheduled") await transition(tx, { applicationId: b.app.id, companyId: b.company.id, to: "interview_recommended", by: "system", actor, reason: "candidate cancelled the interview" });
    await notify(tx, { companyId: b.company.id, kind: "interview.cancelled", title: `${b.candidate.firstName} ${b.candidate.lastName} cancelled the interview`, body: `${reason ? `They said: "${reason}". ` : ""}Decide whether to offer new times, hold, or move on; nothing happens automatically.`, action: { label: "Open the candidate", href: `/roles/${b.app.roleId}/talent?open=${b.app.id}` } });
    if (hadEvents) await tx.insert(jobs).values({ kind: "interview.cancel_events", payload: { interviewId: b.iv.id, companyId: b.company.id, actor }, runAt: now.toISOString(), maxAttempts: 5 });
    await sendInterviewCancelled(tx, container.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet!, actor, appBaseUrl: container.env.APP_BASE_URL, interview: { ...b.iv, status: "cancelled" }, interviewerFirstNames: b.participants.map((p) => p.firstName), candidateTimezone: tzOf(b), companyTimezone: b.company.timezone, byCandidate: true });
  });
  await container.kick();
  return c.html(
    <Layout title="Interview cancelled">
      <h1>Your interview is cancelled</h1>
      <p>We let {b.company.name}'s team know. If you change your mind, reply to any of our emails.</p>
    </Layout>,
  );
});
