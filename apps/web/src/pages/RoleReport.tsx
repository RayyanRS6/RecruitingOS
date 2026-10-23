"use client";

import { Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Card, EmptyState, ErrorState, Icon, numHead, OWNER_STAGES, PipelineBar, Pill, Skeleton, Stat, Table } from "@ros/ui";
import { Link } from "../nav";
import { ApiError, api, type Me, type ScreeningFunnel } from "../api/client";
import { funnelLines } from "../screen-view";

/** The role report as the API answers it (apps/api/src/services/role-report.ts). Counts and days only; never a name. */
export type RoleReport = {
  generatedAt: string;
  role: { id: string; title: string; status: string; openedAt: string | null; closedAt: string | null; daysOpen: number | null } | null;
  applicants: { total: number; last30Days: number; timeZone: string; bySource: Array<{ source: string; label: string; sourceDetail: string | null; count: number }>; byDay: Array<{ day: string; count: number }> };
  /**
   * `byOwnerStage` is the stage strip (private marks included); `marks` counts who carries each mark now and every hold
   * ever set; `told` counts decisions by whether the candidate was told (founder decisions B3 and B6). Optional: an
   * older answer has none of them.
   */
  stages: { total: number; byStage: Array<{ stage: string; label: string; group: string; count: number }>; byGroup: Record<string, number>; byOwnerStage?: Record<string, number>; marks?: { longlist: number; shortlist: number; onHold: number; holdsEnded: number; notAFitForNow: number; holdsEverSet: number }; told?: { decisions: number; notTold: number; queued: number; sent: number; toldInPerson: number; beforeTracking?: number } };
  timeInStage: { byStage: Array<{ stage: string; label: string; group: string; completed: number; medianDays: number | null; averageDays: number | null; nowHere: number; longestDays: number | null }>; waitingOnYou: { count: number; averageDays: number | null; medianDays: number | null; longestDays: number | null } };
  interviews: { total: number; requested: number; scheduled: number; completed: number; noShow: number; noShowCandidate: number; noShowInterviewer: number; cancelled: number; offerExpired: number; rescheduledByCandidate: number; awaitingDecision: number; byRound: Array<{ roundKey: string; title: string; total: number; scheduled: number; completed: number; noShow: number; noShowCandidate: number; noShowInterviewer: number; cancelled: number }> };
  pendingDecisions: { count: number; approvals: number; candidates: number; oldestDays: number | null; list: Array<{ kind: "approval" | "candidate"; label: string; days: number; applicationId: string | null; approvalRequestId: string | null }> };
  recommendationsVsDecisions: { assessed: number; rows: Array<{ recommendation: string; label: string; total: number; invited: number; interviewed: number; shortlisted?: number; declined: number; held: number; noActionYet: number }> };
  overrides: { eligibilityOverrides: number; reviewAnyway: number; holds: number; flaggedAssessments: number; byAction: Record<string, number> };
  escalations: { total: number; open: number; resolved: number; overdue: number; medianResponseHours: number | null };
  messages: { total: number; sent: number; failed: number; bounced: number; unknown: number; pending: number; candidatesAffected: number };
  outcomes: { statement: string; hired: number; withdrew: number; declinedByEmployer: number; declinedOffer: number; noHire: number; talentPool: number; corrections: number; role: { outcome: string; recordedAt: string } | null; rolesByOutcome: Record<string, number>; declineReasons: Array<{ reason: string; label: string; count: number }> };
  /**
   * How the pool meets each must-have (plan F7), from the same findings as the match score: counts only. Each must-have's
   * `total` is the people read against a version of the role that had it. `stricter` is the gentle "stricter than
   * needed?" note. Only on one role's report; an older answer has none.
   */
  mustHaves?: { people: number; showEveryMustHave: number; byMustHave: Array<{ key: string; label: string; shown: number; partly: number; notShown: number; unknown: number; total: number }>; stricter: { words: string; editPath: string } | null };
};

