"use client";

import { useQuery } from "@tanstack/react-query";
import { appPaths, type RoleSummary } from "@ros/contracts";
import { EmptyState, ErrorState, PageHeader, Skeleton } from "@ros/ui";
import { ApiError, api } from "../api/client";
import { listHref, pickedJob } from "../candidates";
import { Link, useNavigate, useParams, useSearchParams } from "../nav";
import { CandidateList } from "./candidates/CandidateList";
import { JobNotFound, useJob } from "./Job";
import { JobHeader } from "./job/JobHeader";

/**
 * Candidates. Under a job (/roles/:id/talent) it is the job's Candidates tab: the job's header and tabs, then its
 * people. From the rail (/talent) it is the same list with a job picker, opening on the first open job.
 */
export function Candidates() {
  const { id } = useParams();
  return id ? <JobCandidates roleId={id} /> : <AllCandidates />;
}

function JobCandidates({ roleId }: { roleId: string }) {
  const role = useJob(roleId);
  if (role.isLoading) return <Skeleton lines={5} />;
  if (role.error instanceof ApiError && role.error.status === 404) return <JobNotFound />;
  if (role.error || !role.data) return <ErrorState message="Could not load this job." onRetry={() => role.refetch()} />;
  return (
    <div className="stack gap-5">
      <JobHeader role={role.data} current="candidates" />
      <CandidateList place={{ kind: "job", roleId }} />
    </div>
  );
}

function AllCandidates() {
  const nav = useNavigate();
  const [search] = useSearchParams();
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles") });
  const jobs = roles.data ?? [];
  const picked = pickedJob(jobs, search.get("job"));
  return (
    <div className="stack gap-5">
      <PageHeader
        title="Candidates"
        className="mb-1"
        sub={picked && jobs.length === 1 ? picked.title : undefined}
        actions={picked && jobs.length > 1 ? (
          <label className="flex items-center gap-2.5 text-[14px] font-medium text-ink-2">
            Job
            <select className="select min-h-10 w-auto max-w-[min(22rem,70vw)] py-1.5" value={picked.id} onChange={(e) => nav(listHref({ kind: "all", roleId: e.target.value }), { replace: true })}>
              {jobs.map((j) => <option key={j.id} value={j.id}>{j.status === "open" ? j.title : `${j.title} (${j.statusLabel})`}</option>)}
            </select>
          </label>
        ) : null}
      />
      {roles.isLoading ? <Skeleton lines={5} /> : roles.error ? <ErrorState message="Could not load your jobs." onRetry={() => roles.refetch()} /> : !picked ? (
        <EmptyState icon="talent" title="No jobs yet" action={<Link to={appPaths.newJob} className="btn primary">Start a hire</Link>} />
      ) : <CandidateList key={picked.id} place={{ kind: "all", roleId: picked.id }} />}
    </div>
  );
}
