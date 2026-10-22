"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, cn, Drawer, ErrorState, Field, Table } from "@ros/ui";
import { api, ApiError } from "../../api/client";
import { toast } from "../../toast";
import { DECLINE_REASONS } from "../candidate-panel/helpers";
import { reason } from "./admin-api";
import { exactWhen, firstUpper, plainCode, whenWords } from "./admin-words";

/*
 * The hiring outcomes, the second part of the console's Customers section (redesign spec 3.2, Wave S6): five columns,
 * and the correction form in a drawer of its own (the same fields, the same reason rule and decline reasons as before).
 */

type OutcomeRow = { id: string; companyName: string; applicationId: string | null; roleId: string | null; milestone: string; outcome: string; hireDate: string | null; offerAcceptedAt: string | null; recordedBy: { name?: string; id: string }; recordedAt: string; correctionOf: string | null; correctedAt: string | null; correctionReason: string | null };

/** A correction being written: the corrected outcome (or "voided"), the hire date, the reason and the decline reason. */
type Fix = { id: string; outcome: string; hireDate: string; reason: string; declineReason: string };

/** "hired_externally" -> "Hired externally": an outcome code in words. */
export function outcomeWords(code: string): string {
  return firstUpper(plainCode(code));
}

/** Whether an outcome was recorded for one candidate or for the whole job. */
export function outcomeLevel(o: Pick<OutcomeRow, "applicationId">): string {
  return o.applicationId ? "For a candidate" : "For the job";
}

/** A cell's first line: 14 px in ink; its second lines are `.small.muted` (13 px, --ink-3). */
const LINE = "text-sm text-ink";

/**
 * The facts of one record as "at a glance" rows (screenshot 7's side card), for a `<dl>` of dt/dd pairs: the label over
 * its fact on a phone, beside it from 640 px, a hairline between rows; a chip after a line of words sits a little lower.
 * From 640 px the space between label and fact is inside the fact (no column gap), so each hairline runs unbroken.
 * The customer drawer's Overview uses it too.
 */
export const GLANCE = "grid grid-cols-1 text-sm text-ink sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)] sm:[&>dd]:pl-5 [&>dt]:border-t [&>dt]:border-line [&>dt]:pt-3 [&>dt]:text-[13px] [&>dt]:text-ink-3 [&>dd]:min-w-0 [&>dd]:break-words [&>dd]:pt-1 [&>dd]:pb-3 sm:[&>dt]:pb-3 sm:[&>dd]:border-t sm:[&>dd]:border-line sm:[&>dd]:pt-3 [&>dt:first-of-type]:border-t-0 [&>dt:first-of-type]:pt-0 sm:[&>dd:first-of-type]:border-t-0 sm:[&>dd:first-of-type]:pt-0 [&>dd:last-of-type]:pb-0 sm:[&>dt:last-of-type]:pb-0 [&>dd>div+.chip]:mt-1.5";

