"use client";

import { AnimatePresence, m, useIsPresent, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cx, normalizeToast, TOAST_EVENT, type ToastMessage, toastArrives, toastDuration } from "./helpers";
import { Icon } from "./icons";

/**
 * One toast: what happened, and when there is more to say a second line about what did or did not follow ("Moved to
 * Shortlist." / "Private: the candidate was not told."). A good outcome shows a tick, a failure an alert mark; the words
 * carry the meaning either way. An action ("Undo") is a button at the end; pressing it does the action and closes the toast.
 * While it fades out (after Undo, or when a newer one takes its place) it is inert: its Undo cannot be pressed twice.
 */
export function Toast(props: ToastMessage & { onDismiss?: () => void }) {
  const { action } = props;
  const present = useIsPresent();
  return (
    <div className={cx("toast", props.tone, action && "has-action")} inert={!present || undefined}>
      {props.tone === "good" ? <Icon name="check" /> : props.tone === "critical" ? <Icon name="alert" /> : null}
      <div>
        <span className="toast-title">{props.title}</span>
        {props.detail ? (
          <>
            {" "}
            <span className="toast-detail">{props.detail}</span>
          </>
        ) : null}
      </div>
      {action ? (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            action.onAction();
            props.onDismiss?.();
          }}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/** The toast's own rise and fade (200ms); instant for someone who asked for less motion. */
const RISE = { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const };

/**
 * Shows the toasts that toast() (apps/web/src/toast.ts) sends as a window event, one at a time; a newer one replaces the
 * one on screen, except that a toast whose action (an Undo) can still be pressed is never taken away by a plain one:
 * that waits (the latest only) and shows once the action has ended or the toast is dismissed (`toastArrives`). The live
 * region stays in the page while empty, so screen readers announce each new message. Mount it once, near the root of
 * the signed-in app, inside the MotionProvider. A toast with an action stays while the action is possible. Each toast
 * rises in and fades out; a newer one waits for the one before to leave.
 */
export function Toaster() {
  const [shown, setShown] = useState<{ id: number; message: ToastMessage } | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionOnScreen = useRef(false);
  const waiting = useRef<ToastMessage | null>(null);
  const show = useRef<(m: ToastMessage) => void>(() => undefined);
  const end = useRef<() => void>(() => undefined);
  const reduce = useReducedMotion();
  show.current = (message: ToastMessage) => {
    if (timer.current) clearTimeout(timer.current);
    actionOnScreen.current = !!message.action;
    seq.current += 1;
    setShown({ id: seq.current, message });
    timer.current = setTimeout(() => end.current(), toastDuration(message));
  };
  end.current = () => {
    if (timer.current) clearTimeout(timer.current);
    actionOnScreen.current = false;
    const next = waiting.current;
    waiting.current = null;
    if (next) show.current(next);
    else setShown(null);
  };
  useEffect(() => {
    const onToast = (e: Event) => {
      const next = normalizeToast((e as CustomEvent<unknown>).detail);
      if (!next) return;
      if (toastArrives(actionOnScreen.current, next) === "wait") waiting.current = next;
      else show.current(next);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const dismiss = () => end.current();
  return (
    <div className="toast-region" role="status">
      <AnimatePresence mode="wait">
        {shown ? (
          <m.div key={shown.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={reduce ? { duration: 0 } : RISE}>
            <Toast {...shown.message} onDismiss={dismiss} />
          </m.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