// "Waiting on the candidate": an offer made outside the app with no answer recorded yet (plan H2).
const GROUP_LABEL: Record<string, string> = { waiting_on_you: "Waiting on you", waiting_on_candidate: "Waiting on the candidate", in_process: "In process", not_moving_forward: "Not moving forward", hired: "Hired" };
const ROLE_OUTCOME_LABEL: Record<string, string> = { filled: "Filled", filled_outside_platform: "Filled outside the platform", role_cancelled: "Cancelled", no_hire: "Closed without a hire", voided: "Recorded in error" };

const days = (n: number | null) => (n === null ? "none yet" : n === 1 ? "1 day" : `${n} days`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What an ITS recruiter whose access covers one candidate sees on the Report tab, in plain words: the figures count that
 * candidate alone, and figures about the job's whole group (the AI interview's) are for the hiring team.
 */
export const ONE_CANDIDATE_REPORT = "Your recruiter access covers one candidate on this job, so these figures count that candidate only. Figures about everyone who applied are for the hiring team.";
export const ONE_CANDIDATE_SCREENING = "Your recruiter access covers one candidate, so how the AI interview goes for everyone on this job is not shown here. That candidate's own AI interview is on their page.";

/** Whether a refusal is the one-candidate grant's limit (403 `staff_scope`), which is explained, never offered as a retry. */
export function isOneCandidateLimit(err: unknown): boolean {
  return err instanceof ApiError && err.code === "staff_scope";
}

/**
 * The Report tab: the ten figures for one role, and the two downloads. Fewer words (23 Oct 2026): what each figure
 * means, and the definitions the cards once carried under their tables, are in one closed disclosure at the end; a card
 * keeps only its fairness and accountability lines ("People make every decision", "never held against anyone",
 * "recorded with the person's name and reason", "Counts only; nobody is named here").
 */
export function ReportTab({ roleId }: { roleId: string }) {
  const q = useQuery({ queryKey: ["role", roleId, "report"], queryFn: () => api.get<RoleReport>(`/api/v1/roles/${roleId}/report`) });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const oneCandidate = !!me.data?.staffAccess?.scope.applicationId;
  if (q.isLoading) return <Skeleton lines={6} />;
  if (isOneCandidateLimit(q.error)) return <Alert tone="info">{ONE_CANDIDATE_REPORT}</Alert>;
  if (q.error || !q.data) return <ErrorState message="Could not load the report." onRetry={() => q.refetch()} />;
  const r = q.data;
  return (
    <div className="stack gap-5">
      {oneCandidate ? <Alert tone="info">{ONE_CANDIDATE_REPORT}</Alert> : null}
      <div className="row justify-between gap-3">
        <p className="small muted min-w-0 flex-[1_1_20rem]">Figures as of {new Date(r.generatedAt).toLocaleString()}.</p>
        <div className="row">
          <a className="btn secondary sm" href={`/api/v1/roles/${roleId}/report.csv`} download><Icon name="file-text" />Download the applicant list (CSV)</a>
          <a className="btn secondary sm" href={`/api/v1/roles/${roleId}/report/summary.csv`} download><Icon name="file-text" />Download the summary (CSV)</a>
        </div>
      </div>
      {r.applicants.total === 0 ? <EmptyState title="No applicants yet" /> : null}
      <ReportFigures report={r} talentHref={`/roles/${roleId}/talent`} />
      {r.mustHaves ? <MustHavesCard mustHaves={r.mustHaves} links /> : null}
      <ScreeningCard roleId={roleId} />
      <ReportDefinitions />
    </div>
  );
}

/**
 * How the pool meets the must-haves (plan F7): for each must-have, how many people's evidence shows it, partly shows it,
 * shows it is not met (their own words only) or does not say yet, how many show every one, and the gentle "stricter
 * than needed?" note with the way to the must-haves. Counts only, never a name; it never declines anyone.
 */
