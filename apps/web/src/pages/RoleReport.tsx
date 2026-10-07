"use client";

import { useQuery } from "@tanstack/react-query";
import { Alert, Card, EmptyState, ErrorState, OWNER_STAGES, PipelineBar, Pill, Skeleton, Table } from "@ros/ui";
import { Link } from "../nav";
import { api } from "../api/client";

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
};

const GROUP_LABEL: Record<string, string> = { waiting_on_you: "Waiting on you", in_process: "In process", not_moving_forward: "Not moving forward", hired: "Hired" };
const ROLE_OUTCOME_LABEL: Record<string, string> = { filled: "Filled", filled_outside_platform: "Filled outside the platform", role_cancelled: "Cancelled", no_hire: "Closed without a hire", voided: "Recorded in error" };

const days = (n: number | null) => (n === null ? "none yet" : n === 1 ? "1 day" : `${n} days`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The Report tab: the ten figures for one role, and the two downloads. */
export function ReportTab({ roleId }: { roleId: string }) {
  const q = useQuery({ queryKey: ["role", roleId, "report"], queryFn: () => api.get<RoleReport>(`/api/v1/roles/${roleId}/report`) });
  if (q.isLoading) return <Skeleton lines={6} />;
  if (q.error || !q.data) return <ErrorState message="Could not load the report." onRetry={() => q.refetch()} />;
  const r = q.data;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <p className="small muted">Figures as of {new Date(r.generatedAt).toLocaleString()}. Counts and days only; nothing here ranks or scores a candidate.</p>
        <div className="row">
          <a className="btn secondary sm" href={`/api/v1/roles/${roleId}/report.csv`} download>Download the applicant list (CSV)</a>
          <a className="btn secondary sm" href={`/api/v1/roles/${roleId}/report/summary.csv`} download>Download the summary (CSV)</a>
        </div>
      </div>
      {r.applicants.total === 0 ? <EmptyState title="No applicants yet" body="The figures fill in as people apply. The downloads work now; they will be mostly empty." /> : null}
      <ReportFigures report={r} talentHref={`/roles/${roleId}/talent`} />
      <ReportDefinitions />
    </div>
  );
}

