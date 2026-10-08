"use client";

import { type ReactNode, useEffect, useRef } from "react";
import type { IntakeMessage } from "@ros/contracts";
import { Icon } from "@ros/ui";

/** A line the page adds while it waits, or keeps for this visit (a change asked for and what became of it). */
export type LocalLine = { key: string; role: "owner" | "assistant" | "system"; content: string; kind?: IntakeMessage["kind"] };

/** The assistant's mark beside its messages: it is an AI assistant, and says so. */
export function AssistantMark() {
  return (
    <span className="avatar ink chat-avatar" role="img" aria-label="Assistant">
      <Icon name="sparkle" size={16} />
    </span>
  );
}

/** The assistant is working: three dots and what it is doing, in words. */
export function Thinking({ label }: { label: string }) {
  return (
    <div className="chat-msg assistant">
      <AssistantMark />
      <div className="bubble assistant typing">
        <span className="dots" aria-hidden="true"><i /><i /><i /></span>
        <span>{label}</span>
      </div>
    </div>
  );
}

const kb = (n: number) => n.toLocaleString("en-US");

/** One message: the person's on the right in dark, the assistant's on the left in light with its mark. */
export function ChatMessage({ m }: { m: Pick<IntakeMessage, "role" | "content" | "kind"> }) {
  if (m.role === "system") return <p className="chat-system">{m.content}</p>;
  if (m.role === "assistant") {
    return (
      <div className="chat-msg assistant">
        <AssistantMark />
        <div className="bubble assistant">{m.content}</div>
      </div>
    );
  }
  if (m.kind === "pasted_ad") {
    return (
      <div className="chat-msg owner">
        <div className="bubble user">
          <details className="pasted-ad">
            <summary><Icon name="paperclip" size={14} /> You pasted a job ad ({kb(m.content.length)} characters)</summary>
            <div className="pasted-ad-text">{m.content}</div>
          </details>
        </div>
      </div>
    );
  }
  return (
    <div className="chat-msg owner">
      <div className={m.kind === "answers" ? "bubble user answers" : "bubble user"}>
        {m.kind === "answers" ? <span className="answers-label">Your answers</span> : null}
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
  const count = props.messages.length + props.local.length + (props.pending ? 1 : 0) + (props.thinking ? 1 : 0);
  useEffect(() => {
    const el = log.current;
    if (el && count) el.scrollTop = el.scrollHeight;
  }, [count]);
  return (
    <div className="chat">
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the message list scrolls on its own and must be reachable by keyboard (axe scrollable-region-focusable) */}
      <section className="chat-log" ref={log} tabIndex={0} aria-label="Conversation with the assistant">
        <p className="chat-disclosure"><Icon name="sparkle" size={14} /> You are talking with an AI assistant. It drafts; you decide. Nothing is posted or sent to anyone until the role is approved.</p>
        {props.messages.filter((m) => m.role !== "system").map((m, i) => <ChatMessage key={`${i}-${m.at}`} m={m} />)}
        {props.local.map((m) => <ChatMessage key={m.key} m={m} />)}
        {props.pending ? <ChatMessage m={props.pending} /> : null}
        {props.thinking ? <Thinking label={props.thinking} /> : null}
      </section>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="intake-announcer">{props.announce}</div>
      <div className="chat-dock">
        {props.above}
        {props.dock}
      </div>
    </div>
  );
}
