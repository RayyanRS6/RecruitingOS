"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Avatar, Button, Card, Chip, ErrorState, Field, Skeleton } from "@ros/ui";
import { api, ApiError, type ApplicationsWithCounts, type ClosingMessagePreview, type ClosingMessageResult } from "../api/client";
import { toast } from "../toast";
import { closeRoleToast } from "../talent-actions";
import { bulkUndoMillis, closingResultToast, closingSendLabel, closingSheetLines, undoable } from "../telling";
import { useBulkUndoToast } from "./use-undo";

/**
 * Closing a role and telling the people it leaves (founder decisions B6 and Q30; plan G4). The close card lists who is
 * still in process; closing moves them to the talent pool privately, and then one courteous closing message, seen first,
 * tells all of them with a single approval. Nothing is sent until that one press; "Not now" leaves it on Today.
 */

/** What POST /roles/:id/outcome answers that the close card reads. */
type RoleClosed = { movedToTalentPool?: number; heldEmailsAddedToTalentPool?: number; interviewsCancelled?: number; interviewOffNotes?: number; closingMessage?: ClosingMessagePreview | null };

/** The people a close would move: everyone still in process (not hired, not already decided). */
const STILL_IN_PROCESS = (a: ApplicationsWithCounts["applications"][number]) => !["hired", "not_moving_forward"].includes(a.ownerStage) && !["withdrawn", "declined"].includes(a.stage);

/** The outcomes a role closes with, in the team's words. */
const ROLE_OUTCOMES: ReadonlyArray<[string, string]> = [
  ["filled_outside_platform", "Filled outside the platform"],
  ["filled", "Filled with a candidate from here (already recorded on the candidate)"],
  ["role_cancelled", "Cancelled"],
  ["no_hire", "Closed without a hire"],
];

/**
 * "Close this role" on the role page: the outcome, an optional reason, who is still in process (they move to the talent
 * pool privately, and anyone with an interview booked or times offered is told now that it is off), then the closing
 * message for them all.
 */
