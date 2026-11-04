"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Chip } from "@ros/ui";
import { api, ApiError, type BoardChoiceView, type WhoPosts } from "../api/client";
import { boardTicksToast, unsavedBoards } from "../publishing";
import { toast } from "../toast";

/** One board: the tick, its name and a pale chip, in a row at least 48px tall (a whole row is the tick's label). */
const ROW = "flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-[14px] text-ink has-enabled:cursor-pointer has-disabled:text-ink-2";

/**
 * Where the job is posted (founder decision Q11, plan D6): the careers page and Google always, then a tick per job
 * board, starting from the boards the role plan names. ZipRecruiter is offered only to a company with its own paid
 * plan, and says so. The ticks can change before and after approval: on a live job a newly ticked board is prepared
 * (and ITS gets a task to post it when ITS posts for the company), and an unticked board's listing is closed and, if it
 * was up, taken down. Changing them needs role.manage; everyone else sees the same list read-only. `onUnsaved` tells the
 * approval card what is ticked and not saved yet, so approving goes by what is on the screen, and that lasts only as long
 * as this list. `busy` holds the list while that approval is being sent.
 */
export function BoardTicks(props: { roleId: string; boards: BoardChoiceView[]; roleStatus: string; whoPosts: WhoPosts; canManage: boolean; busy?: boolean; onDone?: () => void; onUnsaved?: (channels: string[] | null) => void }) {
  const qc = useQueryClient();
  const chosen = props.boards.filter((b) => b.chosen).map((b) => b.channel as string);
  const [picked, setPicked] = useState<string[]>(chosen);
  const changed = unsavedBoards(chosen, picked) !== null;
  const editable = props.canManage && props.roleStatus !== "closed";
  const save = useMutation({
    mutationFn: () => api.post(`/api/v1/roles/${props.roleId}/channels`, { channels: picked }),
    onSuccess: async () => {
      const t = boardTicksToast({ before: chosen, after: picked, roleStatus: props.roleStatus, whoPosts: props.whoPosts });
      toast(t.title, t.detail);
      // Read again first, the role last: the card's line goes from these ticks straight to the same boards saved, never back to the old ones.
      for (const k of [["postings", props.roleId], ["brief"], ["role", props.roleId]]) await qc.invalidateQueries({ queryKey: k });
      props.onUnsaved?.(null);
      props.onDone?.();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save the boards."),
  });
  const busy = save.isPending || !!props.busy;
  // Ticks nobody saved go with the list that shows them: nothing may be approved by boards no tick shows.
  const { onUnsaved } = props;
  useEffect(() => () => onUnsaved?.(null), [onUnsaved]);
  const pick = (next: string[]) => {
    setPicked(next);
    props.onUnsaved?.(unsavedBoards(chosen, next));
  };
  const toggle = (channel: string, on: boolean) => pick(on ? [...new Set([...picked, channel])] : picked.filter((c) => c !== channel));
  return (
    <fieldset className="grid min-w-0 gap-3">
      <legend className="sr-only">Where the job is posted</legend>
      {/* one bordered list of rows (screenshot 6): the tick, the board, a pale chip; a board that cannot be ticked says why under it */}
      <div className="list-card divide-y divide-line overflow-hidden">
        <label className={ROW}><input type="checkbox" checked disabled /> Your careers page <Chip>always</Chip></label>
        <label className={ROW}><input type="checkbox" checked disabled /> Google <Chip>always</Chip></label>
        {props.boards.map((b) => (
          <div key={b.channel} className="grid gap-0.5">
            <label className={ROW}>
              <input type="checkbox" checked={picked.includes(b.channel)} disabled={!editable || !b.available || busy} onChange={(e) => toggle(b.channel, e.target.checked)} />
              {b.name}
              {b.inRolePlan ? <Chip tone="accent">in your role plan</Chip> : null}
            </label>
            {b.reason ? <p className="small muted -mt-2 pe-4 pb-3 ps-[46px]">{b.reason}</p> : null}
          </div>
        ))}
      </div>
      {editable && changed ? (
        <div className="grid gap-2.5">
          {props.roleStatus === "open" || props.roleStatus === "paused" ? <Alert tone="info">{props.whoPosts === "its" ? "A board you tick is prepared now and ITS posts it from your company's account. A board you untick is closed; if the job is up there, ITS takes it down." : "A board you tick is prepared now for you to post. A board you untick is closed; if the job is up there, take it down from your own account."}</Alert> : null}
          <div className="row">
            <Button size="sm" variant="primary" loading={save.isPending} disabled={busy} onClick={() => save.mutate()}>Save the boards</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => pick(chosen)}>Undo</Button>
          </div>
        </div>
      ) : null}
      {!props.canManage ? <p className="small muted">An owner or an admin chooses the boards.</p> : null}
    </fieldset>
  );
}
