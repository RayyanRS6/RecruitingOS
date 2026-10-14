"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "../nav";
import { Alert, Button, EmptyState, ErrorState, Icon, PageHeader, Pill, Skeleton } from "@ros/ui";
import { api, type IntakeSessionSummary, type Me, type RoleSummary } from "../api/client";
import { activeCompanyOf, jobHref } from "../rail";
import { canSeeTalent, canStartHire } from "../roles";
import { roleStatus } from "../role-status";
import { START_HIRE_HREF } from "../start-hire";
import { jobCardFacts } from "../talent-list";
import { RoomAlert } from "./new-role/StartView";
import { DRAFT_SEEN_BY, mayHireAgain, mayTakeOverDrafts, startHireHref } from "./new-role/rules";
import { useStartDraft } from "./new-role/use-start-draft";

/**
 * Jobs (Wave S1: simple, Kanvis-like): one row per job with its status, how many are new and how many applied. A row
 * opens the job's candidates once it has gone live, otherwise the job itself; the other view is one small link away.
 * The jobs still being drafted follow, and the team's drafts (for owners and admins) are one click away.
 */
export function Roles() {
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles") });
  // Interviewers hold no application.read: the Candidates link would only lead to a refusal, so it is not offered to them.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const company = activeCompanyOf(me.data);
  const myRole = company.role;
  const talent = canSeeTalent(myRole);
  // The API gives an interviewer only the roles they interview for, without applicant counts.
  const interviewer = myRole === "interviewer";
  // role.create: the same people who see "Start a hire" on Home and in the rail; only they reach the job builder.
  const mayStartHire = canStartHire(myRole);
  const startHire = <Link to={START_HIRE_HREF} className="btn primary"><Icon name="plus" />Start a hire</Link>;
  // The roles this person is still drafting (plan C3: a draft is its starter's; owners and admins see every draft).
  const drafts = useQuery({ queryKey: ["intake", "mine"], queryFn: () => api.get<{ sessions: IntakeSessionSummary[] }>("/api/v1/intake/sessions?mine=1"), enabled: mayStartHire });
  // Owners and admins also see the drafts others on the team started, to pick one up (founder decision Q6).
  const seesAllDrafts = mayStartHire && mayTakeOverDrafts(myRole);
  const teamDrafts = useQuery({ queryKey: ["intake", "team"], queryFn: () => api.get<{ sessions: IntakeSessionSummary[] }>("/api/v1/intake/sessions"), enabled: seesAllDrafts });
  const others = (teamDrafts.data?.sessions ?? []).filter((s) => !s.mine);
  // "Hire for this job again" (C14): a new draft from the role's approved version; the pay is asked again.
  const again = useStartDraft();
  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader eyebrow={company.name ?? undefined} title="Jobs" sub={interviewer ? "The jobs you interview for." : "Open a job to see who applied."} actions={mayStartHire ? startHire : null} />
      {again.limit?.room && !again.limit.room.ok ? <RoomAlert room={again.limit.room} ask={again.limit.ask} /> : null}
      {again.problem ? <Alert tone="critical">{again.problem}</Alert> : null}
      {roles.isLoading ? <Skeleton lines={4} /> : roles.error ? <ErrorState message="Could not load your jobs." onRetry={() => roles.refetch()} /> : roles.data!.length === 0 ? (
        mayStartHire
          ? <EmptyState icon="roles" title="No jobs yet" body="Tell the assistant who you need. It drafts the job for your approval." action={startHire} />
          : interviewer
            ? <EmptyState icon="roles" title="No jobs yet" body="When you are put on an interview, its job shows here." />
            : <EmptyState icon="roles" title="No jobs yet" body="When someone on your team opens a job, it shows here." />
      ) : (
        <ul className="list" aria-label="Your jobs" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {roles.data!.map((r) => {
            const s = roleStatus(r.status);
            // the same rule as the rail and Home: a job that has gone live opens on its Candidates
            const primary = jobHref(r, { talent });
            const toCandidates = primary.endsWith("/talent");
            return (
              <li key={r.id} className="list-item">
                {/* the row's main part opens the job: its candidates once it has gone live */}
                <Link to={primary} className="list-item-main" style={{ textDecoration: "none", color: "inherit" }}>
                  <strong>{r.title}</strong>
                  <span className="sub tabular">{jobCardFacts(r)}</span>
                </Link>
                <span className="list-item-end">
                  {r.needsYou > 0 ? <Pill size="sm" tone="caution">{r.needsYou} decision{r.needsYou === 1 ? "" : "s"} waiting</Pill> : null}
                  <Pill size="sm" tone={s.tone}>{s.label}</Pill>
                  {toCandidates ? <Link to={`/roles/${r.id}`} className="small">Job details<span className="sr-only">: {r.title}</span></Link> : talent ? <Link to={`/roles/${r.id}/talent`} className="small">Candidates<span className="sr-only">: {r.title}</span></Link> : null}
                  {mayStartHire && mayHireAgain(r.status) ? <Button size="sm" icon="refresh" loading={again.pendingRoleId === r.id} disabled={again.pending && again.pendingRoleId !== r.id} onClick={() => again.hireAgain(r.id)}>Hire for this job again</Button> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {drafts.data?.sessions.length ? (
        <section className="stack" style={{ gap: 8 }} aria-label="Jobs you are drafting">
          <h2 style={{ fontSize: 16 }}>Still being drafted</h2>
          <div className="list">
            {drafts.data.sessions.map((s) => (
              <Link key={s.id} to={startHireHref(s.id)} className="list-item">
                <span className="list-item-main">
                  <strong>{s.title ?? "Untitled job"}</strong>
                  <span className="sub">{s.hasDraft ? "Draft written; ask for approval when you are happy" : "Still being drafted"} · {DRAFT_SEEN_BY}</span>
                </span>
                <span className="list-item-end"><Pill size="sm">Draft</Pill><Icon name="chevron-right" /></span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      {others.length ? (
        <details className="more">
          <summary>Drafts on your team ({others.length})</summary>
          <section className="stack" style={{ gap: 8 }} aria-label="Drafts others on your team started">
            <p className="small muted" style={{ margin: 0 }}>Open one to help, or take it over if they are away or have left.</p>
            <div className="list">
              {others.map((s) => (
                <Link key={s.id} to={startHireHref(s.id)} className="list-item">
                  <span className="list-item-main">
                    <strong>{s.title ?? "Untitled job"}</strong>
                    <span className="sub">Started by {s.startedBy.name ?? "someone on your team"} · {s.hasDraft ? "draft written" : "still being drafted"} · last changed {new Date(s.updatedAt).toLocaleDateString()}</span>
                  </span>
                  <span className="list-item-end"><Pill size="sm">Draft</Pill><Icon name="chevron-right" /></span>
                </Link>
              ))}
            </div>
          </section>
        </details>
      ) : null}
      <p className="small muted">Stuck? Bring in a recruiter from any job.</p>
    </div>
  );
}
