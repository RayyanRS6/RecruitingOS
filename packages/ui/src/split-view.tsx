"use client";

import { type ReactNode, useId, useState } from "react";
import { cx, domId } from "./helpers";

type Pane = "primary" | "secondary";

/**
 * Two panes side by side (docs/07): a conversation on the left and what it is building on the right, for example.
 * Under 900px there is room for one, so a switch above them flips between the two; both stay in the page, so nothing
 * typed in the hidden pane is lost. Controlled with `pane` and `onPaneChange` when the page needs to flip it (after
 * "Preview" is pressed on a phone), otherwise it keeps its own state. `stickySecondary` keeps the right pane in view
 * while the left one scrolls.
 */
export function SplitView(props: { primary: ReactNode; secondary: ReactNode; primaryLabel: string; secondaryLabel: string; pane?: Pane; onPaneChange?: (pane: Pane) => void; defaultPane?: Pane; ratio?: "even" | "wide-primary" | "wide-secondary"; stickySecondary?: boolean; switchLabel?: string }) {
  const reactId = useId();
  const base = domId("split", reactId);
  const [own, setOwn] = useState<Pane>(props.defaultPane ?? "primary");
  const shown = props.pane ?? own;
  const show = (pane: Pane) => {
    if (props.pane === undefined) setOwn(pane);
    props.onPaneChange?.(pane);
  };
  const switchButton = (pane: Pane, label: string) => (
    <button type="button" className={shown === pane ? "on" : ""} aria-pressed={shown === pane} aria-controls={`${base}-${pane}`} onClick={() => show(pane)}>
      {label}
    </button>
  );
  return (
    <div className="split" data-show={shown} data-ratio={props.ratio ?? "even"}>
      <fieldset className="segmented split-switch" aria-label={props.switchLabel ?? "Show"}>
        {switchButton("primary", props.primaryLabel)}
        {switchButton("secondary", props.secondaryLabel)}
      </fieldset>
      <section id={`${base}-primary`} className="split-pane split-primary" aria-label={props.primaryLabel}>
        {props.primary}
      </section>
      {/* keep-in-view, not "sticky": Tailwind's sticky utility would override the phone layout's static pane */}
      <section id={`${base}-secondary`} className={cx("split-pane", "split-secondary", props.stickySecondary && "keep-in-view")} aria-label={props.secondaryLabel}>
        {props.secondary}
      </section>
    </div>
  );
}
