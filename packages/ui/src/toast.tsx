"use client";

import { useEffect, useRef, useState } from "react";
import { cx, normalizeToast, TOAST_EVENT, type ToastMessage, toastArrives, toastDuration } from "./helpers";
import { Icon } from "./icons";

/**
 * One toast: what happened, and when there is more to say a second line about what did or did not follow ("Moved to
 * Shortlist." / "Private: the candidate was not told."). A good outcome shows a tick, a failure an alert mark; the words
 * carry the meaning either way. An action ("Undo") is a button at the end; pressing it does the action and closes the toast.
 */
export function Toast(props: ToastMessage & { onDismiss?: () => void }) {
  const { action } = props;
  return (
    <div className={cx("toast", props.tone, action && "has-action")}>
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

/**
 * Shows the toasts that toast() (apps/web/src/toast.ts) sends as a window event, one at a time; a newer one replaces the
 * one on screen, except that a toast whose action (an Undo) can still be pressed is never taken away by a plain one:
 * that waits (the latest only) and shows once the action has ended or the toast is dismissed (`toastArrives`). The live
 * region stays in the page while empty, so screen readers announce each new message. Mount it once, near the root of
 * the signed-in app. A toast with an action stays while the action is possible.
 */
export function Toaster() {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionOnScreen = useRef(false);
  const waiting = useRef<ToastMessage | null>(null);
  const show = useRef<(m: ToastMessage) => void>(() => undefined);
  const end = useRef<() => void>(() => undefined);
  show.current = (m: ToastMessage) => {
    if (timer.current) clearTimeout(timer.current);
    actionOnScreen.current = !!m.action;
    setMessage(m);
    timer.current = setTimeout(() => end.current(), toastDuration(m));
  };
  end.current = () => {
    if (timer.current) clearTimeout(timer.current);
    actionOnScreen.current = false;
    const next = waiting.current;
    waiting.current = null;
    if (next) show.current(next);
    else setMessage(null);
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
      {message ? <Toast {...message} onDismiss={dismiss} /> : null}
    </div>
  );
}
