"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { PlanRoom } from "@ros/contracts";
import { api, ApiError, type IntakeStartResponse } from "../../api/client";
import { useNavigate } from "../../nav";
import { errorWords, startHireHref, type RecruiterAction } from "./rules";

/**
 * Starting a draft (plan C3, C4, C13, C14), shared by the job builder's first screen, Today's "Who are you hiring?" box
 * and "Hire for this role again": POST /intake/sessions with the person's words (or the role to start from), then the
 * builder opens on the new draft. The words travel in the request, never in the address. A message that is not about a
 * role leaves no draft and is answered in place; a full plan says so, with the roles holding the places.
 */
export function useStartDraft(opts: { replace?: boolean } = {}) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [sent, setSent] = useState<string | null>(null);
  const [notARole, setNotARole] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [limit, setLimit] = useState<{ room: PlanRoom | null; ask: RecruiterAction | null } | null>(null);
  const m = useMutation({
    mutationFn: (input: { initialMessage?: string; fromRoleId?: string }) => api.post<IntakeStartResponse>("/api/v1/intake/sessions", input),
    onMutate: (input) => {
      setSent(input.initialMessage ?? null);
      setNotARole(null);
      setProblem(null);
      setLimit(null);
    },
    onSuccess: (r) => {
      if (!r.session) {
        // Not about a role: no draft is kept (founder decision Q5); the assistant's answer is shown where it was asked.
        setNotARole(r.reply?.assistantMessage ?? "That does not sound like a new role, so no draft was started.");
        setSent(null);
        return;
      }
      qc.setQueryData(["intake", "session", r.session.id], { session: r.session });
      if (r.reply) qc.setQueryData(["intake", "first-reply", r.session.id], r.reply);
      qc.invalidateQueries({ queryKey: ["intake", "mine"] });
      qc.invalidateQueries({ queryKey: ["brief"] });
      nav(startHireHref(r.session.id), { replace: opts.replace });
    },
    onError: (err) => {
      setSent(null);
      if (err instanceof ApiError && err.code === "limit_reached") {
        const d = err.details as { room?: PlanRoom; actions?: Array<{ label: string; body?: Record<string, unknown> }> } | undefined;
        const a = d?.actions?.[0];
        setLimit({ room: d?.room ?? null, ask: a ? { label: a.label, body: a.body ?? {} } : null });
        return;
      }
      setProblem(errorWords(err));
    },
  });
  return {
    start: (message: string) => m.mutate({ initialMessage: message }),
    hireAgain: (roleId: string) => m.mutate({ fromRoleId: roleId }),
    pending: m.isPending,
    /** The role "Hire for this role again" is starting from, while it runs: only that role's button shows it working. */
    pendingRoleId: m.isPending ? m.variables?.fromRoleId ?? null : null,
    sent,
    notARole,
    problem,
    limit,
    clearProblem: () => setProblem(null),
  };
}
