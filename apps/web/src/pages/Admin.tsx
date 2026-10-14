"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, ErrorState, Field, numHead, PageHeader, Segmented, Sheet, Skeleton, Table, Tabs, useTableSort } from "@ros/ui";
import { api, ApiError, type Me } from "../api/client";
import { allowanceAlerts, allowanceChip } from "../allowance";
import { APPLY_MODE_HELP, APPLY_MODE_LABEL, APPLY_MODE_NOTE, REASON_MIN, companyFlowToast, reasonReady, type ApplyMode } from "../apply-flow";
import { RoleApplyMode } from "../components/ApplyMode";
import { RECRUITER_ASKS_OVER_CHIP, recruiterAsksLine, type RecruiterAskStanding } from "../recruiter-requests";
import { toast } from "../toast";
import { CustomerReportSheet } from "./AdminCustomerReport";
import { DECLINE_REASONS, dayKey } from "./candidate-panel/helpers";

type Tab = "customers" | "runs" | "ai" | "failures" | "costs" | "queue" | "calendar" | "privacy" | "admins" | "outcomes";
const reason = { headers: { "x-admin-reason": "admin console" } };
const SECTIONS: Array<{ id: Tab; label: string }> = [{ id: "customers", label: "Customers" }, { id: "runs", label: "Workflows" }, { id: "ai", label: "AI runs" }, { id: "failures", label: "Failures" }, { id: "costs", label: "Costs" }, { id: "queue", label: "Queue" }, { id: "calendar", label: "Business calendar" }, { id: "privacy", label: "Privacy requests" }, { id: "admins", label: "Administrators" }, { id: "outcomes", label: "Outcomes" }];

/** The internal console (docs/16). Every read is audited server-side with the reason header. */
export function Admin() {
  const [tab, setTab] = useState<Tab>("customers");
  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader eyebrow="ITS" title="Admin console" sub="Customers, workflows, AI runs, failures, and cost. Reads are audited." />
      <Tabs label="Admin sections" value={tab} onChange={(v) => setTab(v as Tab)} items={SECTIONS}>
        {tab === "customers" ? <Customers /> : tab === "runs" ? <Runs /> : tab === "ai" ? <AiRuns /> : tab === "failures" ? <Failures /> : tab === "costs" ? <Costs /> : tab === "calendar" ? <CalendarAdmin /> : tab === "privacy" ? <PrivacyRequests /> : tab === "admins" ? <Administrators /> : tab === "outcomes" ? <Outcomes /> : <Queue />}
      </Tabs>
    </div>
  );
}

/** `applyFlowDefault`: how the company's roles meet the screening conversation unless a role has its own setting (plan E1). */
type CustomerRow = { id: string; name: string; slug: string; vertical: string; sizeBand: string; planKey: string; status: string; roles: number; applications: number; aiCostUsd: number; lastActivityAt: string | null; escalations: number; createdAt: string; settings: { website?: string }; verifiedAt: string | null; verifiedBy: { id: string; name?: string } | null; heldMessages: number; jobBoardsConfirmedAt: string | null; recruiterAsks?: RecruiterAskStanding; applyFlowDefault?: ApplyMode; screeningConversations?: { used: number; limit: number | null; resetsAt?: string | null } };
export const CUSTOMER_SORT = { company: (c: CustomerRow) => c.name, applicants: (c: CustomerRow) => c.applications, cost: (c: CustomerRow) => c.aiCostUsd, activity: (c: CustomerRow) => (c.lastActivityAt ? Date.parse(c.lastActivityAt) : null) };
type CheckedRow = { verifiedAt: string | null; createdAt: string };

/** Companies waiting for the ITS check, the longest waiting first (founder decision B7). */
export function waitingCustomers<T extends CheckedRow>(rows: readonly T[]): T[] {
  return rows.filter((c) => !c.verifiedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The customers table's order (founder decision B7): the companies waiting for the ITS check on top whatever order a
 * heading gives, the longest waiting first, then the confirmed ones in the chosen order (`sortConfirmed`).
 */
export function customerOrder<T extends CheckedRow>(rows: readonly T[], sortConfirmed: (confirmed: T[]) => T[]): T[] {
  return [...waitingCustomers(rows), ...sortConfirmed(rows.filter((c) => c.verifiedAt))];
}

/** What a screen reader hears after a sort; while any company waits, also that the waiting ones stay on top. */
export function customerAnnouncement(announce: string, waiting: number): string {
  return announce && waiting ? `${announce} Companies waiting for the ITS check stay at the top.` : announce;
}

function Customers() {
  const q = useQuery({ queryKey: ["admin", "customers"], queryFn: () => api.get<CustomerRow[]>("/api/v1/admin/customers", reason) });
  // Companies at 80% of their screening conversations, or past them (Q17): from the alerts ITS was sent.
  const alerts = useQuery({ queryKey: ["admin", "alerts"], queryFn: () => api.get<AlertRow[]>("/api/v1/admin/alerts", reason) });
  const low = allowanceAlerts(alerts.data ?? []);
  // The customer's report (the ten role-report figures over every role) opens in a sheet; the read is audited like every other.
  const [reportFor, setReportFor] = useState<{ id: string; name: string } | null>(null);
  const [checking, setChecking] = useState<CustomerRow | null>(null);
  const [flowFor, setFlowFor] = useState<CustomerRow | null>(null);
  const [planFor, setPlanFor] = useState<CustomerRow | null>(null);
  const s = useTableSort<keyof typeof CUSTOMER_SORT>();
  if (q.isLoading) return <Skeleton lines={4} />;
  if (q.error) return <ErrorState message="Could not load customers." onRetry={() => q.refetch()} />;
  // Companies waiting for the ITS check come first, the longest waiting at the top (founder decision B7).
  const waiting = waitingCustomers(q.data!);
  const lowCompanies = q.data!.filter((c) => low.has(c.id));
  return (
    <div className="stack" style={{ gap: 14 }}>
      {waiting.length ? (
        <Alert tone="caution">
          {waiting.length === 1 ? "1 company is" : `${waiting.length} companies are`} waiting for the ITS check: {waiting.map((c) => c.name).join(", ")}. Until you confirm a company, its careers page, job pages and Google listing are offline and its emails to candidates wait.
        </Alert>
      ) : null}
      {lowCompanies.length ? (
        <Card needsYou title="Screening chats running low">
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {lowCompanies.map((c) => <li key={c.id}><strong>{c.name}</strong>: {allowanceChip(low.get(c.id)!)}, since {new Date(low.get(c.id)!.since).toLocaleDateString()}</li>)}
          </ul>
          <p className="small muted" style={{ marginTop: 8 }}>Talk with each about topping up. Nothing is refused: applications are still accepted, anyone part-way through finishes, and once the allowance is used up new applicants get the chat link by email when more are added or the month starts again. The owners were told too.</p>
        </Card>
      ) : null}
      <Table head={[s.col("company", "Company", "text"), "ITS check", "Vertical", "Plan", numHead("Roles"), s.col("applicants", "Applicants", "number", { num: true }), s.col("cost", "AI cost", "number", { num: true }), "Recruiter requests", "How people apply", s.col("activity", "Last activity", "date"), "Churn signal", ""]} scroll pinFirst empty="No customers yet." announce={customerAnnouncement(s.announce, waiting.length)}>
        {customerOrder(q.data!, (confirmed) => s.apply(confirmed, CUSTOMER_SORT)).map((c) => {
          const idle = c.lastActivityAt ? (Date.now() - Date.parse(c.lastActivityAt)) / 86_400_000 : 999;
          return (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>
                {c.verifiedAt ? <Chip tone="good">confirmed</Chip> : <Chip tone="caution">waiting since {new Date(c.createdAt).toLocaleDateString()}</Chip>}
                {c.heldMessages ? <div className="small muted">{c.heldMessages} {c.heldMessages === 1 ? "message" : "messages"} to candidates held</div> : null}
                <div className="small muted">job boards: {c.jobBoardsConfirmedAt ? "ITS can sign in" : "not confirmed"}</div>
              </td>
              <td>{c.vertical}</td>
              <td>
                {c.planKey} · {c.status}{c.screeningConversations ? <div className="small muted">{screeningLine(c.screeningConversations)}</div> : null}{low.has(c.id) ? <div><Chip tone="caution">{allowanceChip(low.get(c.id)!)}</Chip></div> : null}
                <Button size="sm" variant="quiet" onClick={() => setPlanFor(c)}>Change plan</Button>
              </td>
              <td className="num">{c.roles}</td><td className="num">{c.applications}</td><td className="num">${c.aiCostUsd.toFixed(4)}</td>
              <td>
                {/* Past the plan's recruiter requests (Q33): nothing was refused; ITS talks with the customer about billing. */}
                <div className="small">{recruiterAsksLine(c.recruiterAsks)}</div>
                {c.recruiterAsks?.over ? <Chip tone="caution">{RECRUITER_ASKS_OVER_CHIP}</Chip> : null}
                <div className="small muted">{c.escalations} in all</div>
              </td>
              <td>
                <div className="small">{APPLY_MODE_LABEL[c.applyFlowDefault ?? "form_then_screen"]}</div>
                <Button size="sm" variant="quiet" onClick={() => setFlowFor(c)}>Change</Button>
              </td>
              <td>{c.lastActivityAt ? new Date(c.lastActivityAt).toLocaleString() : "never"}</td>
              <td>{idle > 14 ? <Chip tone="critical">no activity {Math.round(idle)}d</Chip> : idle > 7 ? <Chip tone="caution">quiet {Math.round(idle)}d</Chip> : <Chip tone="good">active</Chip>}</td>
              <td><div className="row"><Button size="sm" variant={c.verifiedAt ? "secondary" : "primary"} onClick={() => setChecking(c)}>{c.verifiedAt ? "Check" : "Confirm"}</Button><Button size="sm" variant="secondary" onClick={() => setReportFor({ id: c.id, name: c.name })}>Report</Button></div></td>
            </tr>
          );
        })}
      </Table>
      {reportFor ? <CustomerReportSheet companyId={reportFor.id} companyName={reportFor.name} onClose={() => setReportFor(null)} /> : null}
      {checking ? <CompanyCheckSheet company={q.data!.find((c) => c.id === checking.id) ?? checking} onClose={() => setChecking(null)} /> : null}
      {flowFor ? <ApplyFlowSheet company={q.data!.find((c) => c.id === flowFor.id) ?? flowFor} onClose={() => setFlowFor(null)} /> : null}
      {planFor ? <PlanSheet company={q.data!.find((c) => c.id === planFor.id) ?? planFor} onClose={() => setPlanFor(null)} /> : null}
    </div>
  );
}

/** "122 of 150 screening chats this month, resets October 30" (the reset date when the API gives one). */
export function screeningLine(u: { used: number; limit: number | null; resetsAt?: string | null }): string {
  const resets = u.resetsAt ? `, resets ${new Date(u.resetsAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}` : "";
  return `${u.used}${u.limit !== null ? ` of ${u.limit}` : ""} screening chats this month${resets}`;
}

export type PlanOption = { key: string; name: string; limits: Record<string, number | null> };
const LIMIT_WORDS: Array<[string, string]> = [["active_roles", "active jobs"], ["text_screens", "screening chats a month"], ["recruiter_asks", "recruiter requests a month"], ["seats", "seats"]];

/** What a plan includes, in one line: "3 active jobs · 300 screening chats a month · 10 recruiter requests a month · unlimited seats". */
export function planLimitsLine(limits: Record<string, number | null>): string {
  return LIMIT_WORDS.filter(([k]) => k in limits).map(([k, words]) => `${limits[k] === null ? "unlimited" : limits[k]} ${words}`).join(" · ");
}

/** The toast after a plan change. */
export function planChangedToast(company: string, plan: string): { title: string; detail: string } {
  return { title: `${company} is on ${plan} now.`, detail: "The new limits apply at once. This month's usage stays; the reset date does not move." };
}

/**
 * The Plan control (Wave S2 F1; founder decision F8), platform admins only: pick a plan, say why, confirm. The new limits
 * apply at once (POST /admin/customers/:id/plan); the change is audited with the reason and the customer sees it in
 * their history. Design Partner starts the 90-day pilot.
 */
function PlanSheet({ company, onClose }: { company: CustomerRow; onClose: () => void }) {
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api.get<PlanOption[]>("/api/v1/admin/plans", reason) });
  const [pick, setPick] = useState(company.planKey);
  const [why, setWhy] = useState("");
  const [confirming, setConfirming] = useState(false);
  const chosen = (plans.data ?? []).find((p) => p.key === pick) ?? null;
  const save = useMutation({
    mutationFn: () => api.post(`/api/v1/admin/customers/${company.id}/plan`, { planKey: pick, reason: why.trim() }, reason),
    onSuccess: () => {
      const t = planChangedToast(company.name, chosen?.name ?? pick);
      toast(t.title, t.detail);
      setWhy("");
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ["admin", "customers"] });
      qc.invalidateQueries({ queryKey: ["admin", "alerts"] });
      onClose();
    },
    onError: (e) => { setConfirming(false); toast(e instanceof ApiError ? e.message : "Could not change the plan."); },
  });
  return (
    <Sheet open onClose={onClose} title={`Plan: ${company.name}`}>
      <div className="stack" style={{ gap: 14 }}>
        <Card title="Pick a plan">
          <p className="small muted">Now on {company.planKey}.{company.screeningConversations ? ` ${screeningLine(company.screeningConversations)}.` : ""}</p>
          {plans.isLoading ? <Skeleton lines={3} /> : plans.error ? <ErrorState message="Could not load the plans." onRetry={() => plans.refetch()} /> : (
            <div className="stack" style={{ gap: 8, marginTop: 8 }}>
              <Field label="Plan" htmlFor="plan-pick">
                <select id="plan-pick" className="select" value={pick} onChange={(e) => { setPick(e.target.value); setConfirming(false); }}>
                  {(plans.data ?? []).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
                </select>
              </Field>
              {chosen ? <p className="small" style={{ margin: 0 }}>{planLimitsLine(chosen.limits)}</p> : null}
              {pick !== company.planKey ? (
                <>
                  <Field label="Why (required, kept with the change)" htmlFor="plan-why" hint={`At least ${REASON_MIN} characters. The customer sees it in their activity history.`}><input id="plan-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
                  {confirming ? (
                    <Alert tone="caution"><div className="row" style={{ justifyContent: "space-between" }}><span>Put {company.name} on {chosen?.name ?? pick}?</span><span className="row"><Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Yes, change it</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
                  ) : <div className="row"><Button variant="primary" disabled={!reasonReady(why)} onClick={() => setConfirming(true)}>Change plan</Button><Button variant="quiet" onClick={() => { setPick(company.planKey); setWhy(""); }}>Cancel</Button></div>}
                </>
              ) : null}
            </div>
          )}
        </Card>
      </div>
    </Sheet>
  );
}

