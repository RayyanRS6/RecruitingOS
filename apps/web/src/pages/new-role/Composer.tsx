"use client";

import { type MutableRefObject, type ReactNode, useEffect, useId, useState } from "react";
import { AutoTextarea, Button, cn } from "@ros/ui";
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
 * The message box (plan C5): it grows with what is typed and takes a whole pasted job ad. At a desk Enter sends and
 * Shift+Enter starts a new line; on a touch screen Enter is a new line and the Send button sends. A message that is too
 * long is said so before sending, with the limit. `size="lg"` is the big box on the empty page.
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
  hint?: ReactNode;
  sendLabel?: string;
  /** A shorter limit than a turn of conversation (a request to change the draft). */
  changeMax?: number;
}) {
  const touch = useTouch();
  const hintId = useId();
  const problem = messageProblem(props.value, !!props.first, props.changeMax);
  const canSend = !props.disabled && !props.sending && !!props.value.trim() && !problem;
  const send = () => {
    if (canSend) props.onSend(props.value.trim());
  };
  return (
    <div className="grid min-w-0 gap-1.5">
      {/* The send button is plum once there is something to send, and a quiet grey pill until then (or while greyed). */}
      <div className={cn(props.size === "lg" ? "composer lg rounded-[22px]" : "composer", "items-end [&_.btn]:shrink-0 [&_.btn:disabled:not([aria-busy=true])]:bg-surface-2 [&_.btn:disabled:not([aria-busy=true])]:text-ink-3 [&_.btn:disabled:not([aria-busy=true])]:opacity-100 [&_.btn:disabled:not([aria-busy=true])]:shadow-none")} data-disabled={props.disabled ? "true" : undefined}>
        <AutoTextarea
          inputRef={props.inputRef}
          value={props.value}
          onChange={props.onChange}
          placeholder={props.placeholder}
          ariaLabel={props.label}
          ariaDescribedBy={hintId}
          disabled={props.disabled}
          maxHeight={props.size === "lg" ? 360 : 240}
          onKeyDown={(e) => {
            if (!enterSends({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }, touch)) return;
            e.preventDefault();
            send();
          }}
        />
        <Button variant="primary" icon="send" disabled={!canSend} loading={props.sending} onClick={send}>{props.sendLabel ?? "Send"}</Button>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-1.5 text-[12.5px] leading-snug text-ink-3" id={hintId}>
        {problem ? <span className="font-medium text-critical" role="alert">{problem}</span> : <span className="min-w-0">{props.hint}</span>}
        <span className="ml-auto shrink-0 font-mono text-[11px] tracking-[0.04em] max-sm:ml-0 max-sm:shrink">{touch ? "Tap Send when you are ready." : "Enter sends · Shift+Enter for a new line"}</span>
      </div>
    </div>
  );
}
