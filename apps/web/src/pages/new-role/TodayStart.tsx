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
 * Home's "Who are you hiring?" box (plan C4, founder decision Q5: labelled, and it hands off), kept compact: the title,
 * the box and its button; the example inside the box shows what to type (founder, 23 October 2026: fewer words). What is
 * typed here starts a draft and opens the job builder on it, where an AI assistant asks a few questions and the job is
 * approved before anything is posted (the job builder says so); Home itself keeps no conversation. Shown only to people
 * who may start a hire. It looks like screenshot 3's guided conversation: a chat mark beside the title, a soft wash, the
 * message box. The title and the link are the Card's own title and aside, so the kit sizes the title (19px, as on every
 * card that is not a page's one next step); the mark is hidden from screen readers, so the heading's name stays
 * "Who are you hiring?".
 */
export function TodayStart() {
  const [text, setText] = useState("");
  const { start, pending, notARole, problem, limit, clearProblem } = useStartDraft();
  return (
    <Card
      title={<>
        <span aria-hidden="true" className="mr-3.5 inline-grid size-10 place-items-center rounded-full border border-line-2 bg-surface align-middle text-ink-2 shadow-xs">
          <Icon name="message-circle" size={18} />
        </span>
        Who are you hiring?
      </>}
      aside={<Link to={START_HIRE_HREF} className="text-link pointer-coarse:min-h-10">Open the job builder</Link>}
      className="border-line-tint bg-linear-150 from-tint/70 via-surface via-55% to-peach/60"
    >
      <div className="grid gap-3">
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
