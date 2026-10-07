"use client";

import { useEffect, useRef, useState } from "react";
import { cx, normalizeToast, TOAST_EVENT, type ToastMessage, toastDuration } from "./helpers";
import { Icon } from "./icons";

/**
 * One toast: what happened, and when there is more to say a second line about what did or did not follow ("Moved to
 * Shortlist." / "Private: the candidate was not told."). A good outcome shows a tick, a failure an alert mark; the words
 * carry the meaning either way.
 */
export function Toast(props: ToastMessage) {
  return (
    <div className={cx("toast", props.tone)}>
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
    </div>
  );
}

/**
 * Shows the toasts that toast() (apps/web/src/toast.ts) sends as a window event, one at a time; a newer one replaces the
 * one on screen. The live region stays in the page while empty, so screen readers announce each new message. Mount it
 * once, near the root of the signed-in app.
 */
export function Toaster() {
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onToast = (e: Event) => {
      const next = normalizeToast((e as CustomEvent<unknown>).detail);
      if (!next) return;
      if (timer.current) clearTimeout(timer.current);
      setMessage(next);
      timer.current = setTimeout(() => setMessage(null), toastDuration(next));
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  return (
    <div className="toast-region" role="status">
      {message ? <Toast {...message} /> : null}
    </div>
  );
}
