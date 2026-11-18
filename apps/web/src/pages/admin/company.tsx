"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AdminCompany, AdminCompanyJobs } from "@ros/contracts";
import { Avatar, Button, Card, Chip, Drawer, ErrorState, numHead, Pill, Table } from "@ros/ui";
import { api } from "../../api/client";
import { shortDay } from "../../dates";
import { focusLost } from "../../focus-after";
import { AccessButtons, FactsLine } from "./access";
import { adminKeys, adminReason } from "./admin-api";
import { exactMoney, exactWhen, money, trialWords, whenWords } from "./admin-words";
import { accessExplained, aiCreditChip, aiCreditDollars, companyDetails, companyStatusTone, declinedWhen, jobStatusTone, planUsage, waitingWords } from "./company-facts";
import { PlanChangeForm, TrialCard } from "./plan";

/**
 * One company (`/admin?open=<id>`): a drawer named by the company with three parts. Its details and where it stands
 * with the one gate, with the decisions the API says it takes now (Accept and Decline, Accept again, or Take away
 * access); its plan with what is used of it, the same AI help in dollars, and Change plan (and the trial, where there
 * is one); and its jobs with their counts. Counts only: nothing here ever names a candidate.
 */
export function CompanyDrawer({ company, onClose }: { company: AdminCompany; onClose: () => void }) {
  const active = company.status === "active";
  return (
    <Drawer open onClose={onClose} size="lg" title={company.name} leading={<Avatar name={company.name} shape="square" letters={1} size="lg" />}>
      {/* A very long name or address breaks anywhere rather than pushing the drawer sideways. Keyed by the company, so
          a form left open for one company never shows for the next. */}
      <div key={company.id} className="stack gap-4 wrap-anywhere">
        <Details company={company} />
        <Plan company={company} />
        {active && company.trial?.started && company.trial.endsAt ? <TrialCard company={company} trial={company.trial} /> : null}
        <Jobs company={company} />
      </div>
    </Drawer>
  );
}

/** Where the company stands, the decisions it takes now, and its details. */
function Details({ company }: { company: AdminCompany }) {
  const box = useRef<HTMLDivElement>(null);
  // A decision swaps the buttons for the next ones (Accept for Take away access): the keyboard's place stays in this card.
  const afterDecided = () => requestAnimationFrame(() => {
    if (focusLost(document.activeElement, document.body)) (box.current?.querySelector<HTMLElement>("button:not(:disabled)") ?? box.current)?.focus();
  });
  const declined = company.status === "declined" ? declinedWhen(company.accessRequest?.declined ?? null) : "";
  return (
    <Card>
      <div ref={box} tabIndex={-1} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 focus:outline-none">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Pill tone={companyStatusTone(company.status)}>{company.statusLabel}</Pill>
          {company.status === "waiting" ? <span className="small muted" title={exactWhen(company.createdAt)}>{waitingWords(company.createdAt)}</span> : null}
          {declined ? <span className="small muted">{declined}</span> : null}
        </span>
        <AccessButtons company={company} onDecided={afterDecided} />
      </div>
      <details className="more mt-3">
        <summary>How this works</summary>
        <p className="small text-ink-2">{accessExplained(company)}</p>
      </details>
      <dl className="glance mt-4">
        {companyDetails(company).flatMap((row) => [<dt key={`${row.label}-label`}>{row.label}</dt>, <dd key={row.label}><FactsLine facts={row.facts} /></dd>])}
        <dt>Last active</dt>
        <dd>{company.lastActivityAt ? <span title={exactWhen(company.lastActivityAt)}>{whenWords(company.lastActivityAt)}</span> : "Never"}</dd>
      </dl>
    </Card>
  );
}

/**
 * The plan: its name, where a trial stands, what is used of each limit in the words the company reads, and the same AI
 * help in dollars, which only an administrator reads. A company that asked to upgrade says so here, in its own words.
 * Change plan is for an accepted company; the API refuses it for a request.
 */
