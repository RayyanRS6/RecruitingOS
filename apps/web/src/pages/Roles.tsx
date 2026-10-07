"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "../nav";
import { Card, EmptyState, ErrorState, Icon, PageHeader, PipelineBar, Pill, Skeleton } from "@ros/ui";
import { api, type Me, type RoleSummary } from "../api/client";
import { activeCompanyOf } from "../rail";
import { canSeeTalent, canStartHire } from "../roles";
import { roleStatus } from "../role-status";
import { START_HIRE_HREF } from "../start-hire";

export function Roles() {
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles") });
  // Interviewers hold no application.read: the Talent link would only lead to a refusal, so it is not offered to them.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const company = activeCompanyOf(me.data);
  const myRole = company.role;
  const talent = canSeeTalent(myRole);
  // The API gives an interviewer only the roles they interview for, without applicant counts.
  const interviewer = myRole === "interviewer";
  // role.create: the same people who see "Start a hire" on Today and in the rail.
  const mayStartHire = canStartHire(myRole);
  const startHire = <Link to={START_HIRE_HREF} className="btn primary"><Icon name="plus" />Start a hire</Link>;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader eyebrow={company.name ?? undefined} title="Roles" sub={interviewer ? "The roles you interview for." : "Every position, what stage the pipeline is in, and what needs you."} actions={mayStartHire ? startHire : null} />
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
                <div className="row" style={{ marginTop: 12 }}>
                  <Link to={`/roles/${r.id}`} className="btn secondary sm">Open</Link>
                  {talent ? <Link to={`/roles/${r.id}/talent`} className="btn secondary sm">Talent</Link> : null}
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
