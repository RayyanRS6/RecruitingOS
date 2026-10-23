"use client";

import { type AnimationEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { IntakeMessage } from "@ros/contracts";
import { cn, Icon, IconChip } from "@ros/ui";
import { PANE_HEIGHT } from "./look";

/** A line the page adds while it waits, or keeps for this visit (a change asked for and what became of it). */
export type LocalLine = { key: string; role: "owner" | "assistant" | "system"; content: string; kind?: IntakeMessage["kind"] };

/**
 * The assistant's mark beside its messages: it is an AI assistant, and says so. The kit's small peach chip with a
 * sparkle (IconChip xs, which is hidden from screen readers), inside the image that names it "Assistant".
 */
export function AssistantMark() {
  return (
    <span className="mt-0.5 flex flex-none" role="img" aria-label="Assistant">
      <IconChip icon="sparkle" tone="peach" size="xs" />
    </span>
  );
}

/** A message rises into place when it first appears (CSS, on mount only; still for anyone who asked for less motion). */
const ENTER = "motion-safe:animate-enter";
const ASSISTANT_ROW = "flex min-w-0 items-start gap-2.5";
const ASSISTANT_BUBBLE = "bubble assistant min-w-0 rounded-2xl rounded-tl-md text-ink";
const OWNER_BUBBLE = "bubble user max-w-[min(68ch,88%)] rounded-2xl rounded-tr-md";

/** The assistant is working: three dots that fade in turn, and what it is doing, in words. */
export function Thinking({ label }: { label: string }) {
  return (
    <div className={cn(ASSISTANT_ROW, "motion-safe:animate-fade")}>
      <AssistantMark />
      <div className={cn(ASSISTANT_BUBBLE, "typing py-2.5 text-[14px] text-ink-2")}>
        <span className="dots" aria-hidden="true"><i /><i /><i /></span>
        <span>{label}</span>
      </div>
    </div>
  );
}

const kb = (n: number) => n.toLocaleString("en-US");

/**
 * One message: the person's on the right in peach, the assistant's on the left in white with its mark. `still` skips the
 * rise, for a message that was already there when the page opened, or that only replaces the copy already on screen
 * (the person's words, back from the server). The rise plays once: when it ends the class goes, so a pane shown again
 * (the Conversation/Draft switch hides it under 900px, and CSS restarts an animation on a shown element) does not
 * replay it.
 */
export function ChatMessage({ m, still = false }: { m: Pick<IntakeMessage, "role" | "content" | "kind">; still?: boolean }) {
  const [risen, setRisen] = useState(still);
  const enter = risen ? undefined : ENTER;
  const settle = risen ? undefined : (e: AnimationEvent<HTMLElement>) => { if (e.target === e.currentTarget) setRisen(true); };
  if (m.role === "system") return <p className={cn("mx-auto w-fit max-w-full rounded-full bg-surface-2 px-3 py-1 text-center text-[12.5px] text-ink-2", enter)} onAnimationEnd={settle}>{m.content}</p>;
  if (m.role === "assistant") {
    return (
      <div className={cn(ASSISTANT_ROW, enter)} onAnimationEnd={settle}>
        <AssistantMark />
        <div className={ASSISTANT_BUBBLE}>{m.content}</div>
      </div>
    );
  }
  if (m.kind === "pasted_ad") {
    return (
      <div className={cn("flex min-w-0 justify-end", enter)} onAnimationEnd={settle}>
        <div className={OWNER_BUBBLE}>
          <details>
            <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium [&::-webkit-details-marker]:hidden"><Icon name="paperclip" size={14} /> You pasted a job ad ({kb(m.content.length)} characters)</summary>
            <div className="mt-2 max-h-64 overflow-y-auto border-t border-accent/20 pt-2 text-[13.5px] text-ink-2">{m.content}</div>
          </details>
        </div>
      </div>
    );
  }
  return (
    <div className={cn("flex min-w-0 justify-end", enter)} onAnimationEnd={settle}>
      <div className={m.kind === "answers" ? cn(OWNER_BUBBLE, "answers") : OWNER_BUBBLE}>
        {m.kind === "answers" ? <span className="bubble-label">Your answers</span> : null}
        {m.content}
      </div>
    </div>
  );
}

/**
 * The conversation pane (plan C4, C6): an honest line on who the person is talking with, the messages, anything the page
 * is waiting on, and the dock at the bottom (the question card or the message box). New messages scroll into view inside
 * the pane, and the newest reply is read out to screen readers without moving their focus.
 */
export function Conversation(props: { messages: readonly IntakeMessage[]; local: readonly LocalLine[]; pending: LocalLine | null; thinking: string | null; announce: string; above?: ReactNode; dock: ReactNode }) {
  const log = useRef<HTMLElement>(null);
  const said = props.messages.filter((m) => m.role !== "system");
  // What was already said when the page opened stands still; only what is added after it rises in.
  const [already] = useState(() => said.length);
  const count = props.messages.length + props.local.length + (props.pending ? 1 : 0) + (props.thinking ? 1 : 0);
  useEffect(() => {
    const el = log.current;
    if (el && count) el.scrollTop = el.scrollHeight;
  }, [count]);
  return (
    <div className={cn("flex flex-col overflow-hidden rounded-2xl border border-line-tint bg-ground shadow-xs", PANE_HEIGHT)}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the message list scrolls on its own and must be reachable by keyboard (axe scrollable-region-focusable) */}
      <section className="chat-log flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain bg-linear-to-b from-tint via-ground via-35% to-ground px-4 py-5 focus-visible:-outline-offset-2 sm:px-6" ref={log} tabIndex={0} aria-label="Conversation with the assistant">
        <p className="mx-auto flex max-w-[56ch] items-start justify-center gap-1.5 pb-1 text-center text-[12.5px] leading-snug text-ink-3"><Icon name="sparkle" size={14} className="mt-px text-accent" /> You are talking with an AI assistant. It drafts; you decide. Nothing is posted or sent to anyone until the role is approved.</p>
        {said.map((m, i) => <ChatMessage key={`${i}-${m.at}`} m={m} still={m.role === "owner" || i < already} />)}
        {props.local.map((m) => <ChatMessage key={m.key} m={m} />)}
        {props.pending ? <ChatMessage m={props.pending} /> : null}
        {props.thinking ? <Thinking label={props.thinking} /> : null}
      </section>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="intake-announcer">{props.announce}</div>
      <div className="chat-dock grid max-h-[70%] shrink-0 gap-3 overflow-y-auto overscroll-contain border-t border-line bg-surface p-3 sm:p-4">
        {props.above}
        {props.dock}
      </div>
    </div>
  );
}
