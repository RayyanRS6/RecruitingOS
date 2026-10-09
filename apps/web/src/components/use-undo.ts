"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type UndoResult } from "../api/client";
import { toast } from "../toast";
import { bulkUndoneToast, undoFailedToast, undoMillisLeft, undoneToast } from "../telling";

/** Everything that shows a candidate's messages and told state is read again after an Undo. */
function useRefreshAfterUndo() {
  const qc = useQueryClient();
  return useCallback(async (roleId: string, applicationIds: string[]) => {
    await Promise.all([
      ...applicationIds.map((id) => qc.invalidateQueries({ queryKey: ["application", id] })),
      qc.invalidateQueries({ queryKey: ["applications", roleId] }),
      qc.invalidateQueries({ queryKey: ["brief"] }),
    ]);
  }, [qc]);
}

/**
 * Undo after Send (plan G9): the toast that says a message was sent carries "Undo" for as long as the message still
 * waits in the outbox (`undoUntil`); pressing it takes the message back (POST …/messages/:communicationId/undo) and says
 * what became of it. Without a window (the company sends at once), the toast is the plain one.
 */
export function useUndoToast() {
  const refresh = useRefreshAfterUndo();
  return useCallback((input: { applicationId: string; roleId: string; communicationId: string | null | undefined; undoUntil: string | null | undefined; firstName: string; kind: "decision" | "message"; title: string; detail: string; plain?: { title: string; detail?: string } }) => {
    const ms = undoMillisLeft(input.undoUntil);
    if (!ms || !input.communicationId) {
      const t = input.plain ?? { title: input.title, detail: input.detail };
      toast(t.title, t.detail);
      return;
    }
    const communicationId = input.communicationId;
    const takeBack = async () => {
      try {
        const r = await api.post<UndoResult>(`/api/v1/applications/${input.applicationId}/messages/${communicationId}/undo`, {});
        const t = undoneToast({ firstName: input.firstName, kind: input.kind, toldState: r.toldState });
        toast(t.title, t.detail);
      } catch (e) {
        const t = undoFailedToast(e instanceof ApiError ? e.code : null, e instanceof ApiError ? e.message : undefined);
        toast(t.title, { detail: t.detail, tone: "critical" });
      }
      await refresh(input.roleId, [input.applicationId]);
    };
    toast(input.title, { detail: input.detail, action: { label: "Undo", onAction: () => void takeBack() }, durationMs: ms });
  }, [refresh]);
}

/**
 * "Undo all" after sending the decision message to several people at once: every message still waiting is taken back,
 * one by one, and the toast counts what was taken back and what had already gone.
 */
export function useBulkUndoToast() {
  const refresh = useRefreshAfterUndo();
  return useCallback((input: { roleId: string; items: Array<{ applicationId: string; communicationId: string }>; ms: number; title: string; detail?: string }) => {
    if (!input.items.length || input.ms <= 0) {
      toast(input.title, input.detail);
      return;
    }
    const takeBack = async () => {
      let taken = 0;
      let late = 0;
      for (const it of input.items) {
        try {
          await api.post<UndoResult>(`/api/v1/applications/${it.applicationId}/messages/${it.communicationId}/undo`, {});
          taken += 1;
        } catch {
          late += 1;
        }
      }
      const t = bulkUndoneToast(taken, late);
      toast(t.title, t.detail);
      await refresh(input.roleId, input.items.map((x) => x.applicationId));
    };
    toast(input.title, { detail: input.detail, action: { label: "Undo all", onAction: () => void takeBack() }, durationMs: input.ms });
  }, [refresh]);
}
