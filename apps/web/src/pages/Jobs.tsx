"use client";

import { useQuery } from "@tanstack/react-query";
import { appPaths, type IntakeSessionList, type RoleSummary } from "@ros/contracts";
import { EmptyState, ErrorState, Icon, IconChip, PageHeader, Pill, SectionHeader, Skeleton } from "@ros/ui";
import { api } from "../api/client";
import { DraftRows } from "../components/DraftRows";
import { jobRow } from "../jobs";
import { Link } from "../nav";
import { LINKED_ROW, ROW_TITLE } from "./look";

/**
 * Jobs: every job of the company, newest first, each with its status, when it was published and how many people it has
 * tab by tab; and the drafts not yet published. A job opens on its candidates once it has been published. "Start a
 * hire" leads to the job builder.
 */
export function Jobs() {
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles") });
  const drafts = useQuery({ queryKey: ["intake", "sessions", "all"], queryFn: () => api.get<IntakeSessionList>("/api/v1/intake/sessions") });
  const startHire = <Link to={appPaths.newJob} className="btn primary"><Icon name="plus" />Start a hire</Link>;
  const jobs = roles.data ?? [];
  const sessions = drafts.data?.sessions ?? [];
  return (
    <div className="stack gap-5">
      <PageHeader title="Jobs" actions={startHire} className="mb-3" />
      {roles.isLoading ? <Skeleton lines={4} /> : roles.error || !roles.data ? <ErrorState message="Could not load your jobs." onRetry={() => roles.refetch()} /> : jobs.length === 0 && sessions.length === 0 ? (
        <EmptyState icon="roles" title="No jobs yet" action={startHire} />
      ) : jobs.length ? (
        <ul className="list-card" aria-label="Your jobs">
          {jobs.map((job) => {
            const row = jobRow(job);
            return (
              <li key={row.id} className={LINKED_ROW}>
                <span className="list-row-lead"><IconChip icon="briefcase" /></span>
                <span className="list-row-main">
                  <Link to={row.href} className={ROW_TITLE}>{row.title}</Link>
                  <span className="list-row-meta">{row.facts.map((f) => <span key={f}>{f}</span>)}</span>
                  {row.counts.length ? <span className="list-row-meta tabular-nums">{row.counts.map((c) => <span key={c}>{c}</span>)}</span> : null}
                </span>
                <span className="list-row-end"><Pill size="sm" tone={row.tone}>{row.statusLabel}</Pill></span>
                <Icon name="arrow-right" className="chev max-sm:hidden" />
              </li>
            );
          })}
        </ul>
      ) : null}
      {sessions.length ? (
        <section className="min-w-0">
          <SectionHeader title="Drafts" />
          <DraftRows drafts={sessions} label="Drafts" />
        </section>
      ) : null}
    </div>
  );
}
