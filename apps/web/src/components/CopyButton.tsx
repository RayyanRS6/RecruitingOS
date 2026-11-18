"use client";

import { Button } from "@ros/ui";
import { toast } from "../toast";

/** Puts `text` on the clipboard and says so; where the browser will not copy, says how to do it by hand. */
export function copyText(text: string, copied = "Copied."): void {
  const byHand = () => toast("Could not copy. Select the text and copy it by hand.");
  if (!navigator.clipboard?.writeText) return byHand();
  navigator.clipboard.writeText(text).then(() => toast(copied), byHand);
}

/** A small Copy button for a link or a text shown beside it. `label` names what it copies for a screen reader ("Copy the Apply link"). */
export function CopyButton(props: { text: string; label?: string; ariaLabel: string; disabled?: boolean; variant?: "primary" | "secondary" }) {
  return <Button size="sm" variant={props.variant ?? "secondary"} icon="copy" ariaLabel={props.ariaLabel} disabled={props.disabled} onClick={() => copyText(props.text)}>{props.label ?? "Copy"}</Button>;
}
