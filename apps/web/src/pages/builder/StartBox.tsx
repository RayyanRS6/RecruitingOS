"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { appPaths, type IntakeSessionResponse, type IntakeStartResponse, type PlanRoom, type StartIntake } from "@ros/contracts";
import { Alert } from "@ros/ui";
import { api, errorWords, planLimitOf } from "../../api/client";
import { composerPlaceholder, firstReplyKey, replyWords, sessionKey, turnProblem, type Problem } from "../../builder";
import { RoomAlert } from "../../components/RoomAlert";
import { Upgrade } from "../../components/Upgrade";
import { useNavigate } from "../../nav";
import { Composer } from "./Composer";
import { AssistantMark, Thinking } from "./Conversation";

/**
 * Starting a draft: POST /intake/sessions with the person's words, then the job builder opens on the new draft. The
 * words travel in the request, never in the address. Words that are not about hiring leave no draft and are answered in
 * place; a plan with no room says so, with the way to ask for more.
 */
function useStartDraft() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [room, setRoom] = useState<PlanRoom | null>(null);
  const m = useMutation({
    mutationFn: (initialMessage: string) => api.post<IntakeStartResponse>("/api/v1/intake/sessions", { initialMessage } satisfies StartIntake),
    onMutate: () => {
      setSaid(null);
      setProblem(null);
      setRoom(null);
    },
    onSuccess: (r) => {
      if (!r.session) {
        const failed = turnProblem(r.reply);
        if (failed) setProblem(failed);
        else setSaid(replyWords(r.reply) ?? "That does not sound like a job to hire for, so no draft was started.");
        return;
      }
      // the builder opens on this answer: the draft, with the company's time zone beside it
      qc.setQueryData<IntakeSessionResponse>(sessionKey(r.session.id), { session: r.session, timeZone: r.timeZone });
      qc.setQueryData(firstReplyKey(r.session.id), r.reply);
      for (const key of [["intake", "sessions"], ["home"]]) qc.invalidateQueries({ queryKey: key });
      nav(appPaths.draft(r.session.id));
    },
    onError: (err) => {
      const limit = planLimitOf(err);
      // the room a refusal carries offers the refusal's own request (none for someone who may not ask)
      if (limit?.room && !limit.room.ok) setRoom({ ...limit.room, ask: limit.ask });
      setProblem({ message: errorWords(err), ask: limit?.ask ?? null });
    },
  });
  return { start: (message: string) => m.mutate(message), pending: m.isPending, said, problem, room, clear: () => setProblem(null) };
}

/**
 * The start-a-hire box, on Home and on the job builder's first page: one box for a sentence or a whole pasted job ad.
 * `room`: the plan's room for another job as the page read it; with none the box waits and the plan's own line says
 * why. `size="lg"` is the big box on the builder's own page.
 */
export function StartBox({ room, size }: { room: PlanRoom | null | undefined; size?: "lg" | "md" }) {
  const [text, setText] = useState("");
  const s = useStartDraft();
  const full = s.room ?? (room && !room.ok ? room : null);
  return (
    <div className="grid min-w-0 gap-3">
      {full ? <RoomAlert room={full} /> : null}
      {s.said ? (
        <div className="flex min-w-0 items-start gap-2.5 motion-safe:animate-enter motion-safe:[animation-fill-mode:backwards]">
          <AssistantMark />
          <div className="bubble assistant min-w-0 rounded-2xl rounded-tl-md text-ink">{s.said}</div>
        </div>
      ) : null}
      <Composer
        first
        size={size}
        value={text}
        onChange={(v) => {
          setText(v);
          s.clear();
        }}
        onSend={s.start}
        sending={s.pending}
        disabled={!!full}
        label="Describe the job, or paste a job ad"
        sendLabel="Start"
        placeholder={composerPlaceholder(false)}
      />
      {s.pending ? <Thinking label="Reading what you wrote…" /> : null}
      {s.problem && !full ? (
        <Alert tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{s.problem.message}</span>
            {s.problem.ask ? <Upgrade label={s.problem.ask.label} size="sm" reason={s.problem.ask.reason} /> : null}
          </div>
        </Alert>
      ) : null}
    </div>
  );
}
