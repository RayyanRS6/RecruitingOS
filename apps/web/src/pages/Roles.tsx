"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "../nav";
import { Alert, Button, Card, EmptyState, ErrorState, Icon, PageHeader, PipelineBar, Pill, Skeleton } from "@ros/ui";
import { api, type IntakeSessionSummary, type Me, type RoleSummary } from "../api/client";
import { activeCompanyOf } from "../rail";
import { canSeeTalent, canStartHire } from "../roles";
import { roleStatus } from "../role-status";
import { START_HIRE_HREF } from "../start-hire";
import { stageSummary } from "../talent-list";
import { RoomAlert } from "./new-role/StartView";
import { DRAFT_SEEN_BY, mayHireAgain, mayTakeOverDrafts, startHireHref } from "./new-role/rules";
import { useStartDraft } from "./new-role/use-start-draft";

export function Roles() {
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles") });
  // Interviewers hold no application.read: the Talent link would only lead to a refusal, so it is not offered to them.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const company = activeCompanyOf(me.data);
  const myRole = company.role;
  const talent = canSeeTalent(myRole);
  // The API gives an interviewer only the roles they interview for, without applicant counts.
  const interviewer = myRole === "interviewer";
  // role.create: the same people who see "Start a hire" on Today and in the rail; only they reach the job builder.
  const mayStartHire = canStartHire(myRole);
  const startHire = <Link to={START_HIRE_HREF} className="btn primary"><Icon name="plus" />Start a hire</Link>;
  // The roles this person is still drafting (plan C3: a draft is its starter's; owners and admins see every draft).
  const drafts = useQuery({ queryKey: ["intake", "mine"], queryFn: () => api.get<{ sessions: IntakeSessionSummary[] }>("/api/v1/intake/sessions?mine=1"), enabled: mayStartHire });
  // Owners and admins also see the drafts others on the team started, to pick one up (founder decision Q6).
  const seesAllDrafts = mayStartHire && mayTakeOverDrafts(myRole);
  const teamDrafts = useQuery({ queryKey: ["intake", "team"], queryFn: () => api.get<{ sessions: IntakeSessionSummary[] }>("/api/v1/intake/sessions"), enabled: seesAllDrafts });
  const others = (teamDrafts.data?.sessions ?? []).filter((s) => !s.mine);
  // "Hire for this role again" (C14): a new draft from the role's approved version; the pay is asked again.
  const again = useStartDraft();
  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader eyebrow={company.name ?? undefined} title="Roles" sub={interviewer ? "The roles you interview for." : "Every position, what stage the pipeline is in, and what needs you."} actions={mayStartHire ? startHire : null} />
      {again.limit?.room && !again.limit.room.ok ? <RoomAlert room={again.limit.room} ask={again.limit.ask} /> : null}
      {again.problem ? <Alert tone="critical">{again.problem}</Alert> : null}
      {drafts.data?.sessions.length ? (
        <section className="stack" style={{ gap: 8 }} aria-label="Roles you are drafting">
          <h2 style={{ fontSize: 16 }}>Still being drafted</h2>
          <div className="list">
            {drafts.data.sessions.map((s) => (
              <Link key={s.id} to={startHireHref(s.id)} className="list-item">
                <span className="list-item-main">
                  <strong>{s.title ?? "Untitled role"}</strong>
                  <span className="sub">{s.hasDraft ? "Draft written; ask for approval when you are happy with it" : "Still being drafted"} · {DRAFT_SEEN_BY}</span>
                </span>
                <span className="list-item-end"><Pill size="sm">Draft</Pill><Icon name="chevron-right" /></span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      {others.length ? (
        <section className="stack" style={{ gap: 8 }} aria-label="Drafts others on your team started">
          <h2 style={{ fontSize: 16 }}>Drafts on your team</h2>
          <p className="small muted" style={{ margin: 0 }}>Started by others. You can open one to help, or take it over if they are away or have left.</p>
          <div className="list">
            {others.map((s) => (
              <Link key={s.id} to={startHireHref(s.id)} className="list-item">
                <span className="list-item-main">
                  <strong>{s.title ?? "Untitled role"}</strong>
                  <span className="sub">Started by {s.startedBy.name ?? "someone on your team"} · {s.hasDraft ? "draft written" : "still being drafted"} · last changed {new Date(s.updatedAt).toLocaleDateString()}</span>
                </span>
                <span className="list-item-end"><Pill size="sm">Draft</Pill><Icon name="chevron-right" /></span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
      {roles.isLoading ? <Skeleton lines={4} /> : roles.error ? <ErrorState message="Could not load roles." onRetry={() => roles.refetch()} /> : roles.data!.length === 0 ? (
        mayStartHire
          ? <EmptyState icon="roles" title="No roles yet" body="Tell the assistant who you need to hire and it will draft the role for your approval." action={startHire} />
          : interviewer
            ? <EmptyState icon="roles" title="No roles yet" body="When you are put on an interview, its role shows here." />
            : <EmptyState icon="roles" title="No roles yet" body="When someone on your team opens a role, it shows here." />
      ) : (
        <div className="stack">
          {roles.data!.map((r) => {
            const s = roleStatus(r.status);
            return (
              <Card key={r.id} needsYou={r.needsYou > 0 || r.status === "pending_approval"}>
                <div className="card-title">
                  <h2><Link to={`/roles/${r.id}`} style={{ textDecoration: "none", color: "inherit" }}>{r.title}</Link></h2>
                  <div className="row">
                    {r.needsYou > 0 ? <Pill size="sm" tone="caution">{r.needsYou} decision{r.needsYou === 1 ? "" : "s"} waiting</Pill> : null}
                    <Pill size="sm" tone={s.tone}>{s.label}</Pill>
                  </div>
                </div>
                <div className="row small muted tabular" style={{ marginBottom: 10 }}>
                  <span>{r.daysOpen !== null ? `${r.daysOpen} day${r.daysOpen === 1 ? "" : "s"} open` : "Not posted yet"}</span>
                  {r.countsHidden ? null : (
                    <>
                      <span>·</span>
                      <span>{r.counts.total} applicant{r.counts.total === 1 ? "" : "s"}</span>
                      {r.counts.waiting_on_you ? <><span>·</span><span style={{ color: "var(--caution)" }}>{r.counts.waiting_on_you} waiting on you</span></> : null}
                    </>
                  )}
                </div>
                {r.countsHidden ? null : <PipelineBar counts={r.counts} total={r.counts.total} />}
                {!r.countsHidden && stageSummary(r.stageCounts).length ? (
                  <ul className="row small tabular" style={{ listStyle: "none", margin: "10px 0 0", padding: 0, gap: "4px 14px" }} aria-label={`Where the applicants for ${r.title} are`}>
                    {stageSummary(r.stageCounts).map((s) => (
                      <li key={s.id}>{talent ? <Link to={`/roles/${r.id}/talent?ownerStage=${s.id}`}>{s.count} {s.label}</Link> : <span>{s.count} {s.label}</span>}</li>
                    ))}
                  </ul>
                ) : null}
                <div className="row" style={{ marginTop: 12 }}>
                  <Link to={`/roles/${r.id}`} className="btn secondary sm">Open</Link>
                  {talent ? <Link to={`/roles/${r.id}/talent`} className="btn secondary sm">Talent</Link> : null}
                  {mayStartHire && mayHireAgain(r.status) ? <Button size="sm" icon="refresh" loading={again.pendingRoleId === r.id} disabled={again.pending && again.pendingRoleId !== r.id} onClick={() => again.hireAgain(r.id)}>Hire for this role again</Button> : null}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <p className="small muted">Need help deciding what to open next? Bring in a recruiter from any role.</p>
    </div>
  );
}
