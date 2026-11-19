"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminCompany, AdminPlanOption, PlanChange, PlanChangeAnswer, TrialExtensionAnswer, TrialExtensionRequest, TrialStanding } from "@ros/contracts";
import { Alert, Button, Card, ErrorState, Field, Skeleton } from "@ros/ui";
import { api, errorWords } from "../../api/client";
import { toast } from "../../toast";
import { trialDate } from "../../trial";
import { adminKeys, reason } from "./admin-api";
import { REASON_MIN, reasonReady } from "./admin-words";
import { extensionDaysOk, extensionLines, planChangedToast, planLimitsLine, planPriceLine, TRIAL_EXTENSION_MAX_DAYS, trialExtendedTo, trialExtendedToast, trialExtensionQuestion } from "./company-facts";

/** The fields and buttons of a small form. */
const FORM = "grid gap-3";
/** A question to confirm (inside a caution alert): the words, and the buttons on the right. */
const CONFIRM = "flex flex-wrap items-center justify-between gap-x-4 gap-y-2";

/**
 * Change plan: pick a plan, say why, confirm (POST /admin/customers/:id/plan). The new limits apply at once and the
 * change is recorded with the reason. Once changed, `onDone` closes the form.
 *
 * The pick starts from the plan the company is on, and starts again from it when the list read again brings another
 * administrator's change of plan, so the form never offers to undo that change unasked; the reason typed stays.
 */
export function PlanChangeForm({ company, onDone }: { company: Pick<AdminCompany, "id" | "name" | "planKey" | "planName">; onDone: () => void }) {
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: adminKeys.plans, queryFn: () => api.get<AdminPlanOption[]>("/api/v1/admin/plans", reason) });
  const [pick, setPick] = useState(company.planKey);
  const [why, setWhy] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pickedOn, setPickedOn] = useState(company.planKey);
  if (pickedOn !== company.planKey) {
    setPickedOn(company.planKey);
    setPick(company.planKey);
    setConfirming(false);
  }
  // A plan no longer offered that the company is still on stays in the list, or the list would draw its first option
  // as if chosen and offer no change to it.
  const offered = plans.data ?? [];
  const options: AdminPlanOption[] = offered.some((p) => p.key === company.planKey) ? offered : [...offered, { key: company.planKey, name: company.planName, prices: {}, limits: {} }];
  const chosen = options.find((p) => p.key === pick) ?? null;
  const includes = chosen ? [planPriceLine(chosen.prices), planLimitsLine(chosen.limits)].filter(Boolean).join(" · ") : "";
  const save = useMutation({
    mutationFn: (planKey: string) => api.post<PlanChangeAnswer>(`/api/v1/admin/customers/${encodeURIComponent(company.id)}/plan`, { planKey, reason: why.trim() } satisfies PlanChange, reason),
    onSuccess: (r, planKey) => {
      const said = planChangedToast(company.name, options.find((p) => p.key === planKey)?.name ?? planKey, r.trialEnded, r.unlocked, r.aiCreditMonthStarted);
      toast(said.title, said.detail);
      setWhy("");
      setConfirming(false);
      qc.invalidateQueries({ queryKey: adminKeys.companies });
      onDone();
    },
    onError: (e) => { setConfirming(false); toast(errorWords(e, "Could not change the plan.")); },
  });
  if (plans.isLoading) return <Skeleton lines={3} />;
  if (plans.error) return <ErrorState message="Could not load the plans." onRetry={() => plans.refetch()} />;
  return (
    <div className={FORM}>
      <Field label="Plan" htmlFor="plan-pick">
        <select id="plan-pick" className="select" value={pick} onChange={(e) => { setPick(e.target.value); setConfirming(false); }}>
          {options.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
        </select>
      </Field>
      {includes ? <p className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink-2">{includes}</p> : null}
      {pick !== company.planKey ? (
        <>
          <Field label="Why (required, kept with the change)" htmlFor="plan-why" hint={`At least ${REASON_MIN} characters.`}><input id="plan-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
          {confirming ? (
            <Alert tone="caution"><div className={CONFIRM}><span>Put {company.name} on {chosen?.name ?? pick}?</span><span className="row"><Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(pick)}>Yes, change it</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
          ) : <div className="row"><Button variant="primary" disabled={!reasonReady(why)} onClick={() => setConfirming(true)}>Change plan</Button><Button variant="quiet" onClick={onDone}>Cancel</Button></div>}
        </>
      ) : <div className="row"><Button variant="quiet" onClick={onDone}>Cancel</Button></div>}
    </div>
  );
}