function Plan({ company }: { company: AdminCompany }) {
  const [changing, setChanging] = useState(false);
  const active = company.status === "active";
  const trial = trialWords(company.trial, company.timezone);
  const credit = company.aiCredit ? aiCreditChip(company.aiCredit.level) : null;
  const asked = company.planRequest;
  return (
    <Card title="Plan" aside={active && !changing ? <Button size="sm" onClick={() => setChanging(true)}>Change plan</Button> : null}>
      <div className="grid gap-1.5">
        <p className="text-[15px] text-ink"><strong>{company.planName}</strong>{trial ? <span className="text-ink-2"> · {trial}</span> : null}</p>
        {planUsage(company).map((line) => <p key={line} className="small muted">{line}</p>)}
        {company.aiCredit ? <p className="small muted">{aiCreditDollars(company.aiCredit)}</p> : null}
        <p className="small muted"><span title={exactMoney(company.aiCostUsd)}>{money(company.aiCostUsd)}</span> AI cost in all</p>
        {credit ? <span><Chip tone="caution">{credit}</Chip></span> : null}
      </div>
      {asked ? (
        <div className="mt-4 grid gap-1 rounded-xl border border-line-tint bg-tint px-4 py-3">
          <span><Chip tone="accent">Asked to upgrade</Chip></span>
          <p className="text-sm text-ink">{asked.words}</p>
          <p className="small muted"><span title={exactWhen(asked.since)}>{whenWords(asked.since)}</span>{asked.requestedBy ? ` · ${asked.requestedBy}` : ""}</p>
        </div>
      ) : null}
      {changing ? <div className="mt-4 border-t border-line pt-4"><PlanChangeForm company={company} onDone={() => setChanging(false)} /></div> : null}
    </Card>
  );
}

/**
 * The company's jobs, newest first as the API lists them: title, status, the day it was published, and how many people
 * applied, are shortlisted, were interviewed and were hired, with a link to the job's public page when it has one.
 * Asked for only when the company has a job (GET /admin/customers/:id/jobs). Counts only.
 */
function Jobs({ company }: { company: AdminCompany }) {
  const has = company.jobs.total > 0;
  const q = useQuery({ queryKey: adminKeys.companyJobs(company.id), queryFn: () => api.get<AdminCompanyJobs>(`/api/v1/admin/customers/${encodeURIComponent(company.id)}/jobs`, adminReason("a company's jobs")), enabled: has });
  return (
    <Card title="Jobs">
      {!has ? <p className="small muted">No jobs yet.</p> : q.error ? <ErrorState message="Could not load the jobs." onRetry={() => q.refetch()} /> : (
        <Table head={["Job", numHead("Applicants"), numHead("Shortlisted"), numHead("Interviewed"), numHead("Hired")]} label={`Jobs of ${company.name}`} wrapHeads loading={q.data ? undefined : Math.min(company.jobs.total, 4)} empty="No jobs yet.">
          {(q.data?.jobs ?? []).map((job) => (
            <tr key={job.id}>
              <td>
                <div className="grid min-w-36 justify-items-start gap-1">
                  <span className="text-sm font-semibold text-ink">{job.title}</span>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Pill size="sm" tone={jobStatusTone(job.status)}>{job.statusLabel}</Pill>
                    {job.publishedAt ? <span className="small muted" title={exactWhen(job.publishedAt)}>Published {shortDay(job.publishedAt)}</span> : null}
                  </span>
                  {job.jobPageUrl ? <a className="small" href={job.jobPageUrl} target="_blank" rel="noopener noreferrer">View job page<span className="sr-only">: {job.title} (opens in a new tab)</span></a> : null}
                </div>
              </td>
              <td className="num">{job.applicants}</td>
              <td className="num">{job.shortlisted}</td>
              <td className="num">{job.interviewed}</td>
              <td className="num">{job.hired}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