export function CloseRoleCard({ roleId, initialOutcome, onClose }: { roleId: string; initialOutcome: string; onClose: () => void }) {
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
      const t = closeRoleToast(res, "Role closed; the outcome is recorded with your name.");
      toast(t.title, t.detail);
      await Promise.all([qc.invalidateQueries({ queryKey: ["role", roleId] }), qc.invalidateQueries({ queryKey: ["roles"] }), qc.invalidateQueries({ queryKey: ["applications", roleId] }), qc.invalidateQueries({ queryKey: ["brief"] })]);
      if (res.closingMessage && (res.closingMessage.count > 0 || res.closingMessage.waitingApprovalId)) setClosed(res.closingMessage);
      else onClose();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not close the role."),
  });
  if (closed) return <ClosingMessageCard roleId={roleId} preview={closed} onDone={onClose} />;
  return (
    <Card needsYou title="Close this role">
      <p className="small" style={{ color: "var(--ink-2)" }}>Say what happened. It is recorded with your name. The platform made no offer.</p>
      <div className="stack" style={{ gap: 10, marginTop: 8, maxWidth: 620 }}>
        <Field label="Outcome" htmlFor="rc-outcome"><select id="rc-outcome" className="select" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          {ROLE_OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select></Field>
        <Field label="Reason (optional, kept internally)" htmlFor="rc-reason"><input id="rc-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <div>
          <h3 className="small" style={{ margin: "0 0 6px" }}>Still in process</h3>
          {apps.isLoading ? <Skeleton lines={2} /> : apps.error ? <ErrorState message="Could not load who is still in process." onRetry={() => apps.refetch()} /> : still.length ? (
            <>
              <ul className="people-list" aria-label="Still in process">
                {still.map((a) => (
                  <li key={a.id}><Avatar name={a.candidate?.name ?? "?"} size="sm" /><span>{a.candidate?.name ?? "A candidate"}</span><span className="muted small">{a.ownerStageLabel}</span></li>
                ))}
              </ul>
              <p className="small muted" style={{ margin: "6px 0 0" }}>{still.length === 1 ? "They move" : `These ${still.length} people move`} to your talent pool, privately: nobody is told the decision yet. Anyone with an interview booked or times offered is told now, in a short note that gives no reason, that it is off. Next you see the one closing message for all of them before anything goes.</p>
            </>
          ) : <p className="small muted" style={{ margin: 0 }}>Nobody is still in process.</p>}
        </div>
        <div className="row"><Button variant="destructive" loading={close.isPending} onClick={() => close.mutate()}>Confirm and close the role</Button><Button variant="quiet" onClick={onClose}>Keep it open</Button></div>
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
  const q = useQuery({ queryKey: ["closing-message", roleId], queryFn: () => api.get<ClosingMessagePreview>(`/api/v1/roles/${roleId}/closing-message`), enabled: !preview, retry: false });
  const p = preview ?? q.data ?? null;
  const send = useMutation({
    mutationFn: () => api.post<ClosingMessageResult>(`/api/v1/roles/${roleId}/closing-message`, { confirm: true }),
    onSuccess: async (r) => {
      // each message waits out the Undo window (plan G9): "Undo all" takes back every one still waiting
      const t = closingResultToast(r);
      const items = undoable(r.results);
      bulkUndo({ roleId, items, ms: bulkUndoMillis(r.results), title: t.title, detail: items.length ? [t.detail, "Undo all takes back every closing message still waiting."].filter(Boolean).join(" ") : t.detail });
      await Promise.all([qc.invalidateQueries({ queryKey: ["closing-message", roleId] }), qc.invalidateQueries({ queryKey: ["applications", roleId] }), qc.invalidateQueries({ queryKey: ["brief"] }), qc.invalidateQueries({ queryKey: ["application"] })]);
      onDone();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send the closing message."),
  });
  if (!p) {
    if (q.isLoading) return <Card title="The closing message"><Skeleton lines={4} /></Card>;
    return <Card title="The closing message"><ErrorState message={q.error instanceof ApiError ? q.error.message : "Could not load the closing message."} onRetry={() => q.refetch()} /><div className="row" style={{ marginTop: 8 }}><Button size="sm" variant="quiet" onClick={onDone}>Close</Button></div></Card>;
  }
  const words = closingSheetLines(p);
  const sendable = p.count > 0 && !p.waitingApprovalId && p.policy !== "not_sent";
  return (
    <Card needsYou={sendable} lift title={`Tell the people ${p.roleTitle} left in process`}>
      <p className="small" style={{ color: "var(--ink-2)" }}>{words.lead}</p>
      {p.people.length ? (
        <ul className="people-list" aria-label="Who gets the closing message">
          {p.people.map((x) => (
            <li key={x.applicationId}><Avatar name={x.name} size="sm" /><span>{x.name}</span>{!x.hasEmail ? <Chip tone="caution">No email address</Chip> : null}{x.optedOut ? <Chip>Asked not to be kept</Chip> : null}</li>
          ))}
        </ul>
      ) : null}
      {words.notes.length ? <ul className="small muted" style={{ margin: "8px 0 0", paddingLeft: 18 }}>{words.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      {p.count > 0 && p.text ? (
        <div className="card message-preview" style={{ marginTop: 10 }}>
          <p className="small muted" style={{ margin: "0 0 6px" }}>What each of them gets, with their own name</p>
          <p className="small" style={{ margin: 0 }}><strong>{p.subject}</strong></p>
          <p className="small" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{p.text}</p>
        </div>
      ) : null}
      {p.policy === "not_sent" ? <Alert tone="caution">Under your settings no decision messages are sent. Tell each person yourself, then record it on their page.</Alert> : null}
      <div className="row" style={{ marginTop: 10 }}>
        {sendable ? <Button size="sm" variant="primary" icon="send" loading={send.isPending} onClick={() => send.mutate()}>{closingSendLabel(p)}</Button> : null}
        <Button size="sm" variant="quiet" onClick={onDone}>{sendable ? "Not now" : "Close"}</Button>
      </div>
      {sendable ? <p className="small muted" style={{ marginTop: 6 }}>Not now leaves them on Today as not told yet; nothing is sent until someone sends it.</p> : null}
    </Card>
  );
}
