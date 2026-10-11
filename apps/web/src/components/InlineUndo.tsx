"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@ros/ui";
import { undoMillisLeft } from "../telling";

/**
 * Undo where the Send was (plan G9), beside the toast's own: inside a panel the toast cannot be reached with Tab, so the
 * page that sent the message offers the same Undo while the message still waits (`undoUntil`), and hides it once it has
 * gone. `autoFocus` puts focus on it as it appears, so the Send button that disappeared does not leave focus nowhere.
 * `ariaLabel` says what it takes back ("Undo the decision message to Ana").
 */
export function InlineUndo(props: { undoUntil: string | null | undefined; onUndo: () => Promise<void> | void; label?: string; ariaLabel?: string; autoFocus?: boolean }) {
  const [open, setOpen] = useState(() => undoMillisLeft(props.undoUntil) > 0);
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const ms = undoMillisLeft(props.undoUntil);
    setOpen(ms > 0);
    if (ms <= 0) return;
    const t = setTimeout(() => setOpen(false), ms);
    return () => clearTimeout(t);
  }, [props.undoUntil]);
  // Focus only as it appears (a new Send), never again while it stays.
  const focusFor = useRef<string | null>(null);
  useEffect(() => {
    const key = props.undoUntil ?? null;
    if (!props.autoFocus || !open || focusFor.current === key) return;
    focusFor.current = key;
    button.current?.focus({ preventScroll: true });
  }, [props.autoFocus, props.undoUntil, open]);
  if (!open) return null;
  return (
    <button
      ref={button}
      type="button"
      className="btn quiet sm"
      aria-label={props.ariaLabel}
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await props.onUndo();
        } finally {
          setBusy(false);
          setOpen(false);
        }
      }}
    >
      <Icon name="arrow-left" />
      {props.label ?? "Undo"}
    </button>
  );
}
