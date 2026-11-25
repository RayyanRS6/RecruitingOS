"use client";

import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UPGRADE_SHEET_LINE, type PlanRequest, type PlanRequestSent, type PublicPlan, type PublicPlans } from "@ros/contracts";
import { Alert, Button, Chip, Drawer, ErrorState, Field, Skeleton } from "@ros/ui";
import { api, errorWords } from "../api/client";
import { toast } from "../toast";
import { firstChoice, planFacts, priceWords, requestSentWords } from "../upgrade";

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
 * The short sheet behind every Upgrade: the plans side by side with the company's own marked, an optional note, one
 * button and the one plain line that nothing is charged. It sends one request to ITS (POST /api/v1/plans/request),
 * which stays open until ITS changes the plan. With a request already open it says when it was sent and asks nothing
 * more. For a company with nothing above its plan (the answer's `mayUpgrade` is false: the last plan, or the private
 * pilot) the title and the button ask about the plan, as the "Talk to ITS" button that opened the sheet did.
 */
export function UpgradeSheet(props: { reason?: string; onClose: () => void }) {
  const qc = useQueryClient();
  const name = useId();
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["plans"], queryFn: () => api.get<PublicPlans>("/api/v1/plans") });
  const plans = q.data?.plans ?? [];
  const choice = plans.find((p) => p.key === picked && !p.current) ?? firstChoice(plans);
  // Nothing is above their plan (the last plan, or the private pilot): the same sheet, and the same request, in words
  // that say so. The server's answer (`mayOfferUpgrade`, the rule its "Talk to ITS" buttons follow), never worked out here.
  const nothingAbove = q.data?.mayUpgrade === false;
  const send = useMutation({
    mutationFn: (plan: PublicPlan | null) => {
      const body: PlanRequest = { ...(plan ? { planKey: plan.key } : {}), ...(props.reason ? { reason: props.reason } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
      return api.post<PlanRequestSent>("/api/v1/plans/request", body);
    },
    onSuccess: (r) => {
      setDone(`${requestSentWords(r.requestedAt)}.`);
      if (!r.alreadyAsked) toast("Sent to ITS.");
      for (const key of [["plans"], ["company"], ["home"]]) qc.invalidateQueries({ queryKey: key });
    },
  });
  return (
    <Drawer open onClose={props.onClose} title={nothingAbove ? "Your plan" : "Upgrade"} size="lg">
      {done ? (
        <div className="stack gap-4 motion-safe:animate-enter motion-safe:[animation-fill-mode:backwards]">
          <Alert tone="info">{done} {UPGRADE_SHEET_LINE}</Alert>
          <div className="row"><Button onClick={props.onClose}>Done</Button></div>
        </div>
      ) : q.isLoading ? <Skeleton lines={6} /> : q.error || !q.data ? <ErrorState message="Could not load the plans." onRetry={() => q.refetch()} /> : (
        <div className="stack gap-5">
          {q.data.requestedAt ? <Alert tone="info">{requestSentWords(q.data.requestedAt)}. {UPGRADE_SHEET_LINE}</Alert> : null}
          <fieldset className="min-w-0">
            <legend className="sr-only">Which plan</legend>
            {/* side by side once the sheet has room for four (a container query, so a phone stacks them) */}
            <div className="@container">
              <div className="grid gap-2.5 @lg:grid-cols-2 @xl:grid-cols-4">
                {plans.map((p) => p.current || q.data.requestedAt ? (
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
          {q.data.requestedAt ? null : (
            <>
              <Field label="A note for ITS (optional)" htmlFor={`${name}-note`}><textarea id={`${name}-note`} className="textarea" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <div className="stack gap-3 border-t border-line pt-5">
                <p className="small text-ink-2">{UPGRADE_SHEET_LINE}</p>
                {send.error ? <Alert tone="critical">{errorWords(send.error, "Could not send.")}</Alert> : null}
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
 * The one way to ask for a bigger plan, wherever the plan stops something. `reason`: why the person got here, sent with
 * the request. While a request is with ITS, the day it was sent stands in place of the button. `requestedAt`: when the
 * page already knows whether a request is open (Settings reads it with the plan), so nothing is asked for until the
 * sheet opens; left out, the button finds out itself.
 */
export function Upgrade(props: { label?: string; size?: "sm" | "md"; variant?: "primary" | "secondary"; reason?: string; requestedAt?: string | null }) {
  const [open, setOpen] = useState(false);
  const known = props.requestedAt !== undefined;
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => api.get<PublicPlans>("/api/v1/plans"), enabled: !known });
  const requestedAt = known ? props.requestedAt : plans.data?.requestedAt;
  if (requestedAt && !open) return <span className="small muted">{requestSentWords(requestedAt)}</span>;
  return (
    <>
      <Button variant={props.variant ?? "secondary"} size={props.size ?? "md"} icon="arrow-up-right" onClick={() => setOpen(true)}>{props.label ?? "Upgrade"}</Button>
      {open ? <UpgradeSheet reason={props.reason} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
