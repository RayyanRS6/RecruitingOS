"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CANDIDATE_ACTION_LABEL, type ActionResult, type ApplicationAction, type BulkActionResult, type BulkApplicationAction, type BulkCandidateAction, type CandidateAction } from "@ros/contracts";
import { api, errorWords, planLimitOf } from "../../api/client";
import { batches, mergeBulk, refusedLines, undoMillis, type BulkButton } from "../../candidates";
import { toast } from "../../toast";

/** What is said when an action is refused: the server's sentence, and the request about the plan when the plan is why. */
export type ActionProblem = { message: string; ask: { label: string; reason: string } | null };

/**
 * Doing something with a candidate, from a row, from the bar for several ticked people, or from the panel. One action
 * for one person is POST /applications/:id/actions; the same action for several is POST /roles/:id/applications/actions,
 * a hundred people a request. The server says what happened in its own sentence, which is the toast. After "Email the
 * decision" the toast carries "Don't send" for as long as the email still waits. Everything that shows the job's people
 * is read again afterwards, also after a refusal, since a refusal means the page was out of date.
 */
export function useCandidateActions(roleId: string) {
  const qc = useQueryClient();
  const [problem, setProblem] = useState<ActionProblem | null>(null);
  const [refused, setRefused] = useState<string[]>([]);
  const refresh = () => {
    for (const key of [["candidates", roleId], ["candidate"], ["role", roleId], ["roles"], ["home"]]) qc.invalidateQueries({ queryKey: key });
  };
  const failed = (err: unknown) => {
    setProblem({ message: errorWords(err), ask: planLimitOf(err)?.ask ?? null });
    refresh();
  };
  const post = (id: string, action: CandidateAction) => api.post<ActionResult>(`/api/v1/applications/${id}/actions`, { action } satisfies ApplicationAction);
  const postMany = async (action: BulkCandidateAction, ids: readonly string[]): Promise<BulkActionResult> => {
    const parts: BulkActionResult[] = [];
    for (const applicationIds of batches(ids)) parts.push(await api.post<BulkActionResult>(`/api/v1/roles/${roleId}/applications/actions`, { action, applicationIds } satisfies BulkApplicationAction));
    return mergeBulk(parts) as BulkActionResult;
  };
  /** The toast after something was done; with a decision email still waiting, "Don't send" takes it back. */
  const say = (message: string, undoUntil: string | null, takeBack: () => Promise<{ message: string }>) => {
    const ms = undoMillis(undoUntil);
    if (!ms) return toast(message, { tone: "good" });
    const onAction = () => {
      takeBack().then((r) => toast(r.message, { endsAction: true }), (err) => toast(errorWords(err), { tone: "critical", endsAction: true })).finally(refresh);
    };
    toast(message, { tone: "good", action: { label: CANDIDATE_ACTION_LABEL.unsend_decision, onAction }, durationMs: ms });
  };
  const one = useMutation({
    mutationFn: (input: { id: string; action: CandidateAction }) => post(input.id, input.action),
    onMutate: () => setProblem(null),
    onSuccess: (r) => {
      say(r.message, r.action === "send_decision" ? r.undoUntil : null, () => post(r.applicationId, "unsend_decision"));
      refresh();
    },
    onError: failed,
  });
  const many = useMutation({
    mutationFn: (button: Pick<BulkButton, "action" | "ids">) => postMany(button.action, button.ids),
    onMutate: () => {
      setProblem(null);
      setRefused([]);
    },
    onSuccess: (r) => {
      const sent = r.results.filter((x) => x.ok).map((x) => x.applicationId);
      say(r.message, r.action === "send_decision" && sent.length ? r.undoUntil : null, () => postMany("unsend_decision", sent));
      setRefused(refusedLines(r));
      refresh();
    },
    onError: failed,
  });
  return { one, many, problem, refused, clear: () => { setProblem(null); setRefused([]); } };
}
