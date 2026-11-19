"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { appPaths, type RoleDetail } from "@ros/contracts";
import { Alert, Button, EmptyState, ErrorState, Icon, Skeleton } from "@ros/ui";
import { ApiError, api } from "../api/client";
import { closingDateLine, headerActions, jobTabFrom } from "../jobs";
import { Link, useParams, useSearchParams } from "../nav";
import { toast } from "../toast";
import { JobEditor } from "./job/JobEditor";
import { JobHeader } from "./job/JobHeader";
import { JobRecord } from "./job/JobRecord";
import { KeptWording, LegalCheckCard } from "./job/LegalCheck";
import { ShareTab } from "./job/ShareTab";

/** One job as GET /roles/:id answers it; its three tabs read the same answer. A job that is not there is an answer, not a hiccup: it is not asked again. */
export function useJob(id: string | undefined) {
  return useQuery({
    queryKey: ["role", id],
    queryFn: () => api.get<RoleDetail>(`/api/v1/roles/${id}`),
    enabled: !!id,
    retry: (count, e) => !(e instanceof ApiError && (e.status === 403 || e.status === 404)) && count < 1,
  });
}

/** What a job's pages show when the job is not there. */
export function JobNotFound() {
  return <EmptyState icon="roles" title="We could not find that job" action={<Link to={appPaths.jobs} className="btn primary">Go to Jobs</Link>} />;
}

/**
 * A job's page, /roles/:id: the job's header and tabs, then the Job tab (the record, with one Edit that opens the one
 * editor) or, with `?tab=share`, the Share tab. Its Candidates tab is a page of its own (pages/Candidates.tsx).
 */
export function Job() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const tab = jobTabFrom(search.get("tab"));
  const role = useJob(id);
  if (role.isLoading) return <Skeleton lines={5} />;
  if (role.error instanceof ApiError && role.error.status === 404) return <JobNotFound />;
  if (role.error || !role.data) return <ErrorState message="Could not load this job." onRetry={() => role.refetch()} />;
  return (
    <div className="stack gap-5">
      <JobHeader role={role.data} current={tab} />
      {tab === "share" ? <ShareTab roleId={role.data.id} /> : <JobTab role={role.data} />}
    </div>
  );
}

/**
 * The Job tab: what a draft still needs before it can be published, the record as candidates and the team read it, what
 * the law asks of the ad, and one Edit. Saving says what the fairness check changed by rule.
 */
function JobTab({ role }: { role: RoleDetail }) {
  const [editing, setEditing] = useState(false);
  const [guardChanges, setGuardChanges] = useState<string[]>([]);
  const { edit } = headerActions(role.actions);
  const packet = role.packet;
  return (
    <div className="stack gap-5">
      {role.publish && !role.publish.allowed && role.publish.blockers.length ? (
        <Alert tone="caution">
          <strong>Before this job can be published</strong>
          <ul className="mt-1.5 grid list-disc gap-0.5 pl-[18px]">{role.publish.blockers.map((b) => <li key={b.message}>{b.message}</li>)}</ul>
        </Alert>
      ) : null}
      {guardChanges.length ? (
        <Alert tone="info">
          <strong>Changed on saving</strong>
          <ul className="mt-1.5 grid list-disc gap-0.5 pl-[18px]">{guardChanges.map((g) => <li key={g}>{g}</li>)}</ul>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a href={`/api/v1/roles/${role.id}/preview/page`} target="_blank" rel="noopener noreferrer" className="text-link"><Icon name="eye" size={16} />See the job page<span className="sr-only"> (opens in a new tab)</span></a>
        {edit ? <Button icon="edit" disabled={!edit.allowed || !packet || role.version === null} onClick={() => setEditing(true)}>{edit.label}</Button> : null}
      </div>
      {edit && !edit.allowed && edit.reason ? <p className="small muted">{edit.reason}</p> : null}
      {packet ? <JobRecord wide packet={packet} pay={{ shown: role.payShown, requiredByLaw: role.payRequiredByLaw }} extra={[{ label: "Closing date", value: closingDateLine(role.closingDate) }]} /> : <EmptyState title="This job has no details yet" />}
      {role.legalCheck ? <LegalCheckCard check={role.legalCheck} /> : null}
      <KeptWording flags={role.flags} />
      {editing && packet && role.version !== null ? (
        <JobEditor
          packet={packet}
          target={{ kind: "job", roleId: role.id, baseVersion: role.version, live: role.public }}
          onClose={() => setEditing(false)}
          onSaved={(changes) => {
            setGuardChanges(changes);
            setEditing(false);
            toast("Saved.");
          }}
        />
      ) : null}
    </div>
  );
}