export function MustHavesCard({ mustHaves: m, links }: { mustHaves: NonNullable<RoleReport["mustHaves"]>; links?: boolean }) {
  return (
    <Card title="How the pool meets the must-haves">
      {!m.people || !m.byMustHave.length ? <p className="small muted">{m.byMustHave.length ? "Nobody has been read against the must-haves yet." : "This job lists no must-haves."}</p> : (
        <>
          <p className="small text-ink-2"><strong>{m.showEveryMustHave} of {plural(m.people, "person", "people")}</strong> {m.people === 1 ? "shows" : "show"} every must-have.</p>
          <div className="mt-3">
            <Table head={["Must-have", numHead("Shown"), numHead("Partly shown"), numHead("Not met"), numHead("Not known yet"), numHead("People read against it")]} label="How the pool meets each must-have" wrapHeads>
              {m.byMustHave.map((x) => <tr key={x.key}><td>{x.label}</td><td className="num">{x.shown}</td><td className="num">{x.partly}</td><td className="num">{x.notShown}</td><td className="num">{x.unknown}</td><td className="num">{x.total}</td></tr>)}
            </Table>
          </div>
          {m.stricter ? <p className="small mt-3 text-ink-2">{m.stricter.words} {links ? <Link to={m.stricter.editPath}>Look at the must-haves</Link> : null}</p> : null}
          <p className="small muted mt-3">"Not met" counts only when the candidate's own words show it; anything else is "not known yet" and is never held against anyone. Someone read before a must-have was added is left out of its count. Counts only; nobody is named here.</p>
        </>
      )}
    </Card>
  );
}

/**
 * How the AI interview goes for this role (plan E13): how many were offered it, started and finished, the
 * typical time to finish, how many chose a person instead, and the questions people chose not to answer in the answers
 * they sent. From each person's latest conversation; counts only, never a name or an answer, and nothing from a
 * conversation nobody sent, so not where anyone stopped (founder decision of 9 October 2026).
 */
export function ScreeningCard({ roleId }: { roleId: string }) {
  const q = useQuery({ queryKey: ["role", roleId, "screening"], queryFn: () => api.get<ScreeningFunnel>(`/api/v1/roles/${roleId}/screening`) });
  if (q.isLoading) return <Card title="The AI interview"><Skeleton lines={3} /></Card>;
  if (isOneCandidateLimit(q.error)) return <Card title="The AI interview"><p className="small muted">{ONE_CANDIDATE_SCREENING}</p></Card>;
  if (q.error || !q.data) return <Card title="The AI interview"><ErrorState message="Could not load how the AI interview is going." onRetry={() => q.refetch()} /></Card>;
  const f = q.data;
  const lines = funnelLines(f);
  return (
    <Card title="The AI interview">
      {!lines.length ? <p className="small muted">Nobody has been offered the AI interview for this job yet.</p> : (
        <>
          <div className="stat-row">
            <Stat n={f.offered} label={f.offered === 1 ? "person offered it" : "people offered it"} />
            <Stat n={f.finished} label="finished it" />
            {f.stillApplying ? <Stat n={f.stillApplying} label="with it open now" /> : null}
          </div>
          <dl className="kv mt-4 border-t border-line pt-4">
            {lines.map((l) => <Fragment key={l.label}><dt>{l.label}</dt><dd>{l.value}</dd></Fragment>)}
          </dl>
          {f.skipped.length ? (
            <div className="mt-4">
              <Table head={["Question", numHead("Chose not to answer")]} label="Questions people chose not to answer">
                {f.skipped.map((s) => <tr key={s.key}><td>{s.question}</td><td className="num">{s.count}</td></tr>)}
              </Table>
            </div>
          ) : null}
          {f.stillApplying ? <div className="row mt-3"><Link to={`/roles/${roleId}/talent?ownerStage=no_ai_interview`} className="text-link min-h-10">See who has no AI interview yet<Icon name="arrow-right" /></Link></div> : null}
          {/* what "typical" means is in the figures' disclosure; the fairness rule and the no-names assurance stay here,
              as on the must-haves card */}
          <p className="small muted mt-3">Choosing a person or not answering a question is never held against anyone. Counts only; nobody is named here.</p>
        </>
      )}
    </Card>
  );
}