/** The ten figures as plain-language cards. Used by the role page and by the administrator's customer view (no links there). */
export function ReportFigures({ report: r, talentHref }: { report: RoleReport; talentHref?: string }) {
  const maxDay = Math.max(0, ...r.applicants.byDay.map((d) => d.count));
  const talent = (label: string, query = "") => (talentHref ? <Link to={`${talentHref}${query}`} className="btn quiet sm">{label}</Link> : null);
  return (
    <div className="grid-2">
      <Card title="Who applied">
        <div className="row" style={{ gap: 24 }}>
          <Stat n={r.applicants.total} label={r.applicants.total === 1 ? "applicant in total" : "applicants in total"} />
          <Stat n={r.applicants.last30Days} label="in the last 30 days" />
        </div>
        <div className="row" style={{ gap: 2, alignItems: "flex-end", height: 40, marginTop: 10 }} role="img" aria-label={`Applicants per day over the last 30 days: ${r.applicants.byDay.filter((d) => d.count).map((d) => `${d.day} ${d.count}`).join(", ") || "none"}`}>
          {r.applicants.byDay.map((d) => <span key={d.day} title={`${d.day}: ${d.count}`} style={{ flex: 1, minWidth: 3, height: `${maxDay ? Math.max(4, (d.count / maxDay) * 100) : 4}%`, background: d.count ? "var(--ink-2)" : "var(--line)", borderRadius: 2 }} />)}
        </div>
        <p className="small muted" style={{ margin: "4px 0 10px" }}>One bar per day, oldest on the left, days in {r.applicants.timeZone}.</p>
        {r.applicants.bySource.length ? (
          <Table head={["Where from", "Detail", "Applicants"]} label="Applicants by source">
            {r.applicants.bySource.map((s) => <tr key={`${s.source}:${s.sourceDetail ?? ""}`}><td>{s.label}</td><td className="small muted">{s.sourceDetail ?? ""}</td><td>{s.count}</td></tr>)}
          </Table>
        ) : <p className="small muted">Nobody yet.</p>}
      </Card>

      <Card title="Where everyone is">
        <PipelineBar counts={r.stages.byGroup} total={r.stages.total} />
        <div className="row" style={{ marginTop: 8 }}>
          {(["waiting_on_you", "in_process", "not_moving_forward", "hired"] as const).map((g) => <Pill key={g} size="sm" tone={g === "waiting_on_you" ? "caution" : g === "hired" ? "good" : g === "in_process" ? "accent" : "neutral"}>{GROUP_LABEL[g]}: <span className="tabular">{r.stages.byGroup[g] ?? 0}</span></Pill>)}
        </div>
        {r.stages.byOwnerStage ? (
          <div style={{ marginTop: 10 }}>
            <Table head={["Stage", "People"]} label="People by stage">
              {OWNER_STAGES.map((s) => <tr key={s.id}><td>{talentHref && (r.stages.byOwnerStage?.[s.id] ?? 0) > 0 ? <Link to={`${talentHref}?ownerStage=${s.id}`}>{s.label}</Link> : s.label}</td><td>{r.stages.byOwnerStage?.[s.id] ?? 0}</td></tr>)}
            </Table>
          </div>
        ) : null}
        {r.stages.marks || r.stages.told ? (
          <dl className="kv" style={{ marginTop: 10 }}>
            {r.stages.marks ? <><dt>Holds that have ended</dt><dd>{r.stages.marks.holdsEnded}</dd></> : null}
            {r.stages.marks?.notAFitForNow ? <><dt>Set aside as not a fit for now</dt><dd>{r.stages.marks.notAFitForNow}</dd></> : null}
            {r.stages.told ? <><dt>Decisions not told yet</dt><dd>{r.stages.told.notTold}</dd><dt>Told by message</dt><dd>{r.stages.told.sent}{r.stages.told.queued ? ` (${r.stages.told.queued} on the way)` : ""}</dd><dt>Told in person</dt><dd>{r.stages.told.toldInPerson}</dd></> : null}
            {r.stages.told?.beforeTracking ? <><dt>Decided before decisions were private (shown on their status page)</dt><dd>{r.stages.told.beforeTracking}</dd></> : null}
          </dl>
        ) : null}
        {r.stages.byStage.length ? (
          <details style={{ marginTop: 10 }}>
            <summary className="small">The steps underneath</summary>
            <div style={{ marginTop: 8 }}>
              <Table head={["Step", "People"]} label="People by step">
                {r.stages.byStage.map((s) => <tr key={s.stage}><td>{s.label} <span className="small muted">({GROUP_LABEL[s.group] ?? s.group})</span></td><td>{s.count}</td></tr>)}
              </Table>
            </div>
          </details>
        ) : null}
        <div className="row">
          {talent("See the people")}
          {r.stages.told?.notTold ? talent("Tell them your decision", "?ownerStage=not_moving_forward&told=not_told") : null}
        </div>
      </Card>

      <Card title="How long each step takes">
        <p className="small" style={{ color: "var(--ink-2)" }}>
          <strong>{plural(r.timeInStage.waitingOnYou.count, "candidate is", "candidates are")} waiting on you</strong>
          {r.timeInStage.waitingOnYou.count ? ` · typical wait ${days(r.timeInStage.waitingOnYou.medianDays)} · longest ${days(r.timeInStage.waitingOnYou.longestDays)}` : ""}.
        </p>
        {r.timeInStage.byStage.length ? (
          <Table head={["Step", "There now", "Longest so far", "Finished this step", "Typical stay", "Average stay"]} label="Time in each step">
            {r.timeInStage.byStage.map((s) => <tr key={s.stage}><td>{s.label}</td><td>{s.nowHere}</td><td>{s.nowHere ? days(s.longestDays) : ""}</td><td>{s.completed}</td><td>{s.completed ? days(s.medianDays) : ""}</td><td>{s.completed ? days(s.averageDays) : ""}</td></tr>)}
          </Table>
        ) : <p className="small muted">Nothing has moved yet.</p>}
        <p className="small muted" style={{ marginTop: 8 }}>"Typical" is the middle value; "average" adds every stay up and divides. A day is 24 hours from the moment the step changed.</p>
      </Card>

      <Card title="Interviews">
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
          <div style={{ marginTop: 10 }}>
            <Table head={["Round", "All", "On the calendar", "Held", "Candidate did not show", "Interviewer did not show", "Cancelled"]} label="Interviews by round">
              {r.interviews.byRound.map((x) => <tr key={x.roundKey}><td>{x.title}</td><td>{x.total}</td><td>{x.scheduled}</td><td>{x.completed}</td><td>{x.noShowCandidate}</td><td>{x.noShowInterviewer}</td><td>{x.cancelled}</td></tr>)}
            </Table>
          </div>
        ) : null}
      </Card>

      <Card title="Decisions waiting for you" needsYou={r.pendingDecisions.count > 0}>
        <div className="row" style={{ gap: 24 }}>
          <Stat n={r.pendingDecisions.count} label={r.pendingDecisions.count === 1 ? "decision only a person can make" : "decisions only a person can make"} />
          {r.pendingDecisions.oldestDays !== null ? <Stat n={r.pendingDecisions.oldestDays} label="days the oldest has waited" /> : null}
        </div>
        <p className="small muted" style={{ margin: "6px 0" }}>{r.pendingDecisions.candidates} {r.pendingDecisions.candidates === 1 ? "candidate" : "candidates"} waiting on you (including anyone held on an eligibility answer) and {r.pendingDecisions.approvals} {r.pendingDecisions.approvals === 1 ? "approval" : "approvals"} pending.</p>
        {r.pendingDecisions.list.length ? (
          <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
            {r.pendingDecisions.list.map((p) => <li key={p.approvalRequestId ?? p.applicationId ?? p.label}>{p.label} · waiting {days(p.days)}</li>)}
          </ul>
        ) : <p className="small muted">Nothing is waiting on you.</p>}
        {r.pendingDecisions.count ? talent("Decide now") : null}
      </Card>

      <Card title="What the assistant suggested, and what you decided">
        {r.recommendationsVsDecisions.rows.length ? (
          <Table head={["Suggestion", "Candidates", "Invited to a screen", "Moved to interview", "Longlist or shortlist", "Not moving forward", "Put on hold", "No decision yet"]} label="Suggestions and decisions">
            {r.recommendationsVsDecisions.rows.map((x) => <tr key={x.recommendation}><td>{x.label}</td><td>{x.total}</td><td>{x.invited}</td><td>{x.interviewed}</td><td>{x.shortlisted ?? 0}</td><td>{x.declined}</td><td>{x.held}</td><td>{x.noActionYet}</td></tr>)}
          </Table>
        ) : <p className="small muted">No assessments yet.</p>}
        <p className="small muted" style={{ marginTop: 8 }}>{r.recommendationsVsDecisions.assessed} {r.recommendationsVsDecisions.assessed === 1 ? "candidate has" : "candidates have"} an assessment. The decision counted is the first thing a person did after the suggestion. People make every decision; the assistant only suggests.</p>
      </Card>

      <Card title="When you overruled the system">
        <dl className="kv">
          <dt>Kept someone the eligibility rules would have held</dt><dd>{r.overrides.eligibilityOverrides}</dd>
          <dt>Reviewed someone anyway after an eligibility decline</dt><dd>{r.overrides.reviewAnyway}</dd>
          <dt>Put on hold (every hold, ended or not)</dt><dd>{r.overrides.holds}</dd>
          <dt>Assessments you flagged as wrong</dt><dd>{r.overrides.flaggedAssessments}</dd>
        </dl>
        <p className="small muted" style={{ marginTop: 8 }}>Every one of these is recorded with the person's name and reason, so the system can be checked and improved.</p>
      </Card>

      <Card title="Recruiter help">
        <dl className="kv">
          <dt>Requests for a recruiter</dt><dd>{r.escalations.total}</dd>
          <dt>Still open</dt><dd>{r.escalations.open}</dd>
          <dt>Resolved</dt><dd>{r.escalations.resolved}</dd>
          <dt>Past the promised response time</dt><dd>{r.escalations.overdue}</dd>
          <dt>Typical first response</dt><dd>{r.escalations.medianResponseHours === null ? "no response yet" : `${r.escalations.medianResponseHours} hours`}</dd>
        </dl>
        <p className="small muted" style={{ marginTop: 8 }}>Response time is clock hours from your request to a recruiter picking it up; the promised time counts business hours only.</p>
      </Card>

      <Card title="Messages to candidates" needsYou={r.messages.candidatesAffected > 0}>
        <dl className="kv">
          <dt>Sent</dt><dd>{r.messages.sent}</dd>
          <dt>Could not be sent</dt><dd>{r.messages.failed}</dd>
          <dt>Bounced</dt><dd>{r.messages.bounced}</dd>
          <dt>Delivery unknown</dt><dd>{r.messages.unknown}</dd>
          <dt>Waiting to go out</dt><dd>{r.messages.pending}</dd>
        </dl>
        {r.messages.candidatesAffected ? <Alert tone="caution">{plural(r.messages.candidatesAffected, "candidate", "candidates")} could not be reached by email. Please reach them another way.</Alert> : <p className="small muted" style={{ marginTop: 8 }}>Everyone we tried to reach was reachable.</p>}
        {r.messages.candidatesAffected ? talent("Open the people") : null}
      </Card>

      <Card title="Outcomes">
        <p className="small muted" style={{ marginBottom: 8 }}>{r.outcomes.statement}</p>
        <dl className="kv">
          <dt>Hired</dt><dd>{r.outcomes.hired}</dd>
          <dt>Withdrew</dt><dd>{r.outcomes.withdrew}</dd>
          <dt>You declined</dt><dd>{r.outcomes.declinedByEmployer}</dd>
          <dt>Declined your offer</dt><dd>{r.outcomes.declinedOffer}</dd>
          <dt>Closed without a hire</dt><dd>{r.outcomes.noHire}</dd>
          <dt>In your talent pool</dt><dd>{r.outcomes.talentPool}</dd>
          <dt>Records corrected</dt><dd>{r.outcomes.corrections}</dd>
          {r.outcomes.role ? <><dt>This role</dt><dd>{ROLE_OUTCOME_LABEL[r.outcomes.role.outcome] ?? r.outcomes.role.outcome.replace(/_/g, " ")} · {new Date(r.outcomes.role.recordedAt).toLocaleDateString()}</dd></> : null}
          {!r.outcomes.role && Object.keys(r.outcomes.rolesByOutcome).length ? <><dt>Roles closed</dt><dd>{Object.entries(r.outcomes.rolesByOutcome).map(([k, n]) => `${ROLE_OUTCOME_LABEL[k] ?? k}: ${n}`).join(" · ")}</dd></> : null}
        </dl>
        {r.outcomes.declineReasons.length ? (
          <div style={{ marginTop: 10 }}>
            <Table head={["Why candidates were declined", "People"]} label="Decline reasons">
              {r.outcomes.declineReasons.map((d) => <tr key={d.reason}><td>{d.label}</td><td>{d.count}</td></tr>)}
            </Table>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <div style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.1 }}>{n}</div>
      <div className="small muted">{label}</div>
    </div>
  );
}

