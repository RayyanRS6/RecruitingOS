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

/** One message to take back: whose, which, and how the toast after it names them. */
export type TakeBackInput = { applicationId: string; roleId: string; communicationId: string; firstName: string; kind: "decision" | "message" };

/**
 * Takes one message back (POST …/messages/:communicationId/undo) and says what became of it. The same whether Undo was
 * pressed on the toast or on the page where the message was sent (`InlineUndo`): the toast that answers it replaces the
 * Undo toast still on screen (`endsAction`).
 */
export function useTakeBack() {
  const refresh = useRefreshAfterUndo();
  return useCallback(async (input: TakeBackInput) => {
    try {
      const r = await api.post<UndoResult>(`/api/v1/applications/${input.applicationId}/messages/${input.communicationId}/undo`, {});
      const t = undoneToast({ firstName: input.firstName, kind: input.kind, toldState: r.toldState });
      toast(t.title, { detail: t.detail, endsAction: true });
    } catch (e) {
      const t = undoFailedToast(e instanceof ApiError ? e.code : null, e instanceof ApiError ? e.message : undefined);
      toast(t.title, { detail: t.detail, tone: "critical", endsAction: true });
    }
    await refresh(input.roleId, [input.applicationId]);
  }, [refresh]);
}

/**
 * "Undo all" for several messages at once: every message still waiting is taken back, one by one, and the toast counts
 * what was taken back and what had already gone.
 */
export function useBulkTakeBack() {
  const refresh = useRefreshAfterUndo();
  return useCallback(async (roleId: string, items: ReadonlyArray<{ applicationId: string; communicationId: string }>) => {
    let taken = 0;
    let late = 0;
    for (const it of items) {
      try {
        await api.post<UndoResult>(`/api/v1/applications/${it.applicationId}/messages/${it.communicationId}/undo`, {});
        taken += 1;
      } catch {
        late += 1;
      }
    }
    const t = bulkUndoneToast(taken, late);
    toast(t.title, { detail: t.detail, endsAction: true });
    await refresh(roleId, items.map((x) => x.applicationId));
  }, [refresh]);
}

/**
 * Undo after Send (plan G9): the toast that says a message was sent carries "Undo" for as long as the message still
 * waits in the outbox (`undoUntil`); pressing it takes the message back (`useTakeBack`). Without a window (the company
 * sends at once), the toast is the plain one. The page that sent it shows the same Undo where the Send was
 * (`InlineUndo`), so it can be reached from the keyboard inside a panel.
 */
export function useUndoToast() {
  const takeBack = useTakeBack();
  return useCallback((input: { applicationId: string; roleId: string; communicationId: string | null | undefined; undoUntil: string | null | undefined; firstName: string; kind: "decision" | "message"; title: string; detail: string; plain?: { title: string; detail?: string } }) => {
    const ms = undoMillisLeft(input.undoUntil);
    if (!ms || !input.communicationId) {
      const t = input.plain ?? { title: input.title, detail: input.detail };
      toast(t.title, t.detail);
      return;
    }
    const communicationId = input.communicationId;
    toast(input.title, { detail: input.detail, action: { label: "Undo", onAction: () => void takeBack({ applicationId: input.applicationId, roleId: input.roleId, communicationId, firstName: input.firstName, kind: input.kind }) }, durationMs: ms });
  }, [takeBack]);
}

/**
 * "Undo all" after sending the decision message to several people at once, on the toast (`useBulkTakeBack`); the page
 * shows the same "Undo all" where the Send was (`InlineUndo`).
 */
export function useBulkUndoToast() {
  const takeBack = useBulkTakeBack();
  return useCallback((input: { roleId: string; items: Array<{ applicationId: string; communicationId: string }>; ms: number; title: string; detail?: string }) => {
    if (!input.items.length || input.ms <= 0) {
      toast(input.title, input.detail);
      return;
    }
    toast(input.title, { detail: input.detail, action: { label: "Undo all", onAction: () => void takeBack(input.roleId, input.items) }, durationMs: input.ms });
  }, [takeBack]);
}
