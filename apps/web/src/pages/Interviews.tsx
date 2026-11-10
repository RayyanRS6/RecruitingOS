"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "../nav";
import { Alert, Avatar, Button, Card, Chip, Drawer, EmptyState, ErrorState, Eyebrow, Field, Icon, PageHeader, Pill, Skeleton, type SortValue, sortRows, Table, Timeline, useTableSort } from "@ros/ui";
import { api, ApiError, isCandidateLocked, type InterviewBooked, type InterviewDetail, type InterviewSummary, type InterviewerBrief, type Me, type NewTimesSettingView, type SendNewTimesResult } from "../api/client";
import { LockedCard } from "../components/LockedCandidates";
import { SetTimeForm } from "../components/SetTimeForm";
import { useCompanyCheck, useCompanyTimezone } from "../components/use-company-check";
import { toast } from "../toast";
import { interviewNewTimesText } from "../cancelled";
import { DECISION_WORDS, candidateEmailLine, formFromBooked, freshForm, interviewWord, shortWhen, type SetTimeForm as SetTimeFormState } from "../interview-time";
import { activeCompanyOf } from "../rail";
import { canDecideInterviews, canManageInterviews, canReadNotes, canSeeTalent } from "../roles";
import { cancelReasonLabel, interviewCancelToast, newTimesToast } from "../talent-actions";
import { againChoice, tookPlaceCard } from "../interview-defaults";
import { MyNote, useNotes } from "./candidate-panel/notes";

/**
 * Where an interview stands, in one word worked out from what is true of it (`interviewWord`, 6 November 2026): "No time
 * yet" while nothing has a time and nothing went to the candidate, "Waiting on the candidate" only while times reached
 * them, the email's fate beside a booked time. Red is only for a missing must-have or a critical error (docs/07), so a
 * cancelled interview is plain grey.
 */
const when = (iso: string | null, tz: string | null) => shortWhen(iso, tz) ?? "not yet";
/** The offered times still ahead: one that has passed can no longer be booked (the server refuses it too). */
const aheadSlots = <S extends { startsAt: string }>(slots: readonly S[], now: number = Date.now()): S[] => slots.filter((s) => Date.parse(s.startsAt) > now);
const INTERVIEW_SORT: Record<"candidate" | "round" | "when", (i: InterviewSummary) => SortValue> = { candidate: (i) => `${i.candidate.firstName} ${i.candidate.lastName}`, round: (i) => i.title, when: (i) => (i.startsAt ? Date.parse(i.startsAt) : null) };
/**
 * The side panel's cards sit a little tighter than a page's (screenshot 7's "at a glance" card): 20px from sm: up; on a
 * phone they keep the kit's card padding (20px above and below, 16px sides).
 */
const SHEET_CARD = "sm:p-5";
/** The brief's parts: a small mono heading (Eyebrow as="h3") over a bulleted list. */
const BRIEF_LIST = "small list-disc space-y-1.5 pl-5 marker:text-ink-3";

