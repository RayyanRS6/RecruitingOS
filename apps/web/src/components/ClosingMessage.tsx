"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Avatar, Button, Card, Chip, cn, ErrorState, Eyebrow, Field, Skeleton } from "@ros/ui";
import { api, ApiError, type ApplicationsWithCounts, type ClosingMessagePreview, type ClosingMessageResult } from "../api/client";
import { toast } from "../toast";
import { CLOSING_SENDERS, closeRoleToast } from "../talent-actions";
import { bulkUndoMillis, closingResultToast, closingSendLabel, closingSheetLines, safetyNetDate, safetyNetPromise, safetyNetShort, undoable } from "../telling";
import { InlineUndo } from "./InlineUndo";
import { useBulkTakeBack, useBulkUndoToast } from "./use-undo";

/**
 * Closing a role and telling the people it leaves (founder decisions B6 and Q30; plan G4). The close card lists who is
 * still in process; closing moves them to the talent pool privately, and then one courteous closing message, seen first,
 * tells all of them with a single approval. Nothing is sent now; "Not now" leaves it on Home, and if nobody tells them
 * the safety net acts after five working days (Q27). Someone who may close a role but not tell candidates (HR) is told
 * who sends it instead of being shown a Send they could not use.
 */

/** What POST /roles/:id/outcome answers that the close card reads. */
type RoleClosed = { movedToTalentPool?: number; heldEmailsAddedToTalentPool?: number; interviewsCancelled?: number; interviewOffNotes?: number; closingMessage?: ClosingMessagePreview | null };

/** The people a close would move: everyone still in process (not hired, not already decided). */
const STILL_IN_PROCESS = (a: ApplicationsWithCounts["applications"][number]) => !["hired", "not_moving_forward"].includes(a.ownerStage) && !["withdrawn", "declined"].includes(a.stage);

/** The people a card names (still in process, or who gets the message): rows in a bordered list on the hero card. */
const PEOPLE = "people-list list-card divide-y divide-line";
const PERSON = "flex min-h-12 flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-2.5 text-[14px]";

/** The outcomes a role closes with, in the team's words. */
const ROLE_OUTCOMES: ReadonlyArray<[string, string]> = [
  ["filled_outside_platform", "Filled outside the platform"],
  ["filled", "Filled with a candidate from here (already recorded on the candidate)"],
  ["role_cancelled", "Cancelled"],
  ["no_hire", "Closed without a hire"],
];

/**
 * "Close this job" on the job page: the outcome, an optional reason, who is still in process (they move to the talent
 * pool privately, with the day the safety net acts if nobody tells them first, and anyone with an interview booked or
 * times offered is told now that it is off), then the closing message for them all.
 */
