"use client";

import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MarkKind } from "@ros/contracts";
import { api, ApiError, type ActionResult, type Me } from "../../api/client";
import { toast } from "../../toast";
import { activeCompanyOf } from "../../rail";
import { actionToast } from "../../talent-actions";

/** What POST /applications/:id/actions takes. */
export type ActionBody = { action: string; reason?: string; note?: string; channel?: string; mark?: MarkKind; remindAt?: string; focus?: "unknowns" };

/**
 * Everything that shows a candidate is read again after a change: the panel, the list and its counts, Today, the
 * notifications, and the roles (the rail's and the Roles page's counts).
 */
export function useRefreshCandidate(id: string, roleId: string): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["application", id] }),
      qc.invalidateQueries({ queryKey: ["applications", roleId] }),
      qc.invalidateQueries({ queryKey: ["brief"] }),
      qc.invalidateQueries({ queryKey: ["notifications"] }),
      qc.invalidateQueries({ queryKey: ["roles"] }),
      qc.invalidateQueries({ queryKey: ["role", roleId] }),
      qc.invalidateQueries({ queryKey: ["interviews"] }),
    ]);
  }, [qc, id, roleId]);
}

/** One choice about the candidate, with the toast that says exactly what happened (and whether they were told). */
export function useCandidateAction(id: string, roleId: string, onDone?: (body: ActionBody, r: ActionResult) => void) {
  const refresh = useRefreshCandidate(id, roleId);
  return useMutation({
    mutationFn: (body: ActionBody) => api.post<ActionResult>(`/api/v1/applications/${id}/actions`, body),
    onSuccess: async (r, body) => {
      const t = actionToast(body.action, r);
      toast(t.title, t.detail);
      onDone?.(body, r);
      await refresh();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "That did not go through. Try again."),
  });
}

/** The signed-in person's role in this company; an ITS recruiter working under a grant acts with a recruiter's rights. */
export function useViewer(): { role: string | null; userId: string | null } {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const company = activeCompanyOf(me.data);
  return { role: company.role ?? (me.data?.staffAccess ? "recruiter" : null), userId: me.data?.user.id ?? null };
}

/**
 * A step a stage choice opened takes the focus on its first field, so the keyboard lands where the work is and the
 * panel scrolls to it.
 */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}

/**
 * Unsent text (plan A10): every field where a person types something that is not saved yet reports it here, so next,
 * previous, the backdrop and Escape can ask before throwing it away.
 */
export const DraftContext = createContext<(key: string, text: string) => void>(() => undefined);

export function useDraft(key: string, text: string): void {
  const report = useContext(DraftContext);
  useEffect(() => {
    report(key, text);
  }, [report, key, text]);
  useEffect(() => () => report(key, ""), [report, key]);
}