/** What each figure means, in the words the weekly summary uses (docs/16-admin.md keeps the same table). */
export function ReportDefinitions() {
  return (
    <Card title="What these figures mean">
      <dl className="kv">
        <dt>Who applied</dt><dd>Every application to this role, by where the person came from (the careers page, a job board's own link, a referral link, email) and by day in your time zone. A person who applies twice counts once.</dd>
        <dt>Where everyone is</dt><dd>How many people are at each stage right now (New, Longlist, Shortlist, Interviewing, On hold, Offer, Hired, Not moving forward), grouped into waiting on you, in process, not moving forward, and hired. Someone on hold waits on nobody until the hold ends. Longlist, Shortlist and On hold are your team's private marks; candidates never see them. "Not told yet" counts decisions nobody has told the candidate about.</dd>
        <dt>How long each step takes</dt><dd>For each step: how many people are there now and the longest anyone has been there; how many have finished the step and the typical and average number of days they spent in it.</dd>
        <dt>Interviews</dt><dd>Interviews requested (times not yet picked), on the calendar, held, missed by the candidate, cancelled, rescheduled by the candidate, and held but not yet decided.</dd>
        <dt>Decisions waiting for you</dt><dd>Everything only a person can decide: candidates waiting on you, anyone held on an eligibility answer, and approvals nobody has answered.</dd>
        <dt>Suggestions and decisions</dt><dd>What the assistant suggested for each assessed candidate and the first thing a person did afterwards, putting them on the longlist or shortlist included. The assistant never decides.</dd>
        <dt>Overruled</dt><dd>Times a person kept someone the rules would have held, reviewed someone anyway, put someone on hold, or flagged an assessment as wrong.</dd>
        <dt>Recruiter help</dt><dd>Your requests for an ITS recruiter on this role: open, resolved, past the promised response time, and the typical hours until a recruiter picked one up.</dd>
        <dt>Messages</dt><dd>Emails and texts to candidates about this role: sent, could not be sent, bounced, delivery unknown, waiting to go out; and how many candidates were affected.</dd>
        <dt>Outcomes</dt><dd>What people recorded: hires, withdrawals, declines, offers declined, closed without a hire, and the reasons candidates were declined. Offers happen outside the platform.</dd>
      </dl>
    </Card>
  );
}
