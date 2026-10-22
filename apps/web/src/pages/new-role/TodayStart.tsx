"use client";

import { useState } from "react";
import { Alert, Card, Icon } from "@ros/ui";
import { Link } from "../../nav";
import { START_HIRE_HREF } from "../../start-hire";
import { Composer } from "./Composer";
import { AssistantMark, Thinking } from "./Conversation";
import { RoomAlert } from "./StartView";
import { useStartDraft } from "./use-start-draft";

/**
 * Home's "Who are you hiring?" box (plan C4, founder decision Q5: labelled, and it hands off), kept compact: one line,
 * the box and its button. What is typed here starts a draft and opens the job builder on it, where an AI assistant asks
 * a few questions (the job builder says so); Home itself keeps no conversation. Shown only to people who may start a hire.
 * It looks like screenshot 3's guided conversation: a chat mark, an eyebrow over the title, a soft wash, the message box.
 */
export function TodayStart() {
  const [text, setText] = useState("");
  const { start, pending, notARole, problem, limit, clearProblem } = useStartDraft();
  return (
    <Card className="border-line-tint bg-linear-150 from-tint/70 via-surface via-55% to-peach/60 max-sm:p-5">
      <div className="flex flex-wrap items-start gap-x-3.5 gap-y-2">
        <span aria-hidden="true" className="grid size-10 flex-none place-items-center rounded-full border border-line-2 bg-surface text-ink-2 shadow-xs">
          <Icon name="message-circle" size={18} />
        </span>
        <div className="grid min-w-0 flex-[1_1_180px] gap-1">
          <p className="eyebrow">New job</p>
          <h2 className="text-[22px] font-semibold leading-tight tracking-[-0.02em] text-ink">Who are you hiring?</h2>
        </div>
        <Link to={START_HIRE_HREF} className="text-link self-center pointer-coarse:min-h-10">Open the job builder</Link>
      </div>
      <p className="mt-3 text-sm text-ink-2 sm:pl-[54px]">Describe the job, or paste a job ad. Nothing is posted until someone approves it.</p>
      <div className="mt-4 grid gap-3">
        {limit?.room && !limit.room.ok ? <RoomAlert room={limit.room} ask={limit.ask} /> : null}
        {notARole ? (
          // the job builder's own chat look (Conversation.tsx): the assistant's mark, then its white bubble
          <div className="flex min-w-0 items-start gap-2.5 motion-safe:animate-enter motion-safe:[animation-fill-mode:backwards]">
            <AssistantMark />
            <div className="bubble assistant min-w-0 rounded-2xl rounded-tl-md text-ink">{notARole}</div>
          </div>
        ) : null}
        <Composer
          first
          value={text}
          onChange={(v) => { setText(v); clearProblem(); }}
          onSend={start}
          sending={pending}
          label="Who are you hiring?"
          sendLabel="Start drafting"
          placeholder="For example: a dental assistant for our Irvine office, full time, $24 to $28 an hour"
        />
        {pending ? <Thinking label="Reading what you wrote…" /> : null}
        {problem ? <Alert tone="critical">{problem}</Alert> : null}
      </div>
    </Card>
  );
}