/** Interviews across roles (docs/04): who, when, who is interviewing, and what needs a person. */
export function Interviews() {
  const { id } = useParams();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const company = activeCompanyOf(me.data);
  const role = company.role;
  const check = useCompanyCheck();
  // Every interview, not the newest few hundred; refreshed every 30 seconds (the open interview's sheet refreshes faster).
  const list = useQuery({ queryKey: ["interviews"], queryFn: () => api.get<InterviewSummary[]>("/api/v1/interviews"), refetchInterval: 30000 });
  const upcoming = (list.data ?? []).filter((i) => ["proposed", "scheduling", "scheduled"].includes(i.status));
  const past = (list.data ?? []).filter((i) => !["proposed", "scheduling", "scheduled"].includes(i.status));
  // Coming up opens soonest first (unscheduled last), as it always has; Past opens latest first.
  const soon = useTableSort<"candidate" | "round" | "when">({ key: "when", dir: "ascending" });
  const done = useTableSort<"candidate" | "round" | "when">({ key: "when", dir: "descending" });
  // The interviewer line names people soonest interview first, whatever order the table is sorted in
  const load: Record<string, number> = {};
  for (const i of sortRows(upcoming, INTERVIEW_SORT.when, "ascending")) for (const p of i.participants) load[p.name ?? p.email] = (load[p.name ?? p.email] ?? 0) + 1;
  // Screenshot 4's table look, Coming up over Past, each in its own card; the open interview slides in from the right.
  return (
    <div className="stack gap-6">
      <PageHeader title="Interviews" />
      {list.isLoading ? <Card><Skeleton lines={4} /></Card> : list.error ? <ErrorState message="Could not load interviews." onRetry={() => list.refetch()} /> : (
        <>
          {/* the empty state's line only where it says what to do (founder, 23 October 2026: fewer words) */}
          {upcoming.length === 0 ? <EmptyState icon="interviews" title="No interviews coming up" body={canSeeTalent(role) ? "Open a candidate and set a date and time." : undefined} action={canSeeTalent(role) ? <Link to="/talent" className="btn primary">Go to Candidates</Link> : undefined} /> : (
            <Card title={`Coming up (${upcoming.length})`}>
              <Table head={[soon.col("candidate", "Candidate", "text"), soon.col("round", "Round", "text"), soon.col("when", "When", "date", { first: "ascending" }), "Interviewers", "Status", ""]} announce={soon.announce}>
                {soon.apply(upcoming, INTERVIEW_SORT).map((i) => {
                  const w = interviewWord(i, check);
                  return (
                    <tr key={i.id}>
                      <td><CandidateCell i={i} /></td>
                      <td>{i.title}</td>
                      <td className="text-ink-2">{when(i.startsAt, i.timezone)}{w.note ? <><br /><span className="small muted">{w.note}</span></> : null}</td>
                      <td className="small text-ink-2">{i.participants.map((p) => p.name ?? p.email).join(", ")}</td>
                      <td><Pill size="sm" tone={w.tone}>{w.label}</Pill></td>
                      <td className="text-right"><OpenLink id={i.id} /></td>
                    </tr>
                  );
                })}
              </Table>
              {Object.keys(load).length ? <p className="small muted mt-3">Interviewer load: {Object.entries(load).map(([n, c]) => `${n} ${c}`).join(" · ")}</p> : null}
            </Card>
          )}
          {past.length ? (
            <Card title={`Past (${past.length})`}>
              <Table head={[done.col("candidate", "Candidate", "text"), done.col("round", "Round", "text"), done.col("when", "When", "date"), "Outcome", "Decision", ""]} announce={done.announce}>
                {done.apply(past, INTERVIEW_SORT).map((i) => {
                  const w = interviewWord(i, check);
                  return (
                    <tr key={i.id}>
                      <td><CandidateCell i={i} /></td>
                      <td>{i.title}</td>
                      <td className="text-ink-2">{when(i.startsAt, i.timezone)}</td>
                      <td><Pill size="sm" tone={w.tone}>{w.label}</Pill></td>
                      <td className="small text-ink-2">{i.decision ? DECISION_WORDS[i.decision] ?? i.decision.replace(/_/g, " ") : "not yet"}</td>
                      <td className="text-right"><OpenLink id={i.id} /></td>
                    </tr>
                  );
                })}
              </Table>
            </Card>
          ) : null}
        </>
      )}
      {id ? <InterviewSheet id={id} role={role} userId={me.data?.user.id ?? null} all={list.data ?? []} /> : null}
    </div>
  );
}

/** The row's way into the interview: "Open" with the table's arrow, which turns plum and nudges under the mouse. */
function OpenLink({ id }: { id: string }) {
  return <Link to={`/interviews/${id}`} className="btn quiet sm">Open<Icon name="arrow-right" size={16} className="chev" /></Link>;
}

/**
 * The Link line of an interview with no link yet. The calendar makes the link only through an interviewer's working
 * calendar: an event it booked, or a live connection that books one with the time. With none, the interview approval
 * records "calendar" to mean no link at all (the development stand-in on staging, or nobody connected), so the line says
 * so rather than promise a link that never comes.
 */
