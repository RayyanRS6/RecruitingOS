"use client";

import { type KeyboardEvent, type MutableRefObject, useEffect, useLayoutEffect, useRef } from "react";
import { cx } from "./helpers";

/** Measured after every change in the browser; on the server there is nothing to measure. */
const useMeasure = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * A text box that grows with what is typed (docs/07: the job builder's composer), up to `maxHeight` pixels, then
 * scrolls. A pasted job ad grows it at once. What Enter does is the page's choice, in `onKeyDown`: the composer sends on
 * Enter at a desk and keeps Enter as a new line on a touch screen. `inputRef` hands the element to the page (to focus it).
 */
export function AutoTextarea(props: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  id?: string;
  rows?: number;
  maxHeight?: number;
  disabled?: boolean;
  maxLength?: number;
  className?: string;
  inputRef?: MutableRefObject<HTMLTextAreaElement | null>;
}) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const max = props.maxHeight ?? 320;
  useMeasure(() => {
    const el = own.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [props.value, max]);
  return (
    <textarea
      ref={(el) => {
        own.current = el;
        if (props.inputRef) props.inputRef.current = el;
      }}
      id={props.id}
      className={cx("autogrow", props.className)}
      rows={props.rows ?? 1}
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props.ariaLabel}
      aria-describedby={props.ariaDescribedBy}
      disabled={props.disabled}
      maxLength={props.maxLength}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={props.onKeyDown}
    />
  );
}
