"use client";

import { type MutableRefObject, type ReactNode, useEffect, useId, useState } from "react";
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
    <div className="composer-wrap">
      <div className={props.size === "lg" ? "composer lg" : "composer"} data-disabled={props.disabled ? "true" : undefined}>
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
      <div className="composer-foot" id={hintId}>
        {problem ? <span className="composer-problem" role="alert">{problem}</span> : <span>{props.hint}</span>}
        <span className="composer-keys">{touch ? "Tap Send when you are ready." : "Enter sends · Shift+Enter for a new line"}</span>
      </div>
    </div>
  );
}