/** The ten figures as plain-language cards. Used by the role page and by the administrator's customer view (no links there). */
export function ReportFigures({ report: r, talentHref }: { report: RoleReport; talentHref?: string }) {
  const maxDay = Math.max(0, ...r.applicants.byDay.map((d) => d.count));
  // the way to the people a figure counts: a plum text link with an arrow (screenshot 1's "All applicants")
  const talent = (label: string, query = "") => (talentHref ? <Link to={`${talentHref}${query}`} className="text-link min-h-10">{label}<Icon name="arrow-right" /></Link> : null);
  return (
    // Two columns once the figures themselves have the room (a container, so the job page and the admin's customer
    // drawer both decide by their own width); a card whose table has many columns takes the whole width, unscrolled.
    <div className="@container">
      <div className="grid grid-cols-1 gap-5 @4xl:grid-cols-2">
        <Card title="Who applied">
          <div className="stat-row">
            <Stat n={r.applicants.total} label={r.applicants.total === 1 ? "applicant in total" : "applicants in total"} />
            <Stat n={r.applicants.last30Days} label="in the last 30 days" />
          </div>
          {/* the bars' heights are the data (each day's count against the busiest day); how to read them is the
              chart's tooltip, each bar's its day and count */}
          <div className="daybars" role="img" aria-label={`Applicants per day over the last 30 days: ${r.applicants.byDay.filter((d) => d.count).map((d) => `${d.day} ${d.count}`).join(", ") || "none"}`} title={`One bar per day, oldest on the left, days in ${r.applicants.timeZone}.`}>
            {r.applicants.byDay.map((d) => <span key={d.day} title={`${d.day}: ${d.count}`} className={d.count ? undefined : "zero"} style={{ height: `${maxDay ? Math.max(4, (d.count / maxDay) * 100) : 4}%` }} />)}
          </div>
          <div className="mt-4">
            {r.applicants.bySource.length ? (
              <Table head={["Where from", "Detail", numHead("Applicants")]} label="Applicants by source">
                {r.applicants.bySource.map((s) => <tr key={`${s.source}:${s.sourceDetail ?? ""}`}><td>{s.label}</td><td className="small muted">{s.sourceDetail ?? ""}</td><td className="num">{s.count}</td></tr>)}
              </Table>
            ) : <p className="small muted">Nobody yet.</p>}
          </div>
        </Card>

        <Card title="Where everyone is">
          <PipelineBar counts={r.stages.byGroup} total={r.stages.total} />
          <div className="row mt-3">
            {(["waiting_on_you", "waiting_on_candidate", "in_process", "not_moving_forward", "hired"] as const).filter((g) => g !== "waiting_on_candidate" || (r.stages.byGroup[g] ?? 0) > 0).map((g) => <Pill key={g} size="sm" tone={g === "waiting_on_you" ? "caution" : g === "hired" ? "good" : g === "in_process" ? "accent" : "neutral"}>{GROUP_LABEL[g]}: <span className="tabular">{r.stages.byGroup[g] ?? 0}</span></Pill>)}
          </div>
          {r.stages.byOwnerStage ? (
            <div className="mt-4">
              <Table head={["Stage", numHead("People")]} label="People by stage">
                {OWNER_STAGES.map((s) => <tr key={s.id}><td>{talentHref && (r.stages.byOwnerStage?.[s.id] ?? 0) > 0 ? <Link to={`${talentHref}?ownerStage=${s.id}`}>{s.label}</Link> : s.label}</td><td className="num">{r.stages.byOwnerStage?.[s.id] ?? 0}</td></tr>)}
              </Table>
            </div>
          ) : null}
          {r.stages.marks || r.stages.told ? (
            <dl className="kv mt-4">
              {r.stages.marks ? <><dt>Holds that have ended</dt><dd>{r.stages.marks.holdsEnded}</dd></> : null}
              {r.stages.marks?.notAFitForNow ? <><dt>Set aside as not a fit for now</dt><dd>{r.stages.marks.notAFitForNow}</dd></> : null}
              {r.stages.told ? <><dt>Decisions not told yet</dt><dd>{r.stages.told.notTold}</dd><dt>Told by message</dt><dd>{r.stages.told.sent}{r.stages.told.queued ? ` (${r.stages.told.queued} on the way)` : ""}</dd><dt>Told in person</dt><dd>{r.stages.told.toldInPerson}</dd></> : null}
              {r.stages.told?.beforeTracking ? <><dt>Decided before decisions were private (shown on their status page)</dt><dd>{r.stages.told.beforeTracking}</dd></> : null}
            </dl>
          ) : null}
          {r.stages.byStage.length ? (
            <details className="more mt-4">
              <summary>The steps underneath</summary>
              <Table head={["Step", numHead("People")]} label="People by step">
                {r.stages.byStage.map((s) => <tr key={s.stage}><td>{s.label} <span className="small muted">({GROUP_LABEL[s.group] ?? s.group})</span></td><td className="num">{s.count}</td></tr>)}
              </Table>
            </details>
          ) : null}
          {talentHref ? (
            <div className="row mt-2 gap-x-5">
              {talent("See the people")}
              {r.stages.told?.notTold ? talent("Tell them your decision", "?ownerStage=not_moving_forward&told=not_told") : null}
            </div>
          ) : null}
        </Card>

        <Card title="How long each step takes" className={WIDE}>
          <p className="small mb-4 text-ink-2">
            <strong>{plural(r.timeInStage.waitingOnYou.count, "candidate is", "candidates are")} waiting on you</strong>
            {r.timeInStage.waitingOnYou.count ? ` · typical wait ${days(r.timeInStage.waitingOnYou.medianDays)} · longest ${days(r.timeInStage.waitingOnYou.longestDays)}` : ""}.
          </p>
          {r.timeInStage.byStage.length ? (
            <Table head={["Step", numHead("There now"), numHead("Longest so far"), numHead("Finished this step"), numHead("Typical stay"), numHead("Average stay")]} label="Time in each step" wrapHeads>
              {r.timeInStage.byStage.map((s) => <tr key={s.stage}><td>{s.label}</td><td className="num">{s.nowHere}</td><td className="num">{s.nowHere ? days(s.longestDays) : ""}</td><td className="num">{s.completed}</td><td className="num">{s.completed ? days(s.medianDays) : ""}</td><td className="num">{s.completed ? days(s.averageDays) : ""}</td></tr>)}
            </Table>
          ) : <p className="small muted">Nothing has moved yet.</p>}
        </Card>

        <Card title="Interviews" className={WIDE}>
          <dl className="kv">
            <dt>Requested, not yet on the calendar</dt><dd>{r.interviews.requested}</dd>
            <dt>On the calendar</dt><dd>{r.interviews.scheduled}</dd>
            <dt>Held</dt><dd>{r.interviews.completed}</dd>
            <dt>Candidate did not show</dt><dd>{r.interviews.noShowCandidate}</dd>
            <dt>Interviewer did not show</dt><dd>{r.interviews.noShowInterviewer}</dd>
            {r.interviews.noShow > r.interviews.noShowCandidate + r.interviews.noShowInterviewer ? <><dt>Did not take place, who was missing not recorded</dt><dd>{r.interviews.noShow - r.interviews.noShowCandidate - r.interviews.noShowInterviewer}</dd></> : null}
            <dt>Cancelled</dt><dd>{r.interviews.cancelled}</dd>
            <dt>Rescheduled by the candidate</dt><dd>{r.interviews.rescheduledByCandidate}</dd>
            <dt>Waiting for your decision</dt><dd>{r.interviews.awaitingDecision}</dd>
          </dl>
          {r.interviews.byRound.length ? (
            <div className="mt-4">
              <Table head={["Round", numHead("All"), numHead("On the calendar"), numHead("Held"), numHead("Candidate did not show"), numHead("Interviewer did not show"), numHead("Cancelled")]} label="Interviews by round" pinFirst wrapHeads>
                {r.interviews.byRound.map((x) => <tr key={x.roundKey}><td>{x.title}</td><td className="num">{x.total}</td><td className="num">{x.scheduled}</td><td className="num">{x.completed}</td><td className="num">{x.noShowCandidate}</td><td className="num">{x.noShowInterviewer}</td><td className="num">{x.cancelled}</td></tr>)}
              </Table>
            </div>
          ) : null}
        </Card>

        <Card title="Decisions waiting for you" needsYou={r.pendingDecisions.count > 0} className={WIDE}>
          <div className="stat-row">
            <Stat n={r.pendingDecisions.count} label={r.pendingDecisions.count === 1 ? "decision only a person can make" : "decisions only a person can make"} />
            {r.pendingDecisions.oldestDays !== null ? <Stat n={r.pendingDecisions.oldestDays} label="days the oldest has waited" /> : null}
          </div>
          <p className="small muted my-3">{r.pendingDecisions.candidates} {r.pendingDecisions.candidates === 1 ? "candidate" : "candidates"} waiting on you (including anyone held on an eligibility answer) and {r.pendingDecisions.approvals} {r.pendingDecisions.approvals === 1 ? "approval" : "approvals"} pending.</p>
          {r.pendingDecisions.list.length ? (
            <ul className="small grid gap-2">
              {r.pendingDecisions.list.map((p) => <li key={p.approvalRequestId ?? p.applicationId ?? p.label} className="border-t border-line pt-2 first:border-t-0 first:pt-0">{p.label} · waiting {days(p.days)}</li>)}
            </ul>
          ) : <p className="small muted">Nothing is waiting on you.</p>}
          {r.pendingDecisions.count && talentHref ? <div className="mt-2">{talent("Decide now")}</div> : null}
        </Card>

        <Card title="What the assistant suggested, and what you decided" className={WIDE}>
          {r.recommendationsVsDecisions.rows.length ? (
            <Table head={["Suggestion", numHead("Candidates"), numHead("Invited to the AI interview"), numHead("Moved to interview"), numHead("Longlist or shortlist"), numHead("Not moving forward"), numHead("Put on hold"), numHead("No decision yet")]} label="Suggestions and decisions" pinFirst wrapHeads>
              {r.recommendationsVsDecisions.rows.map((x) => <tr key={x.recommendation}><td>{x.label}</td><td className="num">{x.total}</td><td className="num">{x.invited}</td><td className="num">{x.interviewed}</td><td className="num">{x.shortlisted ?? 0}</td><td className="num">{x.declined}</td><td className="num">{x.held}</td><td className="num">{x.noActionYet}</td></tr>)}
            </Table>
          ) : <p className="small muted">No assessments yet.</p>}
          {/* the count, and "people make every decision", which is never cut; what "the decision" counts is in the disclosure */}
          <p className="small muted mt-3">{r.recommendationsVsDecisions.assessed} {r.recommendationsVsDecisions.assessed === 1 ? "candidate has" : "candidates have"} an assessment. People make every decision; the assistant only suggests.</p>
        </Card>

        <Card title="When you overruled the system">
          <dl className="kv">
            <dt>Kept someone the eligibility rules would have held</dt><dd>{r.overrides.eligibilityOverrides}</dd>
            <dt>Reviewed someone anyway after an eligibility decline</dt><dd>{r.overrides.reviewAnyway}</dd>
            <dt>Put on hold (every hold, ended or not)</dt><dd>{r.overrides.holds}</dd>
            <dt>Assessments you flagged as wrong</dt><dd>{r.overrides.flaggedAssessments}</dd>
          </dl>
          <p className="small muted mt-3">Every one of these is recorded with the person's name and reason, so the system can be checked and improved.</p>
        </Card>

        <Card title="Recruiter help">
          <dl className="kv">
            <dt>Requests for a recruiter</dt><dd>{r.escalations.total}</dd>
            <dt>Still open</dt><dd>{r.escalations.open}</dd>
            <dt>Resolved</dt><dd>{r.escalations.resolved}</dd>
            <dt>Past the promised response time</dt><dd>{r.escalations.overdue}</dd>
            <dt>Typical first response</dt><dd>{r.escalations.medianResponseHours === null ? "no response yet" : `${r.escalations.medianResponseHours} hours`}</dd>
          </dl>
        </Card>

        <Card title="Messages to candidates" needsYou={r.messages.candidatesAffected > 0}>
          <dl className="kv">
            <dt>Sent</dt><dd>{r.messages.sent}</dd>
            <dt>Could not be sent</dt><dd>{r.messages.failed}</dd>
            <dt>Bounced</dt><dd>{r.messages.bounced}</dd>
            <dt>Delivery unknown</dt><dd>{r.messages.unknown}</dd>
            <dt>Waiting to go out</dt><dd>{r.messages.pending}</dd>
          </dl>
          {/* only the case that needs someone: the figures above already say when everyone was reached */}
          {r.messages.candidatesAffected ? <div className="mt-3"><Alert tone="caution">{plural(r.messages.candidatesAffected, "candidate", "candidates")} could not be reached by email. Please reach them another way.</Alert></div> : null}
          {r.messages.candidatesAffected && talentHref ? <div className="mt-2">{talent("Open the people")}</div> : null}
        </Card>

        <Card title="Outcomes">
          <p className="small muted mb-3">{r.outcomes.statement}</p>
          <dl className="kv">
            <dt>Hired</dt><dd>{r.outcomes.hired}</dd>
            <dt>Withdrew</dt><dd>{r.outcomes.withdrew}</dd>
            <dt>You declined</dt><dd>{r.outcomes.declinedByEmployer}</dd>
            <dt>Declined your offer</dt><dd>{r.outcomes.declinedOffer}</dd>
            <dt>Closed without a hire</dt><dd>{r.outcomes.noHire}</dd>
            <dt>In your talent pool</dt><dd>{r.outcomes.talentPool}</dd>
            <dt>Records corrected</dt><dd>{r.outcomes.corrections}</dd>
            {r.outcomes.role ? <><dt>This job</dt><dd>{ROLE_OUTCOME_LABEL[r.outcomes.role.outcome] ?? r.outcomes.role.outcome.replace(/_/g, " ")} · {new Date(r.outcomes.role.recordedAt).toLocaleDateString()}</dd></> : null}
            {!r.outcomes.role && Object.keys(r.outcomes.rolesByOutcome).length ? <><dt>Jobs closed</dt><dd>{Object.entries(r.outcomes.rolesByOutcome).map(([k, n]) => `${ROLE_OUTCOME_LABEL[k] ?? k}: ${n}`).join(" · ")}</dd></> : null}
          </dl>
          {r.outcomes.declineReasons.length ? (
            <div className="mt-4">
              <Table head={["Why candidates were declined", numHead("People")]} label="Decline reasons">
                {r.outcomes.declineReasons.map((d) => <tr key={d.reason}><td>{d.label}</td><td className="num">{d.count}</td></tr>)}
              </Table>
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}

/**
 * A card whose table has many columns spans both columns once there are two, and its table takes the kit's `wrapHeads`
 * (long headings wrap, a figures heading's too), so the table fits the card without scrolling sideways at 1280px. The
 * two columns start at a 56rem container: the job page's column at 1280px (952px) has them, at 1024px (696px) and in the
 * admin's 720px customer drawer the cards stack, so a half-width card never squeezes its label-and-value rows.
 */
const WIDE = "@4xl:col-span-2";

/** Whose figures the definitions speak of: one role's (its Report tab) or every role of a customer (the admin console). */
export type ReportScope = "role" | "customer";

/**
 * What each figure means, in the words the weekly summary uses (docs/16-admin.md keeps the same table), as one closed
 * disclosure at the end of the Report tab (fewer words, 23 Oct 2026). It also holds what the report counts at all and
 * the definitions the cards once carried under their tables ("typical", "average", a day, response time). `scope`
 * "customer" (the admin console's customer report) says "across all roles" where a role's own tab says "this role", and
 * leaves out the must-haves and the AI interview, whose cards are on a role's own tab only.
 */
export function ReportDefinitions({ scope = "role" }: { scope?: ReportScope }) {
  // a role's own words, or "across all roles" for a customer's report
  const roles = (one: string) => (scope === "customer" ? "across all roles" : one);
  return (
    <details className="more">
      <summary>What these figures mean</summary>
      <div className="stack gap-3">
        <p className="small muted">Counts and days only; nothing here ranks or scores a candidate.</p>
        <dl className="glance">
          <dt>Who applied</dt><dd>{`Every application ${roles("to this role")}, by where the person came from (the careers page, a job board's own link, a referral link, email) and by day in your time zone. A person who applies twice counts once.`}</dd>
          <dt>Where everyone is</dt><dd>How many people are at each stage right now (New, Longlist, Shortlist, Interviewing, Cancelled, On hold, Offer, Hired, Not moving forward), grouped into waiting on you, in process, not moving forward, and hired. Cancelled: candidates who cancelled an interview or did not come to one. Someone on hold waits on nobody until the hold ends. Longlist, Shortlist and On hold are your team's private marks; candidates never see them. "Not told yet" counts decisions nobody has told the candidate about.</dd>
          <dt>How long each step takes</dt><dd>For each step: how many people are there now and the longest anyone has been there; how many have finished the step and the typical and average number of days they spent in it. "Typical" is the middle value; "average" adds every stay up and divides. A day is 24 hours from the moment the step changed.</dd>
          <dt>Interviews</dt><dd>Interviews requested (times not yet picked), on the calendar, held, missed by the candidate, cancelled, rescheduled by the candidate, and held but not yet decided.</dd>
          <dt>Decisions waiting for you</dt><dd>Everything only a person can decide: candidates waiting on you, anyone held on an eligibility answer, and approvals nobody has answered.</dd>
          <dt>Suggestions and decisions</dt><dd>What the assistant suggested for each assessed candidate and the first thing a person did afterwards, putting them on the longlist or shortlist included. The assistant never decides.</dd>
          <dt>Overruled</dt><dd>Times a person kept someone the rules would have held, reviewed someone anyway, put someone on hold, or flagged an assessment as wrong.</dd>
          <dt>Recruiter help</dt><dd>{`Your requests for an ITS recruiter ${roles("on this role")}: open, resolved, past the promised response time, and the typical hours until a recruiter picked one up. Response time is clock hours from your request to a recruiter picking it up; the promised time counts business hours only.`}</dd>
          <dt>Messages</dt><dd>{`Emails and texts to candidates ${roles("about this role")}: sent, could not be sent, bounced, delivery unknown, waiting to go out; and how many candidates were affected.`}</dd>
          <dt>Outcomes</dt><dd>What people recorded: hires, withdrawals, declines, offers declined, closed without a hire, and the reasons candidates were declined. Offers happen outside the platform.</dd>
          {/* one role's cards only: the console's customer report has neither, so it defines neither */}
          {scope === "role" ? (
            <>
              <dt>The must-haves</dt><dd>For each must-have, how many applicants' evidence shows it, partly shows it, shows it is not met in their own words, or does not say yet, from the same checked findings as the match score. When most people do not show one, a note asks whether it is stricter than the job needs; nobody is turned down because of it.</dd>
              <dt>The AI interview</dt><dd>How many people were offered it, started it and finished it, the typical time to finish, who chose a person instead, and the questions people chose not to answer. "Typical" is the middle value, from the first answer to sending.</dd>
            </>
          ) : null}
        </dl>
      </div>
    </details>
  );
}
