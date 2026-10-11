"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Chip } from "@ros/ui";
import { api, ApiError, type BoardChoiceView, type WhoPosts } from "../api/client";
import { boardTicksToast } from "../publishing";
import { toast } from "../toast";

/**
 * Where the job is posted (founder decision Q11, plan D6): the careers page and Google always, then a tick per job
 * board, starting from the boards the role plan names. ZipRecruiter is offered only to a company with its own paid
 * plan, and says so. The ticks can change before and after approval: on a live job a newly ticked board is prepared
 * (and ITS gets a task to post it when ITS posts for the company), and an unticked board's listing is closed and, if it
 * was up, taken down. Changing them needs role.manage; everyone else sees the same list read-only.
 */
export function BoardTicks(props: { roleId: string; boards: BoardChoiceView[]; roleStatus: string; whoPosts: WhoPosts; canManage: boolean; onDone?: () => void }) {
  const qc = useQueryClient();
  const chosen = props.boards.filter((b) => b.chosen).map((b) => b.channel as string);
  const [picked, setPicked] = useState<string[]>(chosen);
  const changed = picked.length !== chosen.length || picked.some((c) => !chosen.includes(c));
  const editable = props.canManage && props.roleStatus !== "closed";
  const save = useMutation({
    mutationFn: () => api.post(`/api/v1/roles/${props.roleId}/channels`, { channels: picked }),
    onSuccess: async () => {
      const t = boardTicksToast({ before: chosen, after: picked, roleStatus: props.roleStatus, whoPosts: props.whoPosts });
      toast(t.title, t.detail);
      for (const k of [["role", props.roleId], ["postings", props.roleId], ["brief"]]) await qc.invalidateQueries({ queryKey: k });
      props.onDone?.();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save the boards."),
  });
  const toggle = (channel: string, on: boolean) => setPicked((p) => (on ? [...new Set([...p, channel])] : p.filter((c) => c !== channel)));
  return (
    <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend className="sr-only">Where the job is posted</legend>
      <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked disabled /> Your careers page <Chip>always</Chip></label>
      <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked disabled /> Google <Chip>always</Chip></label>
      {props.boards.map((b) => (
        <div key={b.channel}>
          <label className="row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={picked.includes(b.channel)} disabled={!editable || !b.available || save.isPending} onChange={(e) => toggle(b.channel, e.target.checked)} />
            {b.name}
            {b.inRolePlan ? <Chip tone="accent">in your role plan</Chip> : null}
          </label>
          {b.reason ? <p className="small muted" style={{ margin: "2px 0 0 24px" }}>{b.reason}</p> : null}
        </div>
      ))}
      {editable && changed ? (
        <div className="stack" style={{ gap: 6, marginTop: 4 }}>
          {props.roleStatus === "open" || props.roleStatus === "paused" ? <Alert tone="info">{props.whoPosts === "its" ? "A board you tick is prepared now and ITS posts it from your company's account. A board you untick is closed; if the job is up there, ITS takes it down." : "A board you tick is prepared now for you to post. A board you untick is closed; if the job is up there, take it down from your own account."}</Alert> : null}
          <div className="row">
            <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save the boards</Button>
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => setPicked(chosen)}>Undo</Button>
          </div>
        </div>
      ) : null}
      {!props.canManage ? <p className="small muted" style={{ margin: 0 }}>An owner or an admin chooses the boards.</p> : null}
    </fieldset>
  );
}