/**
 * The trial of a company on the Trial plan whose days have started: when it ends (or that it ended, and what is
 * paused), each extension so far with its reason, and "Extend the trial": a number of days (1 to 90) and a reason, then
 * a second press. The new end counts from the later of the old end and today (POST /admin/customers/:id/trial).
 *
 * The question stands on the end it was asked on: another administrator's extension read in under it takes it away,
 * so its date never moves under a pending Yes that would add the days a second time; the days and the reason stay.
 */
export function TrialCard({ company, trial }: { company: Pick<AdminCompany, "id" | "name" | "timezone" | "trialTerm">; trial: TrialStanding }) {
  const qc = useQueryClient();
  const [days, setDays] = useState("14");
  const [why, setWhy] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [askedOn, setAskedOn] = useState(trial.endsAt);
  if (askedOn !== trial.endsAt) {
    setAskedOn(trial.endsAt);
    setConfirming(false);
  }
  const count = Number(days);
  const ready = extensionDaysOk(count) && reasonReady(why);
  const to = trialExtendedTo(trial, extensionDaysOk(count) ? count : 0);
  const extend = useMutation({
    mutationFn: () => api.post<TrialExtensionAnswer>(`/api/v1/admin/customers/${encodeURIComponent(company.id)}/trial`, { days: count, reason: why.trim(), confirm: true } satisfies TrialExtensionRequest, reason),
    onSuccess: (r) => {
      toast(trialExtendedToast(r.trial?.endsAt ?? to, company.timezone));
      setWhy("");
      setConfirming(false);
      qc.invalidateQueries({ queryKey: adminKeys.companies });
    },
    onError: (e) => { setConfirming(false); toast(errorWords(e, "Could not extend the trial.")); },
  });
  const ends = trialDate(trial.endsAt ?? "", company.timezone);
  return (
    <Card title="Trial">
      <div className="grid gap-1.5">
        <p className="text-sm text-ink">{trial.ended ? `The trial ended on ${ends}: new applications, new jobs and new AI interviews are paused.` : `The trial ends on ${ends}.`}</p>
        {extensionLines(company.trialTerm, company.timezone).map((line) => <p key={line.key} className="small muted wrap-anywhere">{line.text}</p>)}
      </div>
      <div className={`${FORM} mt-4`}>
        <Field label="Days to add" htmlFor="trial-days" hint={`From 1 to ${TRIAL_EXTENSION_MAX_DAYS}, counted from the later of the end and today.`}><input id="trial-days" className="input" type="number" inputMode="numeric" min={1} max={TRIAL_EXTENSION_MAX_DAYS} step={1} value={days} onChange={(e) => { setDays(e.target.value); setConfirming(false); }} /></Field>
        <Field label="Why (required, kept with the change)" htmlFor="trial-why" hint={`At least ${REASON_MIN} characters.`}><input id="trial-why" className="input" value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
        {confirming ? (
          <Alert tone="caution"><div className={CONFIRM}><span>{trialExtensionQuestion(company.name, count, to, company.timezone)}</span><span className="row"><Button size="sm" variant="primary" loading={extend.isPending} onClick={() => extend.mutate()}>Yes, extend it</Button><Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>No</Button></span></div></Alert>
        ) : <div className="row"><Button variant="primary" disabled={!ready} onClick={() => setConfirming(true)}>Extend the trial</Button></div>}
      </div>
    </Card>
  );
}
