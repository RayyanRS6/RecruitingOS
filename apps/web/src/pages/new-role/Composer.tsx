"use client";

import { type MutableRefObject, useEffect, useId, useState } from "react";
import { AutoTextarea, Button } from "@ros/ui";
import { enterSends, messageProblem } from "./rules";

/** True on a phone or a tablet: Enter is a new line there and the button sends. Read after the first render. */
function useTouch(): boolean {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    try {
      setTouch(window.matchMedia("(pointer: coarse)").matches);
    } catch {
      setTouch(false);
    }
  }, []);
  return touch;
}

/**
 * How the keys work (fewer words, 23 October 2026): no line on screen. A screen reader hears it with the box, and at a
 * desk it is the Send button's tooltip.
 */
const KEYS_DESK = "Enter sends · Shift+Enter for a new line";
const KEYS_TOUCH = "Tap Send when you are ready.";

/** The Send button: plum once there is something to send, a quiet grey pill until then (or while greyed), never faded. */
const SEND = "shrink-0 disabled:not-aria-busy:bg-surface-2 disabled:not-aria-busy:text-ink-3 disabled:not-aria-busy:opacity-100 disabled:not-aria-busy:shadow-none";

/**
 * The message box (plan C5): it grows with what is typed and takes a whole pasted job ad. At a desk Enter sends and
 * Shift+Enter starts a new line; on a touch screen Enter is a new line and the Send button sends. A message that is too
 * long is said so under the box before sending, with the limit; nothing else is written under it. `size="lg"` is the big
 * box on the empty page.
 */
export function Composer(props: {
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
  placeholder: string;
  label: string;
  first?: boolean;
  sending?: boolean;
  disabled?: boolean;
  size?: "lg" | "md";
  inputRef?: MutableRefObject<HTMLTextAreaElement | null>;
  sendLabel?: string;
  /** A shorter limit than a turn of conversation (a request to change the draft). */
  changeMax?: number;
}) {
  const touch = useTouch();
  const keysId = useId();
  const problemId = useId();
  const problem = messageProblem(props.value, !!props.first, props.changeMax);
  const canSend = !props.disabled && !props.sending && !!props.value.trim() && !problem;
  const send = () => {
    if (canSend) props.onSend(props.value.trim());
  };
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className={props.size === "lg" ? "composer lg" : "composer"} data-disabled={props.disabled ? "true" : undefined}>
        <AutoTextarea
          inputRef={props.inputRef}
          value={props.value}
          onChange={props.onChange}
          placeholder={props.placeholder}
          ariaLabel={props.label}
          ariaDescribedBy={problem ? `${keysId} ${problemId}` : keysId}
          disabled={props.disabled}
          maxHeight={props.size === "lg" ? 360 : 240}
          onKeyDown={(e) => {
            if (!enterSends({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }, touch)) return;
            e.preventDefault();
            send();
          }}
        />
        <Button variant="primary" icon="send" disabled={!canSend} loading={props.sending} onClick={send} title={touch ? undefined : KEYS_DESK} className={SEND}>{props.sendLabel ?? "Send"}</Button>
      </div>
      <span className="sr-only" id={keysId}>{touch ? KEYS_TOUCH : KEYS_DESK}</span>
      {problem ? <p className="px-1.5 text-[12.5px] font-medium leading-snug text-critical" id={problemId} role="alert">{problem}</p> : null}
    </div>
  );
}