/** Human-recorded hiring outcomes across customers; an administrator corrects one with a reason, and the original stays. */
export function Outcomes() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "outcomes"], queryFn: () => api.get<{ statement: string; outcomes: OutcomeRow[] }>("/api/v1/admin/outcomes", reason) });
  // A correction to "employer declined" is filed under one of the fixed decline reasons (plan G2).
  const [fix, setFix] = useState<Fix | null>(null);
  const correct = useMutation({ mutationFn: (f: Fix) => api.post(`/api/v1/admin/outcomes/${f.id}/correct`, { confirm: true, reason: f.reason, outcome: f.outcome === "voided" ? undefined : f.outcome, hireDate: f.hireDate || undefined, declineReason: f.outcome === "employer_declined" ? f.declineReason : undefined }, reason), onSuccess: () => { toast("Corrected. The original record stays, marked corrected."); setFix(null); qc.invalidateQueries({ queryKey: ["admin", "outcomes"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not correct.") });
  if (q.error) return <ErrorState message="Could not load outcomes." onRetry={() => q.refetch()} />;
  const fixing = fix ? (q.data?.outcomes.find((o) => o.id === fix.id) ?? null) : null;
  return (
    <div className="stack gap-4">
      {q.data ? <Alert tone="info">{q.data.statement}</Alert> : null}
      <Table head={["Customer", "What was recorded", "Hire date", "Recorded by", ""]} label="Hiring outcomes" loading={q.isLoading ? 4 : undefined} empty="No outcomes recorded yet.">
        {(q.data?.outcomes ?? []).map((o) => (
          <tr key={o.id}>
            <td><div className={cn(LINE, "font-semibold")}>{o.companyName}</div></td>
            <td>
              <div className="grid justify-items-start gap-1">
                <Chip tone={o.correctedAt ? "neutral" : "accent"}>{outcomeWords(o.outcome)}</Chip>
                <div className="small muted">{outcomeLevel(o)}{o.correctionOf ? " · a correction" : ""}</div>
                {o.correctedAt ? <div className="small muted">Corrected: {o.correctionReason}</div> : null}
              </div>
            </td>
            <td><div className={cn(LINE, "tabular-nums whitespace-nowrap")}>{o.hireDate ?? ""}</div></td>
            <td>
              <div className={LINE}>{o.recordedBy.name ?? o.recordedBy.id}</div>
              <div className="small muted" title={exactWhen(o.recordedAt)}>{whenWords(o.recordedAt)}</div>
            </td>
            <td className="text-right">{o.correctedAt ? null : <Button size="sm" variant="secondary" ariaLabel={`Correct the outcome for ${o.companyName}`} onClick={() => setFix({ id: o.id, outcome: "voided", hireDate: "", reason: "", declineReason: DECLINE_REASONS[0][0] })}>Correct</Button>}</td>
          </tr>
        ))}
      </Table>
      {fix && fixing ? <CorrectionDrawer o={fixing} fix={fix} onChange={setFix} onConfirm={() => correct.mutate(fix)} pending={correct.isPending} onClose={() => setFix(null)} /> : null}
    </div>
  );
}

/** The correction form, moved out of the table's cell into a drawer: what was recorded on top, then the same fields. */
function CorrectionDrawer({ o, fix, onChange, onConfirm, pending, onClose }: { o: OutcomeRow; fix: Fix; onChange: (f: Fix) => void; onConfirm: () => void; pending: boolean; onClose: () => void }) {
  return (
    <Drawer open onClose={onClose} title="Correct an outcome" sub={`${o.companyName} · ${outcomeWords(o.outcome)}`}>
      <div className="stack gap-5">
        <Card className="p-5 sm:px-6">
          <dl className={GLANCE}>
            <dt>Customer</dt>
            <dd>{o.companyName}</dd>
            <dt>Recorded</dt>
            <dd>{outcomeWords(o.outcome)} · {outcomeLevel(o).toLowerCase()}</dd>
            <dt>Hire date</dt>
            <dd>{o.hireDate ?? "None"}</dd>
            <dt>Recorded by</dt>
            <dd>{o.recordedBy.name ?? o.recordedBy.id}, {exactWhen(o.recordedAt)}</dd>
          </dl>
        </Card>
        <p className="text-sm text-ink-2">The original record stays, marked corrected.</p>
        <div className="stack gap-3">
          <Field label="Corrected outcome" htmlFor={`fx-o-${o.id}`}>
            <select id={`fx-o-${o.id}`} className="select" value={fix.outcome} onChange={(e) => onChange({ ...fix, outcome: e.target.value })}>
              <option value="voided">Recorded in error (void)</option>
              {o.applicationId ? <><option value="hired_externally">Hired (outside the platform)</option><option value="offer_declined_externally">Declined an external offer</option><option value="candidate_withdrew">Candidate withdrew</option><option value="employer_declined">Employer declined</option><option value="no_hire">No hire</option></> : <><option value="filled">Filled</option><option value="filled_outside_platform">Filled outside the platform</option><option value="role_cancelled">Cancelled</option><option value="no_hire">No hire</option></>}
            </select>
          </Field>
          {fix.outcome === "hired_externally" ? <Field label="Hire date" htmlFor={`fx-d-${o.id}`}><input id={`fx-d-${o.id}`} className="input" type="date" value={fix.hireDate} onChange={(e) => onChange({ ...fix, hireDate: e.target.value })} /></Field> : null}
          {fix.outcome === "employer_declined" ? <Field label="Decline reason" htmlFor={`fx-dr-${o.id}`}><select id={`fx-dr-${o.id}`} className="select" value={fix.declineReason} onChange={(e) => onChange({ ...fix, declineReason: e.target.value })}>{DECLINE_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field> : null}
          <Field label="Reason for the correction" htmlFor={`fx-r-${o.id}`}><input id={`fx-r-${o.id}`} className="input" value={fix.reason} onChange={(e) => onChange({ ...fix, reason: e.target.value })} /></Field>
          <div className="row"><Button variant="primary" disabled={fix.reason.trim().length < 5} loading={pending} onClick={onConfirm}>Confirm correction</Button><Button variant="quiet" onClick={onClose}>Cancel</Button></div>
        </div>
      </div>
    </Drawer>
  );
}
