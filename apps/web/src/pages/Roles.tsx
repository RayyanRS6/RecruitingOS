"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "../nav";
import { Card, Chip, EmptyState, ErrorState, PipelineBar, Skeleton } from "@ros/ui";
import { api, type Me, type RoleSummary } from "../api/client";
import { canSeeTalent } from "../roles";

const STATUS: Record<string, { label: string; tone: "accent" | "needs" | "neutral" | "good" | "caution" }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending_approval: { label: "Needs your approval", tone: "needs" },
  open: { label: "Open", tone: "accent" },
  paused: { label: "Paused", tone: "caution" },
  filled: { label: "Filled", tone: "good" },
  closed: { label: "Closed", tone: "neutral" },
};

export function Roles() {
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles") });
  // Interviewers hold no application.read: the Talent link would only lead to a refusal, so it is not offered to them.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const talent = canSeeTalent(me.data?.memberships.find((m) => m.companyId === me.data?.activeCompanyId)?.role ?? null);
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <h1>Roles</h1>
          <p>Every position, what stage the pipeline is in, and what needs you.</p>
        </div>
        <Link to="/" className="btn primary">Open a new role</Link>
      </div>
      {roles.isLoading ? <Skeleton lines={4} /> : roles.error ? <ErrorState message="Could not load roles." onRetry={() => roles.refetch()} /> : roles.data!.length === 0 ? (
        <EmptyState title="No roles yet" body="Tell the assistant who you need to hire and it will draft the role for your approval." action={<Link to="/" className="btn primary">Start on Home</Link>} />
      ) : (
        <div className="stack">
          {roles.data!.map((r) => {
            const s = STATUS[r.status] ?? { label: r.status, tone: "neutral" as const };
            return (
              <Card key={r.id} needsYou={r.needsYou > 0 || r.status === "pending_approval"}>
                <div className="card-title">
                  <h2><Link to={`/roles/${r.id}`} style={{ textDecoration: "none", color: "inherit" }}>{r.title}</Link></h2>
                  <div className="row">
                    {r.needsYou > 0 ? <Chip tone="needs">{r.needsYou} decision{r.needsYou === 1 ? "" : "s"} waiting</Chip> : null}
                    <Chip tone={s.tone}>{s.label}</Chip>
                  </div>
                </div>
                <div className="row small muted" style={{ marginBottom: 10 }}>
                  <span>{r.daysOpen !== null ? `${r.daysOpen} day${r.daysOpen === 1 ? "" : "s"} open` : "Not posted yet"}</span>
                  <span>·</span>
                  <span>{r.counts.total} applicant{r.counts.total === 1 ? "" : "s"}</span>
                  {r.counts.waiting_on_you ? <><span>·</span><span style={{ color: "var(--needs-you)" }}>{r.counts.waiting_on_you} waiting on you</span></> : null}
                </div>
                <PipelineBar counts={r.counts} total={r.counts.total} />
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