export function CloseRoleCard({ roleId, initialOutcome, mayTell, onClose }: { roleId: string; initialOutcome: string; /** May tell candidates a decision (application.reject); HR closes roles but does not send the closing message. */ mayTell: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState(initialOutcome);
  const [reason, setReason] = useState("");
  const [closed, setClosed] = useState<ClosingMessagePreview | null>(null);
  const apps = useQuery({ queryKey: ["applications", roleId], queryFn: () => api.get<ApplicationsWithCounts>(`/api/v1/roles/${roleId}/applications?counts=1`) });
  const still = (apps.data?.applications ?? []).filter(STILL_IN_PROCESS);
  const close = useMutation({
    mutationFn: () => api.post<RoleClosed>(`/api/v1/roles/${roleId}/outcome`, { outcome, confirm: true, reason: reason.trim() || undefined }),
    // says who moved to the talent pool privately, which interviews ended, and who was told only that theirs is off (founder decision B6)
    onSuccess: async (res) => {
      const t = closeRoleToast(res, "Role closed; the outcome is recorded with your name.", mayTell);
      toast(t.title, t.detail);
      await Promise.all([qc.invalidateQueries({ queryKey: ["role", roleId] }), qc.invalidateQueries({ queryKey: ["roles"] }), qc.invalidateQueries({ queryKey: ["applications", roleId] }), qc.invalidateQueries({ queryKey: ["brief"] })]);
      if (mayTell && res.closingMessage && (res.closingMessage.count > 0 || res.closingMessage.waitingApprovalId)) setClosed(res.closingMessage);
      else onClose();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not close the job."),
  });
  if (closed) return <ClosingMessageCard roleId={roleId} preview={closed} onDone={onClose} />;
  return (
    // the job page's one next step: the kit sizes the hero title
    <Card needsYou hero title="Close this job">
      {/* kept: who the outcome is recorded against, and that the platform made no offer */}
      <p className="text-[15px] text-ink-2">It is recorded with your name. The platform made no offer.</p>
      <div className="stack mt-5 max-w-[620px] gap-4">
        <Field label="Outcome" htmlFor="rc-outcome"><select id="rc-outcome" className="select" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          {ROLE_OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select></Field>
        <Field label="Reason (optional, kept internally)" htmlFor="rc-reason"><input id="rc-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div>
          <Eyebrow as="h3" className="mb-2 flex">Still in process</Eyebrow>
          {apps.isLoading ? <Skeleton lines={2} /> : apps.error ? <ErrorState message="Could not load who is still in process." onRetry={() => apps.refetch()} /> : still.length ? (
            <>
              <ul className={PEOPLE} aria-label="Still in process">
                {still.map((a) => (
                  <li key={a.id} className={PERSON}><Avatar name={a.candidate?.name ?? "?"} size="sm" /><span className="min-w-0 font-medium text-ink">{a.candidate?.name ?? "A candidate"}</span><span className="muted small ml-auto">{a.ownerStageLabel}</span></li>
                ))}
              </ul>
              <p className="small muted mt-2.5">{still.length === 1 ? "They move" : `These ${still.length} people move`} to your talent pool, privately: nobody is told the decision yet. {safetyNetShort({ policy: null, on: safetyNetDate(new Date().toISOString()), what: "the closing message" })} Anyone with an interview booked or times offered is told now, in a short note that gives no reason, that it is off. {mayTell ? "Next you see the one closing message for all of them before anything goes." : `${CLOSING_SENDERS} then sends them the one closing message; it waits on their Home page.`}</p>
            </>
          ) : <p className="small muted">Nobody is still in process.</p>}
        </div>
        <div className="row pt-1"><Button variant="destructive" loading={close.isPending} onClick={() => close.mutate()}>Confirm and close the job</Button><Button variant="quiet" onClick={onClose}>Keep it open</Button></div>
      </div>
    </Card>
  );
}

/**
 * The one closing message of a closed role (Q30): who it goes to, who is left out and why, the exact words (with "[first
 * name]" for each person's own name), and a single Send that covers everyone, or waits for one approval under "Ask me
 * first". `preview` is the answer that closed the role; without it the card reads it.
 */
export function ClosingMessageCard({ roleId, preview, onDone }: { roleId: string; preview?: ClosingMessagePreview | null; onDone: () => void }) {
  const qc = useQueryClient();
  const bulkUndo = useBulkUndoToast();
  const bulkTakeBack = useBulkTakeBack();
  // After Send, while the messages wait out their Undo window, the card stays with "Undo all" (the keyboard reaches it
  // here, not always on the toast) and a Close button; with nothing to take back it goes at once.
  const [sent, setSent] = useState<{ title: string; detail?: string; items: Array<{ applicationId: string; communicationId: string }>; until: string } | null>(null);
  const q = useQuery({ queryKey: ["closing-message", roleId], queryFn: () => api.get<ClosingMessagePreview>(`/api/v1/roles/${roleId}/closing-message`), enabled: !preview, retry: false });
  const p = preview ?? q.data ?? null;
  const send = useMutation({
    mutationFn: () => api.post<ClosingMessageResult>(`/api/v1/roles/${roleId}/closing-message`, { confirm: true }),
    onSuccess: async (r) => {
      // each message waits out the Undo window (plan G9): "Undo all" takes back every one still waiting
      const t = closingResultToast(r);
      const items = undoable(r.results);
      const ms = bulkUndoMillis(r.results);
      bulkUndo({ roleId, items, ms, title: t.title, detail: items.length ? [t.detail, "Undo all takes back every closing message still waiting."].filter(Boolean).join(" ") : t.detail });
      await Promise.all([qc.invalidateQueries({ queryKey: ["closing-message", roleId] }), qc.invalidateQueries({ queryKey: ["applications", roleId] }), qc.invalidateQueries({ queryKey: ["brief"] }), qc.invalidateQueries({ queryKey: ["application"] })]);
      if (items.length && ms > 0) setSent({ title: t.title, detail: t.detail, items, until: new Date(Date.now() + ms).toISOString() });
      else onDone();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send the closing message."),
  });
  if (sent) {
    return (
      <Card lift title={sent.title} className="motion-safe:animate-enter">
        {sent.detail ? <p className="small text-ink-2">{sent.detail}</p> : null}
        <div className="row mt-4">
          <InlineUndo autoFocus label="Undo all" ariaLabel={`Undo all: take back the ${sent.items.length === 1 ? "closing message" : `${sent.items.length} closing messages`} still waiting`} undoUntil={sent.until} onUndo={async () => { await bulkTakeBack(roleId, sent.items); onDone(); }} />
          <Button size="sm" variant="quiet" onClick={onDone}>Close</Button>
        </div>
      </Card>
    );
  }
  if (!p) {
    if (q.isLoading) return <Card title="The closing message"><Skeleton lines={4} /></Card>;
    return <Card title="The closing message"><ErrorState message={q.error instanceof ApiError ? q.error.message : "Could not load the closing message."} onRetry={() => q.refetch()} /><div className="row mt-3"><Button size="sm" variant="quiet" onClick={onDone}>Close</Button></div></Card>;
  }
  const words = closingSheetLines(p);
  const sendable = p.count > 0 && !p.waitingApprovalId && p.policy !== "not_sent";
  return (
    <Card needsYou={sendable} hero={sendable} lift title={`Tell the people ${p.roleTitle} left in process`}>
      <p className="text-[15px] text-ink-2">{words.lead}</p>
      {p.people.length ? (
        <ul className={cn(PEOPLE, "mt-4")} aria-label="Who gets the closing message">
          {p.people.map((x) => (
            <li key={x.applicationId} className={PERSON}><Avatar name={x.name} size="sm" /><span className="min-w-0 font-medium text-ink">{x.name}</span>{!x.hasEmail ? <Chip tone="caution">No email address</Chip> : null}{x.optedOut ? <Chip>Asked not to be kept</Chip> : null}</li>
          ))}
        </ul>
      ) : null}
      {words.notes.length ? <ul className="small muted mt-3 grid list-disc gap-1 pl-5">{words.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      {p.count > 0 && p.text ? (
        // the words as they go, in a quieter card of the kit's (`message-preview` adds no look: the hook name the candidate
        // panel's message preview has too, where the e2e specs find the words by it)
        <Card className="message-preview mt-4 rounded-xl p-4 shadow-none">
          <p className="mb-2 text-[13px] font-medium text-ink-2">What each of them gets, with their own name</p>
          <p className="small"><strong>{p.subject}</strong></p>
          <p className="small mt-1.5 whitespace-pre-wrap text-ink-2">{p.text}</p>
        </Card>
      ) : null}
      {p.policy === "not_sent" ? <div className="mt-4"><Alert tone="caution">Under your settings no decision messages are sent. Tell each person yourself, then record it on their page.</Alert></div> : null}
      <div className="row mt-5">
        {sendable ? <Button variant="primary" icon="send" loading={send.isPending} onClick={() => send.mutate()}>{closingSendLabel(p)}</Button> : null}
        <Button variant="quiet" onClick={onDone}>{sendable ? "Not now" : "Close"}</Button>
      </div>
      {sendable ? <p className="small muted mt-2">Not now leaves them on your Home page as not told yet. {safetyNetPromise(p.policy, "the closing message")}</p> : null}
    </Card>
  );
}