export function noLinkText(i: Pick<InterviewDetail, "linkSource" | "calendarRefs" | "availabilitySources" | "format">): string {
  const calendar = Object.keys(i.calendarRefs ?? {}).length > 0 || i.availabilitySources.some((s) => s.source === "calendar");
  if (i.linkSource === "calendar" && calendar) return "created with the calendar event";
  return i.format === "video" ? "none yet: send the candidate the video link yourself" : "none: the invitation says what kind of interview it is";
}

/** The candidate column: initials, the name, and the role underneath. */
function CandidateCell({ i }: { i: InterviewSummary }) {
  const name = `${i.candidate.firstName} ${i.candidate.lastName}`;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar name={name} />
      <span className="min-w-0 leading-snug">
        <span className="font-semibold text-ink">{name}</span>
        <br />
        <span className="text-[13px] text-ink-3">{i.roleTitle}</span>
      </span>
    </div>
  );
}

/** One interview. What can be changed here follows the person's role: interviewers see their interview and record whether it took place; the decision is recorded from the candidate's page by the hiring team. */
function InterviewSheet({ id, role, userId, all }: { id: string; role: string | null; userId: string | null; all: InterviewSummary[] }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  // A refusal or a missing interview is an answer, not a hiccup: it is not retried and the 10-second refresh stops while it stands.
  const q = useQuery({
    queryKey: ["interview", id],
    queryFn: () => api.get<InterviewDetail>(`/api/v1/interviews/${id}`),
    refetchInterval: (query) => (query.state.status === "error" ? false : 10000),
    retry: (count, e) => !(e instanceof ApiError && (e.status === 403 || e.status === 404 || isCandidateLocked(e))) && count < 3,
  });
  const check = useCompanyCheck();
  // "Change it": move a booked time, set a different one, or cancel (each opens in the card); the cancel's reason is the candidate's to read.
  const [changing, setChanging] = useState<"move" | "set" | "cancel" | null>(null);
  const [reason, setReason] = useState("");
  const [offerReason, setOfferReason] = useState("");
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["interview", id] }); await qc.invalidateQueries({ queryKey: ["interviews"] }); await qc.invalidateQueries({ queryKey: ["brief"] }); };
  // The old way, folded: new times over a fresh window from tomorrow, from the interviewers' hours; a candidate whose time
  // was booked is told at once that it is off. Offered only where every interviewer has hours, so times do follow.
  const reschedule = useMutation({ mutationFn: () => api.post<{ candidateTold?: boolean | null }>(`/api/v1/interviews/${id}/reschedule`, { reason: offerReason || undefined }), onSuccess: async (r) => { toast(check === "waiting" ? "New times are being prepared." : "New times are going out.", r?.candidateTold ? "The candidate was told their booked time is off." : check === "waiting" ? "They go to the candidate once ITS confirms your company." : undefined); await refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not reschedule.") });
  const cancel = useMutation({ mutationFn: () => api.post<{ candidateTold?: boolean; interviewersTold?: boolean; candidateNotice?: string }>(`/api/v1/interviews/${id}/cancel`, { reason }), onSuccess: async (r) => { const t = interviewCancelToast(r); toast(t.title, t.detail); setChanging(null); setReason(""); await refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not cancel.") });
  const outcome = useMutation({ mutationFn: (o: string) => api.post(`/api/v1/interviews/${id}/outcome`, { outcome: o }), onSuccess: async () => { toast("Recorded."); await refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record.") });
  // A time that clashes with another interview booked since is refused with a plain message (409 slot_taken).
  const book = useMutation({ mutationFn: (slotId: string) => api.post<{ status?: string }>(`/api/v1/interviews/${id}/book-on-behalf`, { slotId, note: "chosen with the candidate by phone" }), onSuccess: async (r) => { toast(r?.status === "scheduled" ? "Booked on the candidate's behalf." : "Booking that time for them.", r?.status === "scheduled" ? undefined : "It shows here as booked in a moment."); await refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not book.") });
  // Someone under Cancelled (founder decision 2A): the same interview reopened for new times, or a new one for the same round after a no-show.
  const newTimes = useMutation({
    mutationFn: (applicationId: string) => api.post<SendNewTimesResult>(`/api/v1/applications/${applicationId}/new-times`, {}),
    onSuccess: async (r, applicationId) => {
      if (q.data) { const t = newTimesToast({ kind: "sent", via: r.via, firstName: q.data.candidate.firstName, round: q.data.title }); toast(t.title, t.detail); }
      await refresh();
      await qc.invalidateQueries({ queryKey: ["application", applicationId] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send new times."),
  });
  const i = q.data;
  const manage = canManageInterviews(role);
  const participant = !!i && !!userId && i.participants.some((p) => p.userId === userId);
  const finished = !!i && ["completed", "no_show"].includes(i.status);
  const again = !!i && againChoice(i, all, role);
  // Before ITS confirms the company the team's send is refused (409 company_not_checked), so the card does not offer it.
  const setting = useQuery({ queryKey: ["new-times-setting"], queryFn: () => api.get<NewTimesSettingView>("/api/v1/companies/current/new-times"), retry: false, enabled: again === "send_new_times" });
  const companyConfirmed = setting.data?.companyConfirmed;
  const word = i ? interviewWord(i, check) : null;
  // A time a person set has no hours behind it: the hours chips and the window say nothing about it.
  const setByPerson = i?.selectedSlot?.source === "person";
  // The old way works only where every interviewer has hours or a calendar, so only then is it offered, folded.
  const everyoneHasHours = !!i && i.participants.length > 0 && i.participants.every((p) => (i.availabilitySources.find((x) => x.userId === p.userId)?.source ?? "none") !== "none");
  // Nothing has a time and nothing reached them (6 November 2026): the form, on this interview. Lapsed times only while
  // this is still their newest interview and they are at the interview step (`againChoice`).
  const needsTime = !!i && manage && !!word?.needsTime && (i.status !== "offer_expired" || again === "offer_again");
  // What became of the email about it: said once, where the team looks (never claimed as sent).
  const emailLine = i && (i.status === "scheduled" || (i.status === "scheduling" && i.offeredSlots.length > 0)) ? candidateEmailLine(i.candidateEmail, i.candidate.firstName, check) : null;
  const refreshAll = async () => { await refresh(); if (i) await qc.invalidateQueries({ queryKey: ["application", i.applicationId] }); };
  return (
    <Drawer open onClose={() => nav("/interviews")} title={i ? `${i.candidate.firstName} ${i.candidate.lastName} · ${i.title}` : "Interview"} leading={i ? <Avatar name={`${i.candidate.firstName} ${i.candidate.lastName}`} size="lg" /> : undefined}>
      {/* an old link to someone past the plan's candidates per job (Rule 3): the same card as on their job, not an error */}
      {!i && isCandidateLocked(q.error) ? <LockedCard /> : q.error && !i ? <ErrorState message={q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403) ? "This interview is not one of yours, or it no longer exists." : "Could not load this interview."} onRetry={() => q.refetch()} /> : q.isLoading || !i ? <Skeleton lines={8} /> : (
        // Screenshot 7's "Account at a glance": the state and what it is about on top, the facts as the kit's label and
        // value rows (dl.glance), the questions to answer in their own cards, the history last.
        <div className="stack gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="row"><Pill tone={word?.tone ?? "neutral"}>{word?.label}</Pill><span className="small muted">{i.roleTitle}</span></span>
            {canSeeTalent(role) ? <Link to={`/roles/${i.roleId}/talent?open=${i.applicationId}&message=1`} className="btn secondary sm">Message the candidate</Link> : null}
          </div>
          {emailLine ? <Alert tone="caution">{emailLine}</Alert> : null}
          {needsTime ? (
            <Card needsYou title="Set the date and time" className={SHEET_CARD}>
              <SheetSetTime i={i} onDone={refreshAll} />
            </Card>
          ) : null}
          {i.brief ? <BriefCard brief={i.brief} /> : null}
          {participant || canReadNotes(role) ? <InterviewNote applicationId={i.applicationId} roleId={i.roleId} firstName={i.candidate.firstName} seesTalent={canSeeTalent(role)} /> : null}
          {finished ? (
            <Card needsYou={!i.decision && canDecideInterviews(role)} title="After the interview" className={SHEET_CARD}>
              {i.decision ? (
                <>
                  <p><strong>Decision: {DECISION_WORDS[i.decision] ?? i.decision.replace(/_/g, " ")}</strong></p>
                  {i.decisionNote ? <p className="small muted mt-1">Note (kept internally): {i.decisionNote}</p> : null}
                </>
              ) : (
                <>
                  <p className="small text-ink-2">{i.outcome ? "" : "First say whether it took place. "}Nobody has recorded a decision yet: next round, finalist, or not moving forward.</p>
                  {canDecideInterviews(role) ? <div className="row mt-3"><Link to={`/roles/${i.roleId}/talent?open=${i.applicationId}`} className="btn primary sm">Record the decision</Link></div> : <p className="small muted mt-1.5">The hiring team records it; it will show here.</p>}
                </>
              )}
            </Card>
          ) : null}
          <Card title="Details" className={SHEET_CARD}>
            <dl className="glance">
              <dt>When</dt><dd>{when(i.startsAt, i.timezone)}{i.timezone ? ` (${i.timezone})` : ""}</dd>
              <dt>Length</dt><dd>{i.durationMinutes} minutes, {i.format.replace("_", " ")}</dd>
              {/* where it is: the address or the phone a person chose, else the link */}
              {i.selectedSlot?.address ? <><dt>Where</dt><dd>{i.selectedSlot.address}</dd></> : setByPerson && i.format === "phone" ? <><dt>Where</dt><dd>By phone</dd></> : <><dt>Link</dt><dd>{i.meetingUrl ? <a href={i.meetingUrl} target="_blank" rel="noreferrer">{i.meetingUrl}</a> : noLinkText(i)}</dd></>}
              <dt>Interviewers</dt><dd className="flex flex-wrap gap-x-4 gap-y-1.5">{i.participants.map((p) => { const s = i.availabilitySources.find((x) => x.userId === p.userId); return <span key={p.userId} className="inline-flex flex-wrap items-center gap-1.5">{p.name ?? p.email}{setByPerson ? null : <> <Chip tone={s?.source === "calendar" ? "good" : s?.source === "declared" ? "accent" : "neutral"}>{s?.source === "calendar" ? "calendar" : s?.source === "declared" ? "declared hours" : "no hours set"}</Chip></>}</span>; })}</dd>
              {setByPerson ? null : <><dt>Window</dt><dd>{i.schedulingWindow.fromDate} to {i.schedulingWindow.toDate}</dd></>}
              <dt>Candidate reschedules</dt><dd>{i.rescheduleCountCandidate} of 2</dd>
            </dl>
          </Card>
          {i.candidateAvailability?.note || i.candidateAvailability?.accessibilityNote ? <Alert tone="info">{i.candidateAvailability.accessibilityNote ? `Accommodation request: ${i.candidateAvailability.accessibilityNote}. ` : ""}{i.candidateAvailability.note ? `The candidate wrote: "${i.candidateAvailability.note}"` : ""}</Alert> : null}
          {i.status === "scheduling" && aheadSlots(i.offeredSlots).length ? (
            <Card title="Times offered to the candidate" className={SHEET_CARD}>
              {/* times that have passed are not offered, nor booked for them (the server refuses them too) */}
              <ul className="small grid gap-2">{aheadSlots(i.offeredSlots).map((s) => <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2">{when(s.startsAt, i.timezone)}{manage ? <> <Button size="sm" variant="quiet" loading={book.isPending} onClick={() => book.mutate(s.id)}>Book this for them</Button></> : null}</li>)}</ul>
              {manage ? <p className="small muted mt-3">Booking on their behalf is for when you agreed a time by phone; it is recorded as your action.</p> : null}
            </Card>
          ) : null}
          {tookPlaceCard(i) !== "hidden" && (manage || participant) ? (
            <Card title="Did it take place?" className={SHEET_CARD}>
              {tookPlaceCard(i) === "early" ? <div className="mb-3"><Alert tone="caution">It has not started yet: it is booked for {when(i.startsAt, i.timezone)}. Answer once it has taken place; either answer ends the interview.</Alert></div> : null}
              <p className="small muted mb-3">A no-show is never held against anyone automatically.</p>
              <div className="row"><Button size="sm" variant="primary" loading={outcome.isPending} onClick={() => outcome.mutate("happened")}>Yes</Button><Button size="sm" loading={outcome.isPending} onClick={() => outcome.mutate("no_show_candidate")}>Candidate did not show</Button><Button size="sm" loading={outcome.isPending} onClick={() => outcome.mutate("no_show_interviewer")}>We did not show</Button></div>
            </Card>
          ) : null}
          {manage && (["proposed", "scheduling", "scheduled"].includes(i.status) || (i.status === "offer_expired" && again === "offer_again" && everyoneHasHours)) ? (
            <Card title="Change it" className={SHEET_CARD}>
              {changing === "move" || changing === "set" ? (
                <SheetSetTime i={i} moving={changing === "move"} onDone={async () => { setChanging(null); await refreshAll(); }} onCancel={() => setChanging(null)} />
              ) : changing === "cancel" ? (
                <div className="stack gap-3">
                  <Field label={cancelReasonLabel(i)} htmlFor="iv-reason"><input id="iv-reason" className="input" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></Field>
                  <div className="row">
                    <Button size="sm" variant="destructive" loading={cancel.isPending} disabled={!reason.trim()} onClick={() => cancel.mutate()}>Confirm cancel</Button>
                    <Button size="sm" variant="quiet" onClick={() => setChanging(null)}>Keep it</Button>
                  </div>
                </div>
              ) : i.status === "offer_expired" ? null : (
                <div className="row">
                  {i.status === "scheduled" ? <Button size="sm" onClick={() => setChanging("move")}>Move it</Button> : !needsTime && i.status === "scheduling" ? <Button size="sm" onClick={() => setChanging("set")}>Set a different time</Button> : null}
                  <Button size="sm" variant="destructive" onClick={() => setChanging("cancel")}>Cancel interview</Button>
                </div>
              )}
              {everyoneHasHours && !changing ? (
                <details className="more mt-3">
                  <summary>Or let them pick from your free times</summary>
                  <div className="stack gap-3">
                    {i.status === "scheduled" ? <Field label="Reason for new times (the candidate sees it)" htmlFor="iv-offer-reason"><input id="iv-offer-reason" className="input" value={offerReason} maxLength={500} onChange={(e) => setOfferReason(e.target.value)} /></Field> : null}
                    <div className="row"><Button size="sm" loading={reschedule.isPending} onClick={() => reschedule.mutate()}>Offer new times</Button></div>
                  </div>
                </details>
              ) : null}
            </Card>
          ) : null}
          {again === "send_new_times" && i.followUp ? (
            <Card needsYou={companyConfirmed !== false || !!i.followUp.noHours} title={companyConfirmed === false || i.followUp.noHours ? "New times" : "Send new times"} className={SHEET_CARD}>
              <p className="small text-ink-2">{interviewNewTimesText(i.candidate.firstName, i.followUp.reason, companyConfirmed, i.followUp.noHours)}</p>
              <div className="row mt-3">
                {/* a time a person sets needs no hours, and takes them out of Cancelled once booked: it comes first, and alone
                    when nobody on the interview has hours (`noHours`), where a send would be refused */}
                {canSeeTalent(role) ? <Link to={`/roles/${i.roleId}/talent?open=${i.applicationId}&step=interview`} className="btn primary sm">Set a date and time</Link> : null}
                {companyConfirmed === false || i.followUp.noHours ? null : <Button size="sm" variant={canSeeTalent(role) ? undefined : "primary"} icon="send" loading={newTimes.isPending} onClick={() => newTimes.mutate(i.applicationId)}>Send new times</Button>}
              </div>
            </Card>
          ) : again === "approve_new" ? (
            <Card title="Interview again?" className={SHEET_CARD}>
              <p className="small text-ink-2">This interview was cancelled.</p>
              <div className="row mt-3"><Link to={`/roles/${i.roleId}/talent?open=${i.applicationId}&step=interview`} className="btn secondary sm">Set a new date and time</Link></div>
            </Card>
          ) : null}
          <Card title="Timeline" className={SHEET_CARD}><Timeline items={i.timeline.map((e) => ({ when: new Date(e.occurredAt).toLocaleString(), what: e.type.replace(/[._]/g, " "), who: e.actor.name ?? e.actor.kind }))} /></Card>
        </div>
      )}
    </Drawer>
  );
}

/**
 * The interview's own "Set a date and time" (POST /interviews/:id/set-time): the same form as on the candidate's panel, on
 * the company's clock. `moving` a booked time opens it filled in with that time and asks for an optional reason, which the
 * candidate reads in the one email that says the time moved.
 */
function SheetSetTime({ i, moving, onDone, onCancel }: { i: InterviewDetail; moving?: boolean; onDone: () => Promise<void>; onCancel?: () => void }) {
  const timeZone = useCompanyTimezone() ?? i.timezone;
  const [form, setForm] = useState<SetTimeFormState>(() => (moving ? formFromBooked(i, timeZone) : freshForm(i)));
  return (
    <SetTimeForm
      idBase={moving ? `move-${i.id}` : `set-${i.id}`}
      firstName={i.candidate.firstName}
      hasEmail={i.candidate.hasEmail !== false}
      timeZone={timeZone}
      form={form}
      onChange={setForm}
      roundMinutes={i.durationMinutes}
      videoRound={i.format === "video"}
      calendarLive={i.availabilitySources.some((s) => s.source === "calendar")}
      moving={moving}
      submit={(body) => api.post<InterviewBooked>(`/api/v1/interviews/${i.id}/set-time`, body)}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}

/**
 * Your own private note on the candidate (founder decision Q24; plan H3), beside the interview: an interviewer writes
 * theirs once the interview has started and never sees anyone else's; the hiring team reads everyone's on the
 * candidate's page. Never shown to the candidate, never given to the AI assistant.
 */
function InterviewNote({ applicationId, roleId, firstName, seesTalent }: { applicationId: string; roleId: string; firstName: string; seesTalent: boolean }) {
  const q = useNotes(applicationId);
  if (q.isLoading) return <Skeleton lines={2} />;
  // a refusal (not on this candidate's interviews) shows nothing here; every other error says so
  if (q.error instanceof ApiError && q.error.status === 403) return null;
  if (q.error || !q.data) return <ErrorState message="Could not load your note." onRetry={() => q.refetch()} />;
  return (
    <div className="stack gap-1.5">
      <MyNote applicationId={applicationId} view={q.data} firstName={firstName} compact />
      {seesTalent && q.data.canRead === "all" ? <p className="small muted">Everyone's notes are on <Link to={`/roles/${roleId}/talent?open=${applicationId}&tab=notes`}>{firstName}'s page</Link>.</p> : <p className="small muted">Only you and the hiring team read your note; {firstName} never does.</p>}
    </div>
  );
}

const MET_LABEL: Record<string, string> = { yes: "met", partially: "partly met", no: "not met", unknown: "unknown so far" };
const MET_TONE: Record<string, "good" | "accent" | "caution" | "neutral"> = { yes: "good", partially: "accent", no: "caution", unknown: "neutral" };
const FINDING_LABEL: Record<string, string> = { evidenced: "seen", partially_evidenced: "partly seen", not_evidenced: "not seen yet", contradicted: "contradicted" };
const FINDING_TONE: Record<string, "good" | "accent" | "caution" | "neutral"> = { evidenced: "good", partially_evidenced: "accent", not_evidenced: "neutral", contradicted: "caution" };

/** The interviewer's brief (F7): what the round is for, what to look for, what the evidence says so far. No score, no rationale, pay only when the role may see it. */
function BriefCard({ brief }: { brief: InterviewerBrief }) {
  // Each part under a small mono heading (spec 7's section cards with eyebrow titles); quotes stay muted beside the claim.
  return (
    <Card title={`Your brief: ${brief.round.title}`} className={SHEET_CARD}>
      <p className="small text-ink-2"><strong className="text-ink">What this round is for:</strong> {brief.round.purpose}</p>
      <div className="stack mt-4 gap-4">
        <div>
          <Eyebrow as="h3" className="mb-2 flex">What to look for</Eyebrow>
          <ul className={BRIEF_LIST}>
            {brief.competencies.map((c) => <li key={c.key}><strong>{c.name}</strong>: {c.definition} <Chip tone={c.finding ? FINDING_TONE[c.finding] ?? "neutral" : "neutral"}>{c.finding ? FINDING_LABEL[c.finding] ?? c.finding : "not assessed yet"}</Chip>{c.note ? <span className="muted"> {c.note}</span> : null}</li>)}
          </ul>
        </div>
        {brief.questions.length ? (
          <div>
            <Eyebrow as="h3" className="mb-2 flex">Questions the plan suggests</Eyebrow>
            <ul className={BRIEF_LIST}>{brief.questions.map((qn, i) => <li key={i}>{qn}</li>)}</ul>
          </div>
        ) : null}
        <div>
          <Eyebrow as="h3" className="mb-2 flex">Must-haves and what we know</Eyebrow>
          <ul className={BRIEF_LIST}>
            {brief.mustHaves.map((m) => <li key={m.key}>{m.text} <Chip tone={MET_TONE[m.met] ?? "neutral"}>{MET_LABEL[m.met] ?? m.met}</Chip>{m.quote ? <span className="muted"> "{m.quote}"</span> : null}</li>)}
          </ul>
        </div>
        <div>
          <Eyebrow as="h3" className="mb-2 flex">Strengths so far</Eyebrow>
          {brief.strengths.length ? <ul className={BRIEF_LIST}>{brief.strengths.map((s, i) => <li key={i}>{s.claim}{s.quote ? <span className="muted"> "{s.quote}"</span> : null}</li>)}</ul> : <p className="small muted">None recorded yet.</p>}
        </div>
        <div>
          <Eyebrow as="h3" className="mb-2 flex">Worth exploring</Eyebrow>
          {brief.concerns.length ? <ul className={BRIEF_LIST}>{brief.concerns.map((s, i) => <li key={i}>{s.claim}{s.quote ? <span className="muted"> "{s.quote}"</span> : null}</li>)}</ul> : <p className="small muted">Nothing flagged yet.</p>}
        </div>
        {brief.screen?.answers.length ? (
          <details className="more">
            <summary>What they said in the AI interview ({brief.screen.answers.length} answers)</summary>
            <dl className="small grid gap-3 rounded-xl border border-line-tint bg-tint p-3.5">{brief.screen.answers.map((a, i) => <div key={i} className="min-w-0"><dt className="font-semibold text-ink">{a.question}</dt><dd className="mt-0.5 text-ink-2 [overflow-wrap:anywhere]">{a.answer}</dd></div>)}</dl>
          </details>
        ) : null}
        {brief.includesPay && brief.pay?.expectation ? <p className="small"><strong>Pay expectation:</strong> {brief.pay.expectation} <Chip tone={brief.pay.withinRange === "yes" ? "good" : brief.pay.withinRange === "unknown" ? "neutral" : "caution"}>{brief.pay.withinRange === "yes" ? "within the range" : brief.pay.withinRange === "unknown" ? "not compared" : `${brief.pay.withinRange} the range`}</Chip></p> : null}
        <p className="small muted border-t border-line pt-3">The decision after the interview is the hiring team's, recorded with a reason. Nothing here is a score.</p>
      </div>
    </Card>
  );
}
