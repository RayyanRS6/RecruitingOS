"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "../nav";
import { Alert, Button, EmptyState, ErrorState, Icon, Menu, PageHeader, Pill, Skeleton } from "@ros/ui";
import { api, type IntakeSessionSummary, type Me, type RoleSummary } from "../api/client";
import { activeCompanyOf, jobHref } from "../rail";
import { canSeeTalent, canShareJob, canStartHire } from "../roles";
import { roleStatus } from "../role-status";
import { QUICK_START_HREF, START_HIRE_HREF } from "../start-hire";
import { JOB_FILTERS, JOB_SORTS, type JobRow, type JobSort, type JobsView, approvalsWaitingLabel, jobBadges, jobFilterCounts, jobRowLine, jobsEmpty, jobsSearch, jobsShown, jobsViewFrom, jobsViewKey, offersLinkedIn, titleMatches } from "../jobs-list";
import { linkedInPostHref } from "../linkedin-post";
import { useCompanyCheck } from "../components/use-company-check";
import { useIsClient } from "../components/use-is-client";
import { RoomAlert } from "./new-role/StartView";
import { DRAFT_SEEN_BY, mayHireAgain, mayTakeOverDrafts, startHireHref } from "./new-role/rules";
import { useStartDraft } from "./new-role/use-start-draft";

/**
 * Jobs (Wave S2: the Kanvis dashboard). Status chips with counts (All, Live, Drafts, Paused, Closed), a search by title
 * and four orders (a dropdown chip with the current one ticked, Wave S6), all kept in the address (?status=&sort=&q=) so a link opens the same view. One row per job with
 * small badges (how many to review, how many new, a draft's age, "Not live", "No applicants yet"). A row opens the
 * job's candidates once it has gone live, otherwise the job itself; the other view is one small link away, and a live
 * job offers "Post on LinkedIn" (the Share tab's LinkedIn card) once ITS has checked the company. The jobs still being
 * drafted follow, and the team's drafts (for owners and admins) are one click away.
 */
