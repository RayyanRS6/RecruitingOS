"use client";

import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PLAN_REQUEST_OPEN_LINE, UPGRADE_SHEET_LINE, planRequestQuestion, type PublicPlan, type PublicPlans } from "@ros/contracts";
import { Alert, Button, Chip, Drawer, ErrorState, Field, Skeleton } from "@ros/ui";
import { api, ApiError } from "../api/client";
import { toast } from "../toast";
import { firstChoice, planFacts, priceWords } from "../upgrade";
import { useAskRole } from "./use-ask-role";

/** One plan in the sheet: its name, what it costs and what it includes. The kit's option row, stacked. */
const PLAN = "option-row min-w-0 flex-col items-stretch gap-2.5";

function PlanWords({ plan }: { plan: PublicPlan }) {
  const price = priceWords(plan.monthlyUsd);
  return (
    <>
      <span className="flex flex-wrap items-baseline gap-x-1.5"><span className="font-display text-xl font-bold tracking-[-0.015em] tabular-nums text-ink">{price.amount}</span>{" "}{price.per ? <span className="text-[13px] text-ink-3">{price.per}</span> : null}</span>
      <span className="grid gap-1.5 text-[13px] leading-snug">
        {planFacts(plan).map((f) => <span key={f.label} className="grid"><span className="text-ink-3">{f.label}</span><span className="font-medium text-ink">{f.value}</span></span>)}
      </span>
    </>
  );
}

/**
 * The short sheet behind every Upgrade: the four plans side by side with the company's own marked, an optional note, one
 * button "Ask ITS to upgrade" and the one plain line that nothing is charged. It sends the same request as any other (POST
 * /escalations, `topic: "plan"`), which is never counted and gives ITS no access to the company's hiring, so nothing here
 * speaks of access. With a request already open it says so and asks nothing more.
 */
export function UpgradeSheet(props: { reason?: string; onClose: () => void; onSent?: (message: string) => void }) {
  const qc = useQueryClient();
  const name = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["plans"], queryFn: () => api.get<PublicPlans>("/api/v1/plans") });
  const plans = q.data?.plans ?? [];
  const choice = plans.find((p) => p.key === picked && !p.current) ?? firstChoice(plans);
  // On the last plan nothing is above theirs: the same sheet, and the same request, in words that say so.
  const nothingAbove = !!plans[plans.length - 1]?.current;
  const send = useMutation({
    mutationFn: (plan: PublicPlan | null) => api.post<{ id: string; message: string; alreadyAsked?: boolean }>("/api/v1/escalations", { kind: "ask", scope: "company", topic: "plan", question: planRequestQuestion(plan?.name ?? null, { reason: props.reason, note }) }),
    onSuccess: (r) => {
      setDone(r.message);
      if (!r.alreadyAsked) toast("Sent to ITS.");
      props.onSent?.(r.message);
      qc.invalidateQueries({ queryKey: ["plans"] });
      qc.invalidateQueries({ queryKey: ["escalations", "mine"] });
      qc.invalidateQueries({ queryKey: ["brief"] });
    },
  });
  return (
    <Drawer open onClose={props.onClose} title={nothingAbove ? "Your plan" : "Upgrade"} size="lg">
      {done ? (
        <div className="stack gap-4 motion-safe:animate-enter motion-safe:[animation-fill-mode:backwards]">
          <Alert tone="info">{done} You can follow it under Your recruiter requests on Home.</Alert>
          <div className="row"><Button onClick={props.onClose}>Done</Button></div>
        </div>
      ) : q.isLoading ? <Skeleton lines={6} /> : q.error || !q.data ? <ErrorState message="Could not load the plans." onRetry={() => q.refetch()} /> : (
        <div className="stack gap-5">
          {q.data.requested ? <Alert tone="info">{PLAN_REQUEST_OPEN_LINE}</Alert> : null}
          <fieldset className="min-w-0">
            <legend className="sr-only">Which plan</legend>
            {/* side by side once the sheet has room for four (a container query, so a phone stacks them) */}
            <div className="@container">
              <div className="grid gap-2.5 @lg:grid-cols-2 @xl:grid-cols-4">
                {plans.map((p) => p.current || q.data.requested ? (
                  // the company's own plan, or a request already with ITS: nothing to choose, so no radio
                  <div key={p.key} className={`${PLAN} cursor-default`}>
                    <span className="flex flex-wrap items-center justify-between gap-1.5"><strong className="font-semibold text-ink">{p.name}</strong>{p.current ? <Chip tone="accent">Your plan</Chip> : null}</span>
                    <PlanWords plan={p} />
                  </div>
                ) : (
                  <label key={p.key} className={PLAN}>
                    <span className="flex items-center gap-2"><input type="radio" name={name} value={p.key} checked={choice?.key === p.key} onChange={() => setPicked(p.key)} /><strong className="font-semibold text-ink">{p.name}</strong></span>
                    <PlanWords plan={p} />
                  </label>
                ))}
              </div>
            </div>
          </fieldset>
          {q.data.requested ? null : (
            <>
              <Field label="A note for ITS (optional)" htmlFor={`${name}-note`}><textarea id={`${name}-note`} className="textarea" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <div className="stack gap-3 border-t border-line pt-5">
                <p className="small text-ink-2">{UPGRADE_SHEET_LINE}</p>
                {send.error ? <Alert tone="critical">{send.error instanceof ApiError ? send.error.message : "Could not send."}</Alert> : null}
                <div className="row"><Button variant="primary" loading={send.isPending} onClick={() => send.mutate(choice)}>{nothingAbove ? "Ask ITS about our plan" : "Ask ITS to upgrade"}</Button></div>
              </div>
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

/**
 * The one way to ask for a bigger plan (the plans of 5 November 2026, Rule 5), used by the room alert, the team card, Settings,
 * Home's rows and the locked card. `reason`: why the person got here, sent after the plan's name. Shown only to someone at
 * the company who may ask: ITS staff inside a customer ask nothing about its plan. When payments come, only this changes.
 */
export function Upgrade(props: { label?: string; size?: "sm" | "md"; variant?: "primary" | "secondary"; reason?: string; onSent?: (message: string) => void }) {
  const who = useAskRole();
  const [open, setOpen] = useState(false);
  if (!who.ready || !who.mayAsk || who.staff) return null;
  return (
    <>
      <Button variant={props.variant ?? "secondary"} size={props.size ?? "md"} icon="arrow-up-right" onClick={() => setOpen(true)}>{props.label ?? "Upgrade"}</Button>
      {open ? <UpgradeSheet reason={props.reason} onSent={props.onSent} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