/**
 * How a customer's applicants meet the screening conversation (plan E1; founder decision B1), ITS only: the company's
 * default ("form now, conversation later" until ITS switches the one-visit flow on for pilot roles or the whole company) and each role's own setting. Every change needs a reason, which is
 * audited and kept with who made it. Roles that already have their own setting keep it when the default changes.
 */
function ApplyFlowSheet({ company, onClose }: { company: CustomerRow; onClose: () => void }) {
  const qc = useQueryClient();
  const current: ApplyMode = company.applyFlowDefault ?? "form_then_screen";
  const [flow, setFlow] = useState<ApplyMode>(current);
  const [why, setWhy] = useState("");
  const roles = useQuery({ queryKey: ["admin", "customer-report", company.id], queryFn: () => api.get<{ roles: Array<{ id: string; title: string; status: string }> }>(`/api/v1/admin/customers/${company.id}/report`, reason) });
  const save = useMutation({
    mutationFn: () => api.post<{ applyFlow: ApplyMode; changed: boolean }>(`/api/v1/admin/customers/${company.id}/apply-flow`, { applyFlow: flow, reason: why.trim() }, reason),
    onSuccess: (r) => {
      const t = companyFlowToast(company.name, r.applyFlow, r.changed);
      toast(t.title, t.detail);
      setWhy("");
      qc.invalidateQueries({ queryKey: ["admin", "customers"] });
      // each role's "the company's default" now names the new one
      qc.invalidateQueries({ queryKey: ["role"] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save the default."),
  });
  const open = (roles.data?.roles ?? []).filter((r) => r.status !== "closed");
  return (
    <Sheet open onClose={onClose} title={`How people apply: ${company.name}`}>
      <div className="stack" style={{ gap: 14 }}>
        <Card title="The company's default">
          <p className="small muted">For every role of {company.name} without its own setting. {APPLY_MODE_NOTE}</p>
          <div className="stack" style={{ gap: 8, marginTop: 8 }}>
            <Segmented value={flow} onChange={setFlow} ariaLabel="The company's default" options={[{ value: "one_visit", label: APPLY_MODE_LABEL.one_visit }, { value: "form_then_screen", label: APPLY_MODE_LABEL.form_then_screen }]} />
            <p className="small" style={{ margin: 0, color: "var(--ink-2)" }}>{APPLY_MODE_HELP[flow]}</p>
            {flow !== current ? (
              <>
                <Field label="Why (required, kept with the change)" htmlFor="apply-flow-why" hint={`At least ${REASON_MIN} characters. The customer sees it in their activity history.`}><input id="apply-flow-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
                <div className="row"><Button variant="primary" disabled={!reasonReady(why)} loading={save.isPending} onClick={() => save.mutate()}>Save the default</Button><Button variant="quiet" onClick={() => { setFlow(current); setWhy(""); }}>Cancel</Button></div>
              </>
            ) : null}
          </div>
        </Card>
        <Card title="Each role">
          {roles.isLoading ? <Skeleton lines={3} /> : roles.error ? <ErrorState message="Could not load the roles." onRetry={() => roles.refetch()} /> : open.length ? (
            <div className="stack" style={{ gap: 12 }}>
              {open.map((r) => (
                <div key={r.id} className="stack" style={{ gap: 6, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                  <strong>{r.title} <span className="small muted">({r.status.replace(/_/g, " ")})</span></strong>
                  <RoleApplyMode roleId={r.id} roleTitle={r.title} compact />
                </div>
              ))}
            </div>
          ) : <p className="small muted">No open or draft roles.</p>}
        </Card>
      </div>
    </Sheet>
  );
}

/**
 * The one-time ITS check of a company (founder decision B7): confirm it after checking it is real, or take a confirmation
 * back; both need a reason, which the customer sees in their own history, and a second press to confirm. Below, whether
 * ITS can sign in to the company's job boards, which ticks the owner's getting-started step.
 */
function CompanyCheckSheet({ company, onClose }: { company: CustomerRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [why, setWhy] = useState("");
  const [confirming, setConfirming] = useState(false);
  const verified = !!company.verifiedAt;
  const change = useMutation({
    mutationFn: () => api.post<{ changed: boolean; releasedMessages: number }>(`/api/v1/admin/customers/${company.id}/verification`, { verified: !verified, reason: why.trim(), confirm: true }, reason),
    onSuccess: (r) => {
      toast(verified ? `${company.name} is no longer confirmed.` : `${company.name} is confirmed.`, verified ? "Its public pages are offline and its messages to candidates wait. The owners were told." : `Its pages are public now${r.releasedMessages ? ` and ${r.releasedMessages} held ${r.releasedMessages === 1 ? "message is" : "messages are"} on ${r.releasedMessages === 1 ? "its" : "their"} way` : ""}. The owners were told.`);
      setWhy("");
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ["admin", "customers"] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not change the check."),
  });
  const boards = useMutation({
    mutationFn: (confirmed: boolean) => api.post(`/api/v1/admin/customers/${company.id}/job-boards`, { confirmed }, reason),
    onSuccess: (_r, confirmed) => { toast(confirmed ? "Job-board access confirmed." : "Job-board access no longer confirmed."); qc.invalidateQueries({ queryKey: ["admin", "customers"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record it."),
  });
  // A confirmed company with messages still held (one held while the confirmation was being made): confirming again sends them.
  const release = useMutation({
    mutationFn: () => api.post<{ releasedMessages: number }>(`/api/v1/admin/customers/${company.id}/verification`, { verified: true, reason: "Held messages sent after the company was confirmed.", confirm: true }, reason),
    onSuccess: (r) => { toast(r.releasedMessages ? `${r.releasedMessages} held ${r.releasedMessages === 1 ? "message is" : "messages are"} on ${r.releasedMessages === 1 ? "its" : "their"} way.` : "Nothing was held any more."); qc.invalidateQueries({ queryKey: ["admin", "customers"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send the held messages."),
  });
  return (
    <Sheet open onClose={onClose} title={`ITS check: ${company.name}`}>
      <div className="stack" style={{ gap: 14 }}>
        <Card title="The company">
          <p className="small">{company.name} · {company.vertical} · {company.sizeBand} employees · {company.settings.website || "no website given"} · signed up {new Date(company.createdAt).toLocaleDateString()}</p>
          <p className="small muted">{verified ? `Confirmed ${new Date(company.verifiedAt!).toLocaleString()}${company.verifiedBy?.name ? ` by ${company.verifiedBy.name}` : ""}.` : "Not confirmed yet: its careers page, job pages and Google listing are offline, and its emails to candidates wait. It can draft and approve roles."}</p>
          {company.heldMessages && !verified ? <p className="small">{company.heldMessages} {company.heldMessages === 1 ? "message" : "messages"} to candidates {company.heldMessages === 1 ? "is" : "are"} held and will go out when you confirm.</p> : null}
          {company.heldMessages && verified ? (
            <div className="row" style={{ justifyContent: "space-between", marginTop: 6 }}>
              <span className="small">{company.heldMessages} {company.heldMessages === 1 ? "message" : "messages"} to candidates {company.heldMessages === 1 ? "is" : "are"} still held although the company is confirmed.</span>
              <Button size="sm" variant="primary" loading={release.isPending} onClick={() => release.mutate()}>Send the held messages</Button>
            </div>
          ) : null}
        </Card>
        <Card title={verified ? "Take the confirmation back" : "Confirm the company"}>
          <p className="small muted">{verified ? "Its careers page, job pages and feeds go offline at once and its messages to candidates wait again. Roles, candidates and decisions are kept." : "Confirm only after checking the company is real: the kick-off call, its website, a phone number. Its pages go public, approved roles are published and held messages go out."} The owners are told, and they see your reason in their activity history.</p>
          <div className="stack" style={{ gap: 8, marginTop: 8 }}>
            <Field label={verified ? "Why you are taking it back" : "How you checked the company"} htmlFor="co-check-why"><input id="co-check-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
            {confirming ? (
              <Alert tone="caution"><div className="row" style={{ justifyContent: "space-between" }}><span>{verified ? `Take back the confirmation of ${company.name}?` : `Confirm ${company.name} and make its pages public?`}</span><span className="row"><Button size="sm" variant={verified ? "destructive" : "primary"} loading={change.isPending} onClick={() => change.mutate()}>{verified ? "Yes, take it back" : "Yes, confirm it"}</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
            ) : <div className="row"><Button variant={verified ? "secondary" : "primary"} disabled={why.trim().length < 5} onClick={() => setConfirming(true)}>{verified ? "Take back the confirmation" : "Confirm the company"}</Button></div>}
          </div>
        </Card>
        <Card title="Job-board access">
          <p className="small muted">The owner adds the ITS recruiter as a user on the company's LinkedIn, Indeed and ZipRecruiter accounts. Record here once ITS can sign in to each; it ticks the owner's getting-started step.</p>
          <div className="row" style={{ marginTop: 8 }}>
            {company.jobBoardsConfirmedAt
              ? <><Chip tone="good">ITS can sign in</Chip><Button size="sm" variant="secondary" loading={boards.isPending} onClick={() => boards.mutate(false)}>No longer confirmed</Button></>
              : <Button size="sm" variant="primary" loading={boards.isPending} onClick={() => boards.mutate(true)}>ITS can sign in to the job boards</Button>}
          </div>
        </Card>
      </div>
    </Sheet>
  );
}

// The console's sections are exported for the server-render tests (apps/shell/components/report-tables.test.ts); only Admin is routed.
export function Runs() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>("");
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["admin", "runs", status], queryFn: () => api.get<Array<{ id: string; companyId: string | null; workflowKey: string; status: string; currentStep: string; wait: { kind: string; until?: string; reason?: string } | null; attempts: number; lastError: string | null; updatedAt: string; subject: { type: string; id: string } }>>(`/api/v1/admin/runs${status ? `?status=${status}` : ""}`, reason) });
  const retry = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/admin/runs/${id}/retry`, {}, reason), onSuccess: () => { toast("Retried."); qc.invalidateQueries({ queryKey: ["admin", "runs"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not retry the run. Try again in a moment.") });
  return (
    <div className="stack">
      <Segmented value={status} onChange={setStatus} options={[{ value: "", label: "All" }, { value: "running", label: "Running" }, { value: "waiting", label: "Waiting" }, { value: "failed", label: "Failed" }, { value: "completed", label: "Completed" }]} />
      {q.error ? <ErrorState message="Could not load runs." onRetry={() => q.refetch()} /> : (
        <Table head={["Workflow", "Subject", "Status", "Step", "Waiting on", numHead("Attempts"), "Error", "Updated", ""]} scroll loading={q.isLoading ? 4 : undefined} empty={status ? "No runs with this status." : "No workflow runs yet."}>
          {(q.data ?? []).map((r) => (
            <tr key={r.id}>
              <td><button type="button" className="btn quiet sm" onClick={() => setOpenId(r.id)}>{r.workflowKey}</button></td>
              <td className="small">{r.subject.type} {r.subject.id.slice(0, 8)}</td>
              <td><Chip tone={r.status === "failed" ? "critical" : r.status === "waiting" ? "caution" : r.status === "completed" ? "good" : "accent"}>{r.status}</Chip></td>
              <td>{r.currentStep}</td>
              <td className="small">{r.wait ? `${r.wait.kind}${r.wait.until ? ` until ${new Date(r.wait.until).toLocaleString()}` : ""}${r.wait.reason ? ` (${r.wait.reason})` : ""}` : ""}</td>
              <td className="num">{r.attempts}</td>
              <td className="small" style={{ color: "var(--critical)" }}>{r.lastError?.slice(0, 80)}</td>
              <td className="small">{new Date(r.updatedAt).toLocaleString()}</td>
              <td>{r.status === "failed" ? <Button size="sm" onClick={() => retry.mutate(r.id)}>Retry</Button> : null}</td>
            </tr>
          ))}
        </Table>
      )}
      {openId ? <RunSheet id={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

/** Answers the six questions for any run: what the AI saw, concluded, why, which policy, what the human did, what happened. */
function RunSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["admin", "run", id], queryFn: () => api.get<{ run: { workflowKey: string; status: string; state: Record<string, unknown> }; steps: Array<{ seq: number; stepKey: string; status: string; error: string | null; output: Record<string, unknown>; startedAt: string }>; aiRuns: Array<{ id: string; task: string; model: string; promptKey: string; promptVersion: number; status: string; inputTokens: number; outputTokens: number; costUsd: string; latencyMs: number; structuredOutput: Record<string, unknown> | null; error: string | null }>; events: Array<{ type: string; occurredAt: string; actor: { kind: string; id: string; name?: string }; payload: Record<string, unknown> }> }>(`/api/v1/admin/runs/${id}`, reason) });
  return (
    <Sheet open onClose={onClose} title="Workflow run">
      {q.isLoading || !q.data ? <Skeleton lines={8} /> : (
        <div className="stack">
          <Card title={`${q.data.run.workflowKey} · ${q.data.run.status}`}><pre>{JSON.stringify(q.data.run.state, null, 2)}</pre></Card>
          <Card title="Steps"><ol style={{ paddingLeft: 18, margin: 0 }}>{q.data.steps.map((s) => <li key={s.seq} className="small">{s.stepKey} · <Chip tone={s.status === "ok" ? "good" : "critical"}>{s.status}</Chip> · {new Date(s.startedAt).toLocaleString()}{s.error ? <span style={{ color: "var(--critical)" }}> · {s.error}</span> : null} · {JSON.stringify(s.output)}</li>)}</ol></Card>
          <Card title="AI runs (what it saw, concluded, cost)">
            {q.data.aiRuns.length === 0 ? <p className="muted small">No model calls in this run.</p> : q.data.aiRuns.map((a) => (
              <details key={a.id} style={{ marginBottom: 8 }}>
                <summary className="small">{a.task} · {a.model} · {a.promptKey}@v{a.promptVersion} · <Chip tone={a.status === "ok" ? "good" : "critical"}>{a.status}</Chip> · {a.inputTokens}/{a.outputTokens} tokens · ${Number(a.costUsd).toFixed(5)} · {a.latencyMs} ms</summary>
                {a.error ? <p className="small" style={{ color: "var(--critical)" }}>{a.error}</p> : null}
                <pre>{JSON.stringify(a.structuredOutput, null, 2)}</pre>
              </details>
            ))}
          </Card>
          <Card title="Events (what happened, who did it)"><ul className="small" style={{ paddingLeft: 18, margin: 0 }}>{q.data.events.map((e, i) => <li key={i}>{new Date(e.occurredAt).toLocaleString()} · {e.type} · {e.actor.name ?? `${e.actor.kind}:${e.actor.id}`}{Object.keys(e.payload).length ? ` · ${JSON.stringify(e.payload).slice(0, 160)}` : ""}</li>)}</ul></Card>
        </div>
      )}
    </Sheet>
  );
}

export function AiRuns() {
  const q = useQuery({ queryKey: ["admin", "ai"], queryFn: () => api.get<Array<{ id: string; companyId: string | null; agent: string; task: string; model: string; promptKey: string; promptVersion: number; status: string; inputTokens: number; outputTokens: number; costUsd: string; latencyMs: number; confidence: string | null; createdAt: string }>>("/api/v1/admin/ai-runs", reason) });
  const s = useTableSort<"when" | "cost" | "latency">({ key: "when", dir: "descending" });
  if (q.isLoading) return <Skeleton lines={4} />;
  if (q.error) return <ErrorState message="Could not load AI runs." onRetry={() => q.refetch()} />;
  return (
    <Table head={[s.col("when", "When", "date"), "Agent", "Task", "Model", "Prompt", "Status", numHead("Tokens in/out"), s.col("cost", "Cost", "number", { num: true }), s.col("latency", "Latency", "number", { num: true }), "Confidence"]} scroll empty="No AI runs recorded yet." announce={s.announce}>
      {s.apply(q.data!, { when: (r) => Date.parse(r.createdAt), cost: (r) => Number(r.costUsd), latency: (r) => r.latencyMs }).map((r) => <tr key={r.id}><td className="small">{new Date(r.createdAt).toLocaleString()}</td><td>{r.agent}</td><td>{r.task}</td><td>{r.model}</td><td className="small">{r.promptKey}@v{r.promptVersion}</td><td><Chip tone={r.status === "ok" ? "good" : "critical"}>{r.status}</Chip></td><td className="num">{r.inputTokens}/{r.outputTokens}</td><td className="num">${Number(r.costUsd).toFixed(5)}</td><td className="num">{r.latencyMs} ms</td><td>{r.confidence ?? ""}</td></tr>)}
    </Table>
  );
}

type AlertRow = { id: string; kind: string; severity: string; title: string; body: string; status: string; companyId: string | null; target: { type: string; id: string } | null; details: Record<string, unknown>; createdAt: string };
type Pending = { id: string; provider: string; kind: string; status: string; lastError: string | null; disconnectedAt: string | null };
type Suppression = { id: string; address: string; reason: string; source: string; active: boolean; count: number; firstAt: string; lastAt: string; details: Record<string, unknown> };

/**
 * An alert this administrator may not acknowledge (21 Sep, item 2): one about a platform role they changed, or one that
 * concerns them, is for another administrator. The API refuses it (second_person_required), so no button is offered.
 */
export function ackIsForAnother(a: Pick<AlertRow, "kind" | "details" | "target">, myUserId: string | null | undefined): boolean {
  return !!myUserId && a.kind.startsWith("platform_role.") && (a.details?.actorId === myUserId || a.target?.id === myUserId);
}
export const ACK_FOR_ANOTHER = "Another administrator acknowledges this one, because it is about a platform role you changed or one that concerns you.";
/** What Resolve says: the alert is closed for good, and the problem raises a new one if it comes back. */
export const RESOLVED_TOAST = { title: "Resolved.", detail: "If it happens again, a new alert is raised." };

/**
 * What "Retry deletion" says. Only the worker may read a stored credential, so the retry is queued for it and is rarely
 * done by the time the answer comes back; the alert closes on its own once the credential is gone.
 */
export function retryDeletionToast(r: { queued?: boolean; deleted?: boolean }): { title: string; detail?: string } {
  if (r.deleted) return { title: "Credential deleted.", detail: "The alert closes on its own." };
  return { title: "Deletion queued.", detail: "It runs in the background in a moment. The alert closes once the credential is gone." };
}

export function Failures() {
  const qc = useQueryClient();
  // Who is signed in: an alert about their own platform role change is acknowledged by another administrator.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const q = useQuery({ queryKey: ["admin", "failures"], queryFn: () => api.get<{ failedRuns: Array<{ id: string; workflowKey: string; lastError: string | null; updatedAt: string }>; failedJobs: Array<{ id: number; kind: string; lastError: string | null }>; failedAi: Array<{ id: string; task: string; status: string; error: string | null; createdAt: string }>; alerts: AlertRow[]; pendingDeletions: Pending[] }>("/api/v1/admin/failures", reason), refetchInterval: 15000 });
  const ack = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/admin/alerts/${id}/acknowledge`, {}, reason), onSuccess: () => { toast("Acknowledged."); qc.invalidateQueries({ queryKey: ["admin", "failures"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not acknowledge the alert. Try again in a moment.") });
  // Resolve (Wave S2 F1): the problem is dealt with; the alert leaves this list and a new one is raised if it comes back.
  const resolve = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/admin/alerts/${id}/resolve`, {}, reason), onSuccess: () => { toast(RESOLVED_TOAST.title, RESOLVED_TOAST.detail); qc.invalidateQueries({ queryKey: ["admin", "failures"] }); qc.invalidateQueries({ queryKey: ["admin", "alerts"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not resolve the alert. Try again in a moment.") });
  const retry = useMutation({
    mutationFn: (integrationId: string) => api.post<{ queued?: boolean; deleted?: boolean }>(`/api/v1/admin/integrations/${integrationId}/retry-deletion`, {}, reason),
    onSuccess: (r) => { const t = retryDeletionToast(r); toast(t.title, t.detail); qc.invalidateQueries({ queryKey: ["admin", "failures"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not retry the deletion. Try again in a moment."),
  });
  const suppressions = useQuery({ queryKey: ["admin", "suppressions"], queryFn: () => api.get<Suppression[]>("/api/v1/admin/email-suppressions", reason) });
  const csp = useQuery({ queryKey: ["admin", "csp"], queryFn: () => api.get<{ mode: string; reports: Array<{ id: string; mode: string; surface: string; documentPath: string; violatedDirective: string; blockedOrigin: string | null; sourceFile: string | null; count: number; lastAt: string; reviewedAt: string | null; disposition: string | null }> }>("/api/v1/admin/csp-reports", reason) });
  const [cspNote, setCspNote] = useState<Record<string, string>>({});
  const reviewCsp = useMutation({ mutationFn: (r: { id: string; disposition: string }) => api.post(`/api/v1/admin/csp-reports/${r.id}/review`, { disposition: r.disposition }, reason), onSuccess: () => { toast("Reviewed."); qc.invalidateQueries({ queryKey: ["admin", "csp"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not review.") });
  const [releaseReason, setReleaseReason] = useState("");
  const release = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/admin/email-suppressions/${id}/release`, { reason: releaseReason }, reason), onSuccess: () => { toast("Released. Email to that address is allowed again."); setReleaseReason(""); qc.invalidateQueries({ queryKey: ["admin", "suppressions"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not release.") });
  if (q.isLoading) return <Skeleton lines={4} />;
  if (q.error || !q.data) return <ErrorState message="Could not load failures." onRetry={() => q.refetch()} />;
  return (
    <div className="stack">
      <Card title={csp.isLoading ? "Content-security violations (loading…)" : csp.error ? "Content-security violations (could not load)" : `Content-security violations (${csp.data?.mode ?? "report-only"}; ${csp.data?.reports.filter((r) => !r.reviewedAt).length ?? 0} unreviewed)`}>
        <p className="small muted">Browsers report what the policy would block. Review every unexplained report before enforcement is switched on (docs/readiness/18). Paths and origins only; never candidate data.</p>
        {csp.data?.reports.length ? csp.data.reports.slice(0, 50).map((r) => (
          <div key={r.id} className="stack" style={{ gap: 4, padding: "8px 0", borderTop: "1px solid var(--line)" }}>
            <div className="row"><Chip tone={r.reviewedAt ? "neutral" : "caution"}>{r.surface}</Chip><strong>{r.violatedDirective}</strong><span className="small muted">{r.documentPath} · blocked {r.blockedOrigin ?? "(none)"} · ×{r.count} · {new Date(r.lastAt).toLocaleString()}</span></div>
            {r.reviewedAt ? <span className="small muted">Reviewed: {r.disposition}</span> : r.disposition ? <span className="small muted">Recurred since it was reviewed ("{r.disposition}"); review again.</span> : null}
            {!r.reviewedAt ? (
              <div className="row"><input className="input" style={{ maxWidth: 360 }} aria-label="What this report means" placeholder="expected in dev / fix needed / policy change" value={cspNote[r.id] ?? ""} onChange={(e) => setCspNote({ ...cspNote, [r.id]: e.target.value })} /><Button size="sm" variant="secondary" disabled={(cspNote[r.id] ?? "").trim().length < 3} loading={reviewCsp.isPending} onClick={() => reviewCsp.mutate({ id: r.id, disposition: cspNote[r.id] })}>Mark reviewed</Button></div>
            ) : null}
          </div>
        )) : <p className="small muted" style={{ marginTop: 8 }}>No violation reports.</p>}
      </Card>
      <Card title={`Alerts that need a person (${q.data.alerts.length})`}>
        {q.data.alerts.length ? q.data.alerts.map((a) => (
          <div key={a.id} className="stack" style={{ gap: 4, padding: "8px 0", borderTop: "1px solid var(--line)" }}>
            <div className="row"><Chip tone={a.severity === "critical" ? "critical" : "caution"}>{a.severity}</Chip><strong>{a.title}</strong><span className="small muted">{new Date(a.createdAt).toLocaleString()}</span>{a.status === "acknowledged" ? <Chip tone="neutral">acknowledged</Chip> : null}</div>
            <p className="small">{a.body}</p>
            <div className="row">
              {ackIsForAnother(a, me.data?.user.id) ? (a.status === "open" ? <span className="small muted">{ACK_FOR_ANOTHER}</span> : null) : (
                <>
                  {a.status === "open" ? <Button size="sm" variant="secondary" loading={ack.isPending && ack.variables === a.id} onClick={() => ack.mutate(a.id)}>Acknowledge</Button> : null}
                  <Button size="sm" variant="quiet" loading={resolve.isPending && resolve.variables === a.id} onClick={() => resolve.mutate(a.id)}>Resolve</Button>
                </>
              )}
              {a.kind === "secret.delete_failed" && a.target ? <Button size="sm" variant="primary" loading={retry.isPending && retry.variables === a.target.id} onClick={() => retry.mutate(a.target!.id)}>Retry deletion</Button> : null}
            </div>
          </div>
        )) : <p className="muted small">None.</p>}
      </Card>
      <Card title={`Email addresses we must not send to (${suppressions.data?.length ?? 0})`}>
        <p className="small muted">Hard bounces, spam complaints and repeated soft bounces land here from the provider's webhooks. Release one only after confirming the address by another channel; the release is audited with your reason.</p>
        {suppressions.data?.length ? (
          <>
            <Field label="How you confirmed the address (required to release)" htmlFor="rel-reason"><input id="rel-reason" className="input" value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} /></Field>
            <Table head={["Address", "Reason", "Source", numHead("Times"), "Last", ""]}>
              {suppressions.data.map((s) => <tr key={s.id}><td>{s.address}</td><td><Chip tone={s.reason === "spam_complaint" ? "critical" : "caution"}>{s.reason.replace(/_/g, " ")}</Chip></td><td>{s.source}</td><td className="num">{s.count}</td><td className="small">{new Date(s.lastAt).toLocaleString()}</td><td><Button size="sm" variant="quiet" disabled={releaseReason.trim().length < 5 || s.reason === "spam_complaint"} loading={release.isPending} onClick={() => release.mutate(s.id)}>Release</Button></td></tr>)}
            </Table>
            <p className="small muted">A spam complaint is never released from here: the person asked not to be emailed.</p>
          </>
        ) : <p className="muted small">None.</p>}
      </Card>
      {q.data.pendingDeletions.length ? <Card title={`Credentials still in the store after disconnect (${q.data.pendingDeletions.length})`}><ul className="small">{q.data.pendingDeletions.map((p) => <li key={p.id}>{p.provider} {p.kind} · {p.lastError} <Button size="sm" variant="quiet" loading={retry.isPending && retry.variables === p.id} onClick={() => retry.mutate(p.id)}>Retry</Button></li>)}</ul></Card> : null}
      <Card title={`Failed workflow runs (${q.data.failedRuns.length})`}>{q.data.failedRuns.length ? <ul className="small">{q.data.failedRuns.map((r) => <li key={r.id}>{r.workflowKey} · {r.lastError} · {new Date(r.updatedAt).toLocaleString()}</li>)}</ul> : <p className="muted small">None.</p>}</Card>
      <Card title={`Failed jobs (${q.data.failedJobs.length})`}>{q.data.failedJobs.length ? <ul className="small">{q.data.failedJobs.map((j) => <li key={j.id}>{j.kind} · {j.lastError}</li>)}</ul> : <p className="muted small">None.</p>}</Card>
      <Card title={`AI runs that were not ok (${q.data.failedAi.length})`}>{q.data.failedAi.length ? <ul className="small">{q.data.failedAi.map((a) => <li key={a.id}>{a.task} · {a.status} · {a.error} · {new Date(a.createdAt).toLocaleString()}</li>)}</ul> : <p className="muted small">None.</p>}</Card>
    </div>
  );
}

export function Costs() {
  const q = useQuery({ queryKey: ["admin", "costs"], queryFn: () => api.get<Array<{ companyId: string | null; task: string; model: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number }>>("/api/v1/admin/costs", reason) });
  if (q.isLoading) return <Skeleton lines={4} />;
  if (q.error) return <ErrorState message="Could not load costs." onRetry={() => q.refetch()} />;
  const total = q.data!.reduce((n, r) => n + r.costUsd, 0);
  return (
    <div className="stack">
      <p>Total model spend recorded: <strong>${total.toFixed(4)}</strong> (list prices; the fake provider is free).</p>
      <Table head={["Company", "Task", "Model", numHead("Runs"), numHead("Tokens in"), numHead("Tokens out"), numHead("Cost")]} scroll empty="No model spend recorded yet.">
        {q.data!.map((r, i) => <tr key={i}><td className="small">{r.companyId?.slice(0, 8) ?? "platform"}</td><td>{r.task}</td><td>{r.model}</td><td className="num">{r.runs}</td><td className="num">{r.inputTokens}</td><td className="num">{r.outputTokens}</td><td className="num">${r.costUsd.toFixed(5)}</td></tr>)}
      </Table>
    </div>
  );
}

export function Queue() {
  const q = useQuery({ queryKey: ["admin", "queue"], queryFn: () => api.get<{ queued: number; failed: number; oldestQueuedAt: string | null; waitingRuns: number; definitions: string[] }>("/api/v1/admin/queue", reason), refetchInterval: 5000 });
  // A failed load says so instead of loading for ever; a failed refresh keeps the last figures on screen.
  if (!q.data) return q.error ? <ErrorState message="Could not load the queue." onRetry={() => q.refetch()} /> : <Skeleton lines={3} />;
  return (
    <Card title="Queue health">
      <dl className="kv">
        <dt>Queued jobs</dt><dd>{q.data.queued}</dd>
        <dt>Oldest queued</dt><dd>{q.data.oldestQueuedAt ? new Date(q.data.oldestQueuedAt).toLocaleString() : "none"}</dd>
        <dt>Failed jobs</dt><dd>{q.data.failed}</dd>
        <dt>Runs waiting</dt><dd>{q.data.waitingRuns}</dd>
        <dt>Workflows registered</dt><dd>{q.data.definitions.join(", ")}</dd>
      </dl>
    </Card>
  );
}

type Window = { start: string; end: string };
type CalendarDto = {
  current: { timeZone: string; hours: Record<string, Window[]>; holidays: Array<{ date: string; name: string }>; closures: Array<{ from: string; to: string; name: string }>; coverageChanges: Array<{ from: string; to: string; reason: string; hours: Window[] | null }> };
  version: number | null; effectiveFrom: string | null; description: string;
  upcoming: Array<{ version: number; effectiveFrom: string; note: string }>;
  versions: Array<{ version: number; effectiveFrom: string; timeZone: string; note: string; createdAt: string; createdBy: { name?: string; id: string } }>;
  preview: Array<{ date: string; weekday: string; open: Window[]; reason: string | null }>;
};
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABEL: Record<(typeof DAYS)[number], string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const ZONES = ["America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago", "America/New_York"];
const windowsToText = (ws: Window[]) => ws.map((w) => `${w.start}-${w.end}`).join(", ");
const parseWindows = (t: string): Window[] => t.split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [start = "", end = ""] = x.split("-").map((y) => y.trim()); return { start, end }; });
const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean);
// Today in the administrator's own calendar: the UTC date read as tomorrow on a US evening, so a version meant to start
// now said "takes effect on its date".
const todayKey = () => dayKey(new Date());

/**
 * The ITS business calendar (correction 12): every save is a new version with an effective date; nothing is edited in
 * place; deadlines already set keep their values until an administrator recalculates them with a reason.
 */
export function CalendarAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "calendar"], queryFn: () => api.get<CalendarDto>("/api/v1/admin/calendar", reason) });
  const [effectiveFrom, setEffectiveFrom] = useState(todayKey());
  const [timeZone, setTimeZone] = useState("America/Los_Angeles");
  const [hours, setHours] = useState<Record<string, string>>({});
  const [holidays, setHolidays] = useState("");
  const [closures, setClosures] = useState("");
  const [coverage, setCoverage] = useState("");
  const [note, setNote] = useState("");
  const [recalcReason, setRecalcReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) return;
    const c = q.data.current;
    setTimeZone(c.timeZone);
    setHours(Object.fromEntries(DAYS.map((d) => [d, windowsToText(c.hours[d] ?? [])])));
    setHolidays(c.holidays.map((h) => `${h.date} ${h.name}`).join("\n"));
    setClosures(c.closures.map((x) => `${x.from} ${x.to} ${x.name}`).join("\n"));
    setCoverage(c.coverageChanges.map((x) => `${x.from} ${x.to} ${x.hours ? windowsToText(x.hours).replace(/, /g, "+") : "closed"} ${x.reason}`).join("\n"));
  }, [q.data]);
  const build = () => {
    const parseDated = (l: string, n: number) => { const parts = l.split(/\s+/); return { dates: parts.slice(0, n), rest: parts.slice(n).join(" ") }; };
    return {
      effectiveFrom, timeZone, note,
      hours: Object.fromEntries(DAYS.map((d) => [d, parseWindows(hours[d] ?? "")])),
      holidays: lines(holidays).map((l) => { const { dates, rest } = parseDated(l, 1); return { date: dates[0], name: rest || "Holiday" }; }),
      closures: lines(closures).map((l) => { const { dates, rest } = parseDated(l, 2); return { from: dates[0], to: dates[1], name: rest || "Closed" }; }),
      coverageChanges: lines(coverage).map((l) => { const { dates, rest } = parseDated(l, 2); const [spec = "", ...why] = rest.split(/\s+/); return { from: dates[0], to: dates[1], hours: spec === "closed" ? null : parseWindows(spec.replace(/\+/g, ",")), reason: why.join(" ") || "coverage change" }; }),
    };
  };
  const save = useMutation({
    mutationFn: () => api.post<{ version: number; inForceNow: boolean; description: string }>("/api/v1/admin/calendar", build(), reason),
    onSuccess: (r) => { setProblem(null); toast(`Saved as version ${r.version}${r.inForceNow ? " (in force now)" : " (takes effect on its date)"}.`); qc.invalidateQueries({ queryKey: ["admin", "calendar"] }); },
    onError: (e) => setProblem(e instanceof ApiError ? `${e.message}${e.details ? ` ${JSON.stringify(e.details)}` : ""}` : "Could not save."),
  });
  const recalc = useMutation({
    mutationFn: () => api.post<{ considered: number; changed: number }>("/api/v1/admin/calendar/recalculate", { reason: recalcReason }, reason),
    onSuccess: (r) => { toast(`Recalculated ${r.changed} of ${r.considered} open deadlines.`); setRecalcReason(""); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not recalculate."),
  });
  if (!q.data) return q.error ? <ErrorState message="Could not load the business calendar." onRetry={() => q.refetch()} /> : <Skeleton lines={6} />;
  return (
    <div className="stack">
      <Card title={`In force: ${q.data.description}`}>
        <p className="small muted">{q.data.version ? `Version ${q.data.version}, effective ${q.data.effectiveFrom}.` : "Built-in default; no version published yet."}{q.data.upcoming.length ? ` Upcoming: ${q.data.upcoming.map((u) => `v${u.version} from ${u.effectiveFrom}`).join(", ")}.` : ""} Service-level clocks count only open hours. Deadlines already set keep their values unless you recalculate them below.</p>
      </Card>
      <Card title="Publish a new version">
        {problem ? <Alert tone="critical">{problem}</Alert> : null}
        <div className="grid-2">
          <Field label="Effective from" htmlFor="cal-eff"><input id="cal-eff" className="input" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></Field>
          <Field label="Time zone" htmlFor="cal-tz"><select id="cal-tz" className="input" value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>{[...new Set([...ZONES, timeZone])].map((z) => <option key={z} value={z}>{z}</option>)}</select></Field>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small muted" style={{ marginBottom: 6 }}>Standard hours per day (24-hour windows, comma-separated; blank means closed)</legend>
          <div className="grid-2">
            {DAYS.map((d) => <Field key={d} label={DAY_LABEL[d]} htmlFor={`cal-${d}`}><input id={`cal-${d}`} className="input" placeholder="09:00-17:00" value={hours[d] ?? ""} onChange={(e) => setHours({ ...hours, [d]: e.target.value })} /></Field>)}
          </div>
        </fieldset>
        <Field label="Holidays (one per line: date, name)" htmlFor="cal-hol"><textarea id="cal-hol" className="textarea" rows={6} value={holidays} onChange={(e) => setHolidays(e.target.value)} placeholder="2026-11-26 Thanksgiving Day" /></Field>
        <Field label="ITS closures (one per line: first day, last day, name)" htmlFor="cal-clo"><textarea id="cal-clo" className="textarea" rows={3} value={closures} onChange={(e) => setClosures(e.target.value)} placeholder="2026-12-24 2026-12-31 Year-end closure" /></Field>
        <Field label="Temporary coverage changes (one per line: first day, last day, hours or 'closed', reason)" hint="Join several windows with +, for example 09:00-12:00+13:00-15:00." htmlFor="cal-cov"><textarea id="cal-cov" className="textarea" rows={3} value={coverage} onChange={(e) => setCoverage(e.target.value)} placeholder="2026-10-05 2026-10-09 09:00-12:00 Conference week" /></Field>
        <Field label="Note for the audit record" htmlFor="cal-note"><input id="cal-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this change" /></Field>
        <div style={{ marginTop: 10 }}><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Publish version</Button></div>
      </Card>
      <Card title="Recalculate open deadlines">
        <p className="small muted">Only on request. Every changed deadline is audited and the customer sees the change on their request.</p>
        <Field label="Reason" htmlFor="cal-reason"><input id="cal-reason" className="input" value={recalcReason} onChange={(e) => setRecalcReason(e.target.value)} placeholder="Holiday closure added after these requests were opened" /></Field>
        <div style={{ marginTop: 10 }}><Button variant="secondary" loading={recalc.isPending} disabled={recalcReason.trim().length < 5} onClick={() => recalc.mutate()}>Recalculate all open deadlines</Button></div>
      </Card>
      <Card title="Next four weeks">
        <Table head={["Date", "Day", "Open", "Note"]}>
          {q.data.preview.map((d) => <tr key={d.date}><td>{d.date}</td><td>{d.weekday}</td><td>{d.open.length ? windowsToText(d.open) : <Chip tone="neutral">closed</Chip>}</td><td className="small muted">{d.reason ?? ""}</td></tr>)}
        </Table>
      </Card>
      <Card title="Versions">
        {q.data.versions.length === 0 ? <p className="small muted">No versions yet.</p> : (
          <Table head={["Version", "Effective", "Time zone", "Note", "Published"]}>
            {q.data.versions.map((v) => <tr key={v.version}><td>{v.version}</td><td>{v.effectiveFrom}</td><td>{v.timeZone}</td><td>{v.note}</td><td className="small">{new Date(v.createdAt).toLocaleString()} by {v.createdBy.name ?? v.createdBy.id}</td></tr>)}
          </Table>
        )}
      </Card>
    </div>
  );
}

type DataRequest = { id: string; companyId: string; companyName?: string; candidateId: string | null; applicationId: string | null; kind: string; details: string | null; requesterEmail: string; channel: string; verificationStatus: string; verificationNote: string | null; status: string; slaDueAt: string; assignedTo: string | null; notes: Array<{ at: string; by: string; text: string }>; counselEscalatedAt: string | null; counselDecision: string | null; counselNote: string | null; resolution: string | null; resolvedAt: string | null; confirmationSentAt: string | null; escalationId: string | null; createdAt: string };
const KIND_LABEL: Record<string, string> = { access: "Copy of their data", correct: "Correction", delete: "Deletion / anonymization", sms_opt_out: "Stop texts", human_review: "Human review", withdrawal: "Withdrawal" };
/** Where a request came from: the candidate's own status link, the public form (confirmed by an emailed link), the privacy mailbox, or the console. */
const SOURCE_LABEL: Record<string, string> = { status_page: "status page", email_form: "public form", email: "privacy mailbox", admin: "console" };
const STATUS_TONE: Record<string, "neutral" | "accent" | "needs" | "good" | "caution" | "critical"> = { received: "needs", in_progress: "accent", awaiting_counsel: "caution", fulfilled: "good", declined: "neutral" };

/**
 * Privacy requests (docs/runbooks/privacy-requests.md): the recorded, deadline-tracked workflow. A deletion runs only
 * after a counsel decision is recorded and the administrator confirms; nothing here is automatic.
 */
export function PrivacyRequests() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "privacy"], queryFn: () => api.get<DataRequest[]>("/api/v1/admin/data-requests", reason), refetchInterval: 15000 });
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState({ companyId: "", requesterEmail: "", kind: "access", details: "" });
  const create = useMutation({ mutationFn: () => api.post("/api/v1/admin/data-requests", { ...form, details: form.details || undefined }, reason), onSuccess: () => { toast("Recorded and acknowledged."); setForm({ companyId: "", requesterEmail: "", kind: "access", details: "" }); qc.invalidateQueries({ queryKey: ["admin", "privacy"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record.") });
  const customers = useQuery({ queryKey: ["admin", "customers"], queryFn: () => api.get<Array<{ id: string; name: string }>>("/api/v1/admin/customers", reason) });
  const s = useTableSort<"received" | "due">();
  if (q.isLoading) return <Skeleton lines={4} />;
  if (q.error || !q.data) return <ErrorState message="Could not load privacy requests." onRetry={() => q.refetch()} />;
  const open = q.data.filter((r) => !["fulfilled", "declined"].includes(r.status));
  const closed = q.data.filter((r) => ["fulfilled", "declined"].includes(r.status));
  const daysLeft = (r: DataRequest) => Math.ceil((Date.parse(r.slaDueAt) - Date.now()) / 86_400_000);
  return (
    <div className="stack">
      <Card title="Record a request that arrived by email">
        <p className="small muted">Only requests from the shared privacy mailbox. Verification stays pending until you confirm the sender.</p>
        <div className="grid-2">
          <Field label="Customer" htmlFor="pr-co"><select id="pr-co" className="select" value={form.companyId} onChange={(e) => setForm({ ...form, companyId: e.target.value })}><option value="">Choose</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Requester email" htmlFor="pr-em"><input id="pr-em" className="input" type="email" value={form.requesterEmail} onChange={(e) => setForm({ ...form, requesterEmail: e.target.value })} /></Field>
          <Field label="Kind" htmlFor="pr-kind"><select id="pr-kind" className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="What they wrote (summary)" htmlFor="pr-det"><input id="pr-det" className="input" value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} /></Field>
        </div>
        <Button variant="primary" loading={create.isPending} disabled={!form.companyId || !form.requesterEmail} onClick={() => create.mutate()}>Record and acknowledge</Button>
      </Card>
      <Card title={`Open (${open.length})`}>
        {open.length === 0 ? <p className="muted small">None.</p> : (
          <Table head={[s.col("received", "Received", "date"), "Customer", "Kind", "Source", "Verified", "Status", s.col("due", "Due", "date", { first: "ascending" }), "Assigned", ""]} scroll announce={s.announce}>
            {s.apply(open, { received: (r) => Date.parse(r.createdAt), due: (r) => Date.parse(r.slaDueAt) }).map((r) => <tr key={r.id}><td className="small">{new Date(r.createdAt).toLocaleDateString()}</td><td>{r.companyName}</td><td>{KIND_LABEL[r.kind] ?? r.kind}</td><td><Chip tone="source">{SOURCE_LABEL[r.channel] ?? r.channel.replace(/_/g, " ")}</Chip></td><td><Chip tone={r.verificationStatus.startsWith("verified") ? "good" : r.verificationStatus === "failed" ? "critical" : "caution"}>{r.verificationStatus.replace(/_/g, " ")}</Chip></td><td><Chip tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status.replace(/_/g, " ")}</Chip></td><td className="small">{daysLeft(r) < 0 ? <Chip tone="critical">overdue</Chip> : `${daysLeft(r)} days`}</td><td className="small">{r.assignedTo ? "yes" : "nobody"}</td><td><Button size="sm" onClick={() => setOpenId(r.id)}>Open</Button></td></tr>)}
          </Table>
        )}
      </Card>
      {closed.length ? <Card title={`Closed (${closed.length})`}><Table head={["Received", "Customer", "Kind", "Outcome", "Resolved", ""]}>{closed.map((r) => <tr key={r.id}><td className="small">{new Date(r.createdAt).toLocaleDateString()}</td><td>{r.companyName}</td><td>{KIND_LABEL[r.kind] ?? r.kind}</td><td><Chip tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Chip></td><td className="small">{r.resolvedAt ? new Date(r.resolvedAt).toLocaleDateString() : ""}</td><td><Button size="sm" variant="quiet" onClick={() => setOpenId(r.id)}>Open</Button></td></tr>)}</Table></Card> : null}
      {openId ? <PrivacyRequestSheet id={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}

function PrivacyRequestSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "privacy", id], queryFn: () => api.get<DataRequest>(`/api/v1/admin/data-requests/${id}`, reason) });
  const [note, setNote] = useState("");
  const [method, setMethod] = useState("");
  const [resolution, setResolution] = useState("");
  const [field, setField] = useState("phone");
  const [value, setValue] = useState("");
  const [confirmAnon, setConfirmAnon] = useState(false);
  const [counselNote, setCounselNote] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["admin", "privacy"] }); qc.invalidateQueries({ queryKey: ["admin", "privacy", id] }); };
  const act = useMutation({ mutationFn: (input: { path: string; body?: unknown }) => api.post(`/api/v1/admin/data-requests/${id}/${input.path}`, input.body ?? {}, reason), onSuccess: () => { toast("Recorded."); refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "That didn't work.") });
  const r = q.data;
  if (!r) return <Sheet open onClose={onClose} title="Privacy request"><Skeleton lines={6} /></Sheet>;
  const verified = r.verificationStatus.startsWith("verified");
  const closedReq = ["fulfilled", "declined"].includes(r.status);
  return (
    <Sheet open onClose={onClose} title={`${KIND_LABEL[r.kind] ?? r.kind} · ${r.companyName ?? ""}`}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row"><Chip tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status.replace(/_/g, " ")}</Chip><Chip tone={verified ? "good" : "caution"}>{r.verificationStatus.replace(/_/g, " ")}</Chip><span className="small muted">due {new Date(r.slaDueAt).toLocaleDateString()} · reference {r.id.slice(0, 8)}</span></div>
        <Card title="Request">
          <dl className="kv"><dt>From</dt><dd>{r.requesterEmail}</dd><dt>Channel</dt><dd>{r.channel.replace(/_/g, " ")}</dd><dt>Candidate record</dt><dd>{r.candidateId ? "linked" : "not linked"}</dd><dt>Details</dt><dd style={{ whiteSpace: "pre-wrap" }}>{r.details ?? "none"}</dd>{r.verificationNote ? <><dt>Verification</dt><dd>{r.verificationNote}</dd></> : null}{r.escalationId ? <><dt>Escalation</dt><dd><a href={`/recruiter/queue/${r.escalationId}`}>open in the queue</a></dd></> : null}</dl>
        </Card>
        {!closedReq && !verified ? (
          <Card title="Verify the requester">
            <Field label="How you verified (for example: replied from the applying address on 18 Sep)" htmlFor="pr-method"><input id="pr-method" className="input" value={method} onChange={(e) => setMethod(e.target.value)} /></Field>
            <div className="row" style={{ marginTop: 8 }}><Button size="sm" variant="primary" disabled={method.length < 3} loading={act.isPending} onClick={() => act.mutate({ path: "verify", body: { method, outcome: "verified" } })}>Verified</Button><Button size="sm" variant="destructive" disabled={method.length < 3} onClick={() => act.mutate({ path: "verify", body: { method, outcome: "failed" } })}>Could not verify</Button></div>
          </Card>
        ) : null}
        <Card title="Notes">
          {r.notes.length ? <ul className="small" style={{ paddingLeft: 18 }}>{r.notes.map((n, i) => <li key={i}>{new Date(n.at).toLocaleString()} · {n.by}: {n.text}</li>)}</ul> : <p className="small muted">None yet.</p>}
          {!closedReq ? <div className="row" style={{ marginTop: 8 }}><input aria-label="New note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /><Button size="sm" disabled={!note.trim()} onClick={() => { act.mutate({ path: "notes", body: { text: note } }); setNote(""); }}>Add note</Button></div> : null}
          {!closedReq ? <div className="row" style={{ marginTop: 8 }}><Button size="sm" variant="secondary" onClick={() => act.mutate({ path: "assign", body: { userId: "me" } })}>Assign to me</Button></div> : null}
        </Card>
        {r.kind === "delete" && !closedReq ? (
          <Card title="Counsel decision (required before any anonymization)">
            <p className="small muted">Retention rules are under counsel review. Record the decision exactly as counsel gave it. Status: <strong>{r.counselDecision ?? "not asked"}</strong>{r.counselNote ? ` · ${r.counselNote}` : ""}</p>
            <Field label="Note" htmlFor="pr-cn"><input id="pr-cn" className="input" value={counselNote} onChange={(e) => setCounselNote(e.target.value)} /></Field>
            <div className="row" style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => act.mutate({ path: "escalate", body: { note: counselNote || undefined } })}>Send to counsel</Button>
              <Button size="sm" variant="primary" onClick={() => act.mutate({ path: "counsel", body: { decision: "approved", note: counselNote || undefined } })}>Counsel approved</Button>
              <Button size="sm" variant="destructive" onClick={() => act.mutate({ path: "counsel", body: { decision: "declined", note: counselNote || undefined } })}>Counsel declined</Button>
            </div>
          </Card>
        ) : null}
        {!closedReq ? (
          <Card title="Resolve">
            {r.kind === "correct" ? <div className="grid-2"><Field label="Field" htmlFor="pr-field"><select id="pr-field" className="select" value={field} onChange={(e) => setField(e.target.value)}>{["firstName", "lastName", "email", "phone", "locationText"].map((f) => <option key={f} value={f}>{f}</option>)}</select></Field><Field label="Corrected value" htmlFor="pr-value"><input id="pr-value" className="input" value={value} onChange={(e) => setValue(e.target.value)} /></Field></div> : null}
            {r.kind === "delete" ? <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={confirmAnon} onChange={(e) => setConfirmAnon(e.target.checked)} /> I confirm counsel approved this anonymization and I have checked for a litigation hold or a hire.</label> : null}
            {r.kind === "access" ? <p className="small"><a href={`/api/v1/admin/data-requests/${r.id}/export`}>Preview the export file</a> (audited).</p> : null}
            <Field label="What you did (the requester reads this)" htmlFor="pr-res"><textarea id="pr-res" className="textarea" rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} /></Field>
            <div className="row" style={{ marginTop: 8 }}>
              <Button size="sm" variant="primary" disabled={!resolution.trim() || !verified || (r.kind === "correct" && !value) || (r.kind === "delete" && !confirmAnon)} loading={act.isPending} onClick={() => act.mutate({ path: "fulfil", body: { resolution, correction: r.kind === "correct" ? { field, value } : undefined, confirmAnonymize: r.kind === "delete" ? confirmAnon : undefined } })}>Fulfil and confirm to the requester</Button>
              <Button size="sm" variant="destructive" disabled={!resolution.trim()} onClick={() => act.mutate({ path: "decline", body: { resolution } })}>Decline with this explanation</Button>
            </div>
          </Card>
        ) : <Alert tone="info">{r.status === "fulfilled" ? "Fulfilled" : "Declined"} {r.resolvedAt ? new Date(r.resolvedAt).toLocaleString() : ""}: {r.resolution}{r.confirmationSentAt ? " · confirmation sent" : ""}</Alert>}
        {closedReq && r.kind === "delete" && !r.confirmationSentAt ? (
          // the email after the commit failed: nothing retries it on its own, so the console offers it
          <Alert tone="caution">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span>The requester has not been told yet: the confirmation email did not go.</span>
              <Button size="sm" variant="secondary" loading={act.isPending} onClick={() => act.mutate({ path: "confirm-again", body: {} })}>Send the confirmation again</Button>
            </div>
          </Alert>
        ) : null}
      </div>
    </Sheet>
  );
}

type RoleGrant = { id: string; userId: string; email: string; name: string | null; authProvider: string | null; role: string; source: string; grantedBy: { name?: string; id: string }; grantReason: string; grantedAt: string; revokedAt: string | null; revokedBy: { name?: string; id: string } | null; revokeReason: string | null };

/**
 * Platform roles (21 Sep, item 2): the ledger of named people. Grants and revocations need a second factor, a reason,
 * and are seen by every other administrator; nobody can grant themselves anything.
 */
function Administrators() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "platform-roles"], queryFn: () => api.get<{ grants: RoleGrant[]; activeAdmins: number; bootstrap: { configured: number; ignored: boolean } }>("/api/v1/admin/platform-roles", reason) });
  const [form, setForm] = useState({ email: "", role: "its_recruiter", reason: "" });
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState<{ id: string; reason: string } | null>(null);
  const grant = useMutation({ mutationFn: () => api.post("/api/v1/admin/platform-roles", { ...form, confirm: true }, reason), onSuccess: () => { toast("Granted. Every other administrator has been told."); setForm({ email: "", role: "its_recruiter", reason: "" }); setConfirming(false); qc.invalidateQueries({ queryKey: ["admin", "platform-roles"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not grant.") });
  const revoke = useMutation({ mutationFn: (r: { id: string; reason: string }) => api.post(`/api/v1/admin/platform-roles/${r.id}/revoke`, { reason: r.reason, confirm: true }, reason), onSuccess: () => { toast("Revoked. Every other administrator has been told."); setRevoking(null); qc.invalidateQueries({ queryKey: ["admin", "platform-roles"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not revoke.") });
  if (q.isLoading) return <Skeleton lines={4} />;
  if (q.error) return <ErrorState message="Could not load platform roles." onRetry={() => q.refetch()} />;
  const active = q.data!.grants.filter((g) => !g.revokedAt);
  const past = q.data!.grants.filter((g) => g.revokedAt);
  return (
    <div className="stack" style={{ gap: 14 }}>
      {q.data!.bootstrap.ignored ? <Alert tone="caution">BOOTSTRAP_ADMIN_EMAILS is still set but administrators already exist. It grants nothing now; remove it from the environment.</Alert> : null}
      <Card title={`Current platform roles (${q.data!.activeAdmins} administrator${q.data!.activeAdmins === 1 ? "" : "s"})`}>
        <Table head={["Person", "Role", "Granted by", "Reason", "Since", "Actions"]}>
          {active.map((g) => (
            <tr key={g.id}>
              <td>{g.name ?? g.email}<div className="small muted">{g.email}</div></td>
              <td><Chip tone={g.role === "platform_admin" ? "accent" : "neutral"}>{g.role.replace("_", " ")}</Chip></td>
              <td>{g.grantedBy.name ?? g.grantedBy.id}<div className="small muted">{g.source}</div></td>
              <td className="small">{g.grantReason}</td>
              <td className="small">{new Date(g.grantedAt).toLocaleDateString()}</td>
              <td>
                {revoking?.id === g.id ? (
                  <div className="stack" style={{ gap: 6 }}>
                    <Field label="Reason for revoking" htmlFor={`rr-${g.id}`}><input id={`rr-${g.id}`} className="input" value={revoking.reason} onChange={(e) => setRevoking({ id: g.id, reason: e.target.value })} /></Field>
                    <div className="row"><Button size="sm" variant="destructive" disabled={revoking.reason.trim().length < 5} loading={revoke.isPending} onClick={() => revoke.mutate(revoking)}>Revoke now</Button><Button size="sm" variant="quiet" onClick={() => setRevoking(null)}>Cancel</Button></div>
                  </div>
                ) : <Button size="sm" variant="secondary" onClick={() => setRevoking({ id: g.id, reason: "" })}>Revoke</Button>}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Grant a platform role">
        <p className="small muted">The person must already have signed in with Microsoft 365 and a second factor. You cannot grant yourself a role. Every other administrator and the ITS queue mailbox are told, and another administrator must acknowledge the alert.</p>
        <div className="stack" style={{ gap: 8, marginTop: 8, maxWidth: 520 }}>
          <Field label="Staff email" htmlFor="pr-email"><input id="pr-email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Role" htmlFor="pr-role"><select id="pr-role" className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="its_recruiter">ITS recruiter</option><option value="platform_admin">Platform administrator</option></select></Field>
          <Field label="Reason" htmlFor="pr-reason"><input id="pr-reason" className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          {confirming ? (
            <Alert tone="caution"><div className="row" style={{ justifyContent: "space-between" }}><span>Grant {form.role.replace("_", " ")} to {form.email}?</span><span className="row"><Button size="sm" variant="primary" loading={grant.isPending} onClick={() => grant.mutate()}>Yes, grant it</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
          ) : <div className="row"><Button variant="primary" disabled={!form.email.includes("@") || form.reason.trim().length < 5} onClick={() => setConfirming(true)}>Grant</Button></div>}
        </div>
      </Card>
      {past.length ? <Card title="Past roles"><ul className="small" style={{ paddingLeft: 18 }}>{past.map((g) => <li key={g.id}>{g.email} · {g.role.replace("_", " ")} · granted {new Date(g.grantedAt).toLocaleDateString()} by {g.grantedBy.name ?? g.grantedBy.id} · revoked {g.revokedAt ? new Date(g.revokedAt).toLocaleDateString() : ""} by {g.revokedBy?.name ?? g.revokedBy?.id}: {g.revokeReason}</li>)}</ul></Card> : null}
    </div>
  );
}

type OutcomeRow = { id: string; companyName: string; applicationId: string | null; roleId: string | null; milestone: string; outcome: string; hireDate: string | null; offerAcceptedAt: string | null; recordedBy: { name?: string; id: string }; recordedAt: string; correctionOf: string | null; correctedAt: string | null; correctionReason: string | null };

/** Human-recorded hiring outcomes across customers; an administrator corrects one with a reason, and the original stays. */
export function Outcomes() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "outcomes"], queryFn: () => api.get<{ statement: string; outcomes: OutcomeRow[] }>("/api/v1/admin/outcomes", reason) });
  // A correction to "employer declined" is filed under one of the fixed decline reasons (plan G2).
  const [fix, setFix] = useState<{ id: string; outcome: string; hireDate: string; reason: string; declineReason: string } | null>(null);
  const correct = useMutation({ mutationFn: (f: { id: string; outcome: string; hireDate: string; reason: string; declineReason: string }) => api.post(`/api/v1/admin/outcomes/${f.id}/correct`, { confirm: true, reason: f.reason, outcome: f.outcome === "voided" ? undefined : f.outcome, hireDate: f.hireDate || undefined, declineReason: f.outcome === "employer_declined" ? f.declineReason : undefined }, reason), onSuccess: () => { toast("Corrected. The original record stays, marked corrected."); setFix(null); qc.invalidateQueries({ queryKey: ["admin", "outcomes"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not correct.") });
  if (q.isLoading) return <Skeleton lines={4} />;
  if (q.error) return <ErrorState message="Could not load outcomes." onRetry={() => q.refetch()} />;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <Alert tone="info">{q.data!.statement}</Alert>
      <Table head={["Customer", "Level", "Outcome", "Hire date", "Recorded by", "When", "Actions"]} empty="No outcomes recorded yet.">
        {q.data!.outcomes.map((o) => (
          <tr key={o.id}>
            <td>{o.companyName}</td>
            <td>{o.applicationId ? "candidate" : "role"}</td>
            <td><Chip tone={o.correctedAt ? "neutral" : "accent"}>{o.outcome.replace(/_/g, " ")}</Chip>{o.correctedAt ? <div className="small muted">corrected: {o.correctionReason}</div> : null}{o.correctionOf ? <div className="small muted">correction</div> : null}</td>
            <td>{o.hireDate ?? ""}</td>
            <td>{o.recordedBy.name ?? o.recordedBy.id}</td>
            <td className="small">{new Date(o.recordedAt).toLocaleString()}</td>
            <td>{!o.correctedAt ? (fix?.id === o.id ? (
              <div className="stack" style={{ gap: 6 }}>
                <Field label="Corrected outcome" htmlFor={`fx-o-${o.id}`}><select id={`fx-o-${o.id}`} className="select" value={fix.outcome} onChange={(e) => setFix({ ...fix, outcome: e.target.value })}>
                  <option value="voided">Recorded in error (void)</option>
                  {o.applicationId ? <><option value="hired_externally">Hired (outside the platform)</option><option value="offer_declined_externally">Declined an external offer</option><option value="candidate_withdrew">Candidate withdrew</option><option value="employer_declined">Employer declined</option><option value="no_hire">No hire</option></> : <><option value="filled">Filled</option><option value="filled_outside_platform">Filled outside the platform</option><option value="role_cancelled">Cancelled</option><option value="no_hire">No hire</option></>}
                </select></Field>
                {fix.outcome === "hired_externally" ? <Field label="Hire date" htmlFor={`fx-d-${o.id}`}><input id={`fx-d-${o.id}`} className="input" type="date" value={fix.hireDate} onChange={(e) => setFix({ ...fix, hireDate: e.target.value })} /></Field> : null}
                {fix.outcome === "employer_declined" ? <Field label="Decline reason" htmlFor={`fx-dr-${o.id}`}><select id={`fx-dr-${o.id}`} className="select" value={fix.declineReason} onChange={(e) => setFix({ ...fix, declineReason: e.target.value })}>{DECLINE_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field> : null}
                <Field label="Reason for the correction" htmlFor={`fx-r-${o.id}`}><input id={`fx-r-${o.id}`} className="input" value={fix.reason} onChange={(e) => setFix({ ...fix, reason: e.target.value })} /></Field>
                <div className="row"><Button size="sm" variant="primary" disabled={fix.reason.trim().length < 5} loading={correct.isPending} onClick={() => correct.mutate(fix)}>Confirm correction</Button><Button size="sm" variant="quiet" onClick={() => setFix(null)}>Cancel</Button></div>
              </div>
            ) : <Button size="sm" variant="secondary" onClick={() => setFix({ id: o.id, outcome: "voided", hireDate: "", reason: "", declineReason: DECLINE_REASONS[0][0] })}>Correct</Button>) : null}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
