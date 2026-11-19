"use client";

import { useId } from "react";
import type { CandidateActionState } from "@ros/contracts";
import { Button, type ButtonVariant } from "@ros/ui";
import { toast } from "../../toast";

/**
 * One of a person's actions as a button, in the API's words. One that is not allowed now is greyed, but it can still be
 * focused and pressed: its reason (the API's sentence) is its tooltip, is read with it by a screen reader, and is said
 * in a toast when it is pressed. `who` names the person, so a screen reader hears whose button it is.
 */
export function ActionButton(props: { state: CandidateActionState; who: string; variant?: ButtonVariant; size?: "sm" | "md"; busy?: boolean; waiting?: boolean; onRun: () => void }) {
  const { state } = props;
  const reasonId = useId();
  const name = `${state.label}: ${props.who}`;
  if (state.allowed) return <Button size={props.size} variant={props.variant} loading={props.busy} disabled={props.waiting} ariaLabel={name} onClick={props.onRun}>{state.label}</Button>;
  const reason = state.reason ?? "This is not possible right now.";
  return (
    <>
      <Button size={props.size} variant={props.variant} ariaDisabled describedBy={reasonId} ariaLabel={name} title={reason} onClick={() => toast(reason)}>{state.label}</Button>
      <span id={reasonId} className="sr-only">{reason}</span>
    </>
  );
}