export function Roles() {
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles") });
  // The rail reads the same ["roles"] list, so the browser may hold it before it takes the server's drawing over: the
  // list is drawn only once the page is the browser's own, so the first draw matches the server's (Wave S2, K6).
  const isClient = useIsClient();
  const list = isClient ? roles.data : undefined;
  const check = useCompanyCheck();
  // Interviewers hold no application.read: the Candidates link would only lead to a refusal, so it is not offered to them.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const company = activeCompanyOf(me.data);
  const myRole = company.role;
  const talent = canSeeTalent(myRole);
  // The API gives an interviewer only the roles they interview for, without applicant counts.
  const interviewer = myRole === "interviewer";
  // role.create: the same people who see "Start a hire" on Home and in the rail; only they reach the job builder.
  const mayStartHire = canStartHire(myRole);
  // "Post on LinkedIn" leads to the Share tab, for those who may share the job, once ITS has checked the company (the
  // Share tab's own rule for the post).
  const mayShare = canShareJob(myRole) && check !== "waiting";
  const startHire = <Link to={START_HIRE_HREF} className="btn primary"><Icon name="plus" />Start a hire</Link>;
  // The roles this person is still drafting (plan C3: a draft is its starter's; owners and admins see every draft).
  const drafts = useQuery({ queryKey: ["intake", "mine"], queryFn: () => api.get<{ sessions: IntakeSessionSummary[] }>("/api/v1/intake/sessions?mine=1"), enabled: mayStartHire });
  // Owners and admins also see the drafts others on the team started, to pick one up (founder decision Q6).
  const seesAllDrafts = mayStartHire && mayTakeOverDrafts(myRole);
  const teamDrafts = useQuery({ queryKey: ["intake", "team"], queryFn: () => api.get<{ sessions: IntakeSessionSummary[] }>("/api/v1/intake/sessions"), enabled: seesAllDrafts });
  // "Hire for this job again" (C14): a new draft from the role's approved version; the pay is asked again.
  const again = useStartDraft();

  // The view (status chip, order, search) lives in the address. Typing writes it with history.replaceState, which the
  // router follows without fetching the page again; a link that changes the address (the rail's Jobs) resets the view.
  const [search] = useSearchParams();
  const urlKey = jobsViewKey(search);
  const [view, setViewState] = useState<JobsView>(() => jobsViewFrom(search));
  const wrote = useRef(urlKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of the address's view re-reads it
  useEffect(() => {
    if (urlKey === wrote.current) return;
    wrote.current = urlKey;
    setViewState(jobsViewFrom(search));
  }, [urlKey]);
  const setView = (patch: Partial<JobsView>) => {
    const next = { ...view, ...patch };
    setViewState(next);
    const qs = jobsSearch(next, search);
    wrote.current = jobsViewKey(new URLSearchParams(qs));
    try {
      window.history.replaceState(null, "", `${window.location.pathname}${qs}${window.location.hash}`);
    } catch {
      // the view still changes on screen; only the address is not updated
    }
  };

  const all: Array<RoleSummary & JobRow> = list ?? [];
  const shown = jobsShown(all, view);
  const mine = isClient ? (drafts.data?.sessions ?? []).filter((s) => titleMatches(s.title ?? "Untitled job", view.q)) : [];
  const others = isClient ? (teamDrafts.data?.sessions ?? []).filter((s) => !s.mine && titleMatches(s.title ?? "Untitled job", view.q)) : [];
  const counts = jobFilterCounts(all, view.q);
  // The jobs still being drafted are drafts too, so the Drafts chip counts them, and so does All, which lists them.
  counts.drafts += mine.length;
  counts.all += mine.length;
  const showDrafts = view.status === "all" || view.status === "drafts";
  const empty = jobsEmpty(view, { mayStartHire });
  // An empty Live or Drafts view offers the quick questions, the quickest way to a new job.
  const quickStart = <Link to={QUICK_START_HREF} className="btn primary"><Icon name="plus" />Answer a few quick questions</Link>;
  const emptyAction = empty.action === "start" ? quickStart : empty.action === "clear" ? <Button onClick={() => setView({ q: "" })}>Clear search</Button> : <Button onClick={() => setView({ status: "all" })}>Show all jobs</Button>;
  // The chips, search and order only once there is a job to sort; "No jobs yet" stands alone.
  const hasAny = all.length > 0;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader eyebrow={company.name ?? undefined} title="Jobs" sub={interviewer ? "The jobs you interview for." : "Open a job to see who applied."} actions={mayStartHire ? startHire : null} />
      {again.limit?.room && !again.limit.room.ok ? <RoomAlert room={again.limit.room} ask={again.limit.ask} /> : null}
      {again.problem ? <Alert tone="critical">{again.problem}</Alert> : null}
      {list && hasAny ? (
        <div className="talent-toolbar">
          <fieldset aria-label="Show jobs" className="row" style={{ gap: 6, flexWrap: "wrap", border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {JOB_FILTERS.map((f) => (
              <button key={f.id} type="button" className="toggle-chip" aria-pressed={view.status === f.id} onClick={() => setView({ status: f.id })}>
                {f.label} <span className="count">{counts[f.id]}</span>
              </button>
            ))}
          </fieldset>
          <input className="input talent-search" type="search" value={view.q} onChange={(e) => setView({ q: e.target.value })} placeholder="Search by title" maxLength={200} aria-label="Search jobs by title" />
          {/* The order as a dropdown chip (Wave S6): the current order is written on it and ticked in its list. */}
          <Menu
            label={`Sort: ${JOB_SORTS.find((s) => s.id === view.sort)?.label ?? JOB_SORTS[0].label}`}
            heading="Sort jobs by"
            buttonClassName="toggle-chip"
            currentLabel="Now"
            align="end"
            items={JOB_SORTS.map((s) => ({ id: s.id, label: s.label, current: s.id === view.sort }))}
            onSelect={(id) => setView({ sort: id as JobSort })}
          />
        </div>
      ) : null}
      {!isClient || roles.isLoading ? <Skeleton lines={4} /> : roles.error || !list ? <ErrorState message="Could not load your jobs." onRetry={() => roles.refetch()} /> : list.length === 0 ? (
        mayStartHire
          ? <EmptyState icon="roles" title="No jobs yet" body="Tell the assistant who you need. It drafts the job for your approval." action={startHire} />
          : interviewer
            ? <EmptyState icon="roles" title="No jobs yet" body="When you are put on an interview, its job shows here." />
            : <EmptyState icon="roles" title="No jobs yet" body="When someone on your team opens a job, it shows here." />
      ) : shown.length === 0 ? (
        // An empty filter says so, with one way on; the drafts below fill the Drafts view when there are some.
        view.status === "drafts" && !view.q.trim() && mine.length ? null : <EmptyState icon="roles" title={empty.title} body={empty.body} action={emptyAction} />
      ) : (
        <ul className="list" aria-label="Your jobs" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {shown.map((r) => {
            const s = roleStatus(r.status);
            // the same rule as the rail and Home: a job that has gone live opens on its Candidates
            const primary = jobHref(r, { talent });
            const toCandidates = primary.endsWith("/talent");
            const badges = jobBadges(r);
            // a draft's badge already says "Draft" (with its age), and "Not live" already says it waits, so the status
            // pill would only repeat them; under the Live chip every row is live, so "Live" is not repeated either
            const statusShown = !badges.some((b) => b.key === "draft" || b.key === "not-live") && !(view.status === "live" && r.status === "open");
            const other = toCandidates
              ? <Link to={`/roles/${r.id}`} className="small">Job details<span className="sr-only">: {r.title}</span></Link>
              : talent ? <Link to={`/roles/${r.id}/talent`} className="small">Candidates<span className="sr-only">: {r.title}</span></Link> : null;
            return (
              <li key={r.id} className="list-item">
                <span className="list-item-main">
                  {/* the title opens the job: its candidates once it has gone live */}
                  <Link to={primary} style={{ textDecoration: "none", color: "inherit" }}><strong>{r.title}</strong></Link>
                  {/* the other view of the job is a small link in the row's line, not another control at its end */}
                  <span className="sub tabular">{jobRowLine(r)}{other ? <> · {other}</> : null}</span>
                </span>
                <span className="list-item-end">
                  {badges.map((b) => (
                    <Pill key={b.key} size="sm" tone={b.tone} dot={false}>
                      {b.spoken ? <><span aria-hidden="true">{b.label}</span><span className="sr-only">{b.spoken}</span></> : b.label}
                    </Pill>
                  ))}
                  {r.needsYou > 0 ? <Pill size="sm" tone="caution">{approvalsWaitingLabel(r.needsYou)}</Pill> : null}
                  {statusShown ? <Pill size="sm" tone={s.tone}>{s.label}</Pill> : null}
                  {mayShare && offersLinkedIn(r.status) ? <Link to={linkedInPostHref(r.id)} className="btn secondary sm"><Icon name="share" />Post on LinkedIn<span className="sr-only">: {r.title}</span></Link> : null}
                  {mayStartHire && mayHireAgain(r.status) ? <Button size="sm" icon="refresh" loading={again.pendingRoleId === r.id} disabled={again.pending && again.pendingRoleId !== r.id} onClick={() => again.hireAgain(r.id)}>Hire for this job again</Button> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {showDrafts && mine.length ? (
        <section className="stack" style={{ gap: 8 }} aria-label="Jobs you are drafting">
          <h2 style={{ fontSize: 16 }}>Still being drafted</h2>
          <div className="list">
            {mine.map((s) => (
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
      {showDrafts && others.length ? (
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
