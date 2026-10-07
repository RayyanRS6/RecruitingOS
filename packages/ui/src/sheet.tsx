"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { cx, holdPageScroll } from "./helpers";
import { Icon } from "./icons";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, iframe, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

/** Open panels, newest last: only the top one answers Escape and keeps Tab inside it (a sheet opened from a drawer). */
const openPanels: object[] = [];

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

/** Tab and Shift+Tab go round the panel's controls; focus that slipped out of the panel comes back in. */
function keepTabInside(e: globalThis.KeyboardEvent, root: HTMLElement) {
  const items = focusablesIn(root);
  const active = document.activeElement;
  if (items.length === 0) {
    e.preventDefault();
    root.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (!root.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * The right-hand drawer (docs/07): a sticky header (an optional avatar, the title, a line under it, actions, and an
 * optional row of tabs) over a scrolling body. A client component on purpose: while open it listens for Escape on the
 * document, so the key closes it wherever the focus is. When an action removes the button that had focus (a decision
 * card that disappears once recorded), focus falls back to the page, outside the dialog, and Escape must still work.
 * Tab stays inside the drawer, the page behind does not scroll, and closing puts focus back where it was.
 * `banner` sits in the sticky header under the title row: a question that has to be answered before anything else
 * ("You have text you have not sent").
 */
export function Drawer(props: { open: boolean; onClose: () => void; title: string; sub?: ReactNode; leading?: ReactNode; actions?: ReactNode; tabs?: ReactNode; banner?: ReactNode; size?: "md" | "lg"; children: ReactNode }) {
  const { open, onClose } = props;
  const panel = useRef<HTMLDivElement>(null);
  const token = useRef({});
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      // A menu inside the drawer that handled the key itself (Escape closing the menu) marks it as used.
      if (e.defaultPrevented || openPanels[openPanels.length - 1] !== token.current) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "Tab" && panel.current) keepTabInside(e, panel.current);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  useEffect(() => {
    if (!open) return;
    const mine = token.current;
    openPanels.push(mine);
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focus moves into the drawer unless something inside already took it (a field that focuses itself).
    if (panel.current && !panel.current.contains(document.activeElement)) panel.current.focus({ preventScroll: true });
    const releaseScroll = holdPageScroll(document.body);
    return () => {
      const at = openPanels.lastIndexOf(mine);
      if (at >= 0) openPanels.splice(at, 1);
      releaseScroll();
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [open]);
  if (!open) return null;
  return (
    // The backdrop is not a control: a click outside closes the drawer, Escape closes it from the keyboard, and the Close button does both.
    <div className="sheet-backdrop">
      <button type="button" className="sheet-backdrop-hit" aria-label="Close" onClick={onClose} />
      <div ref={panel} className={cx("sheet", props.size === "lg" && "lg")} role="dialog" aria-modal="true" aria-label={props.title} tabIndex={-1}>
        <div className="drawer-head">
          <div className="drawer-head-row">
            {props.leading}
            <div className="drawer-title">
              <h2>{props.title}</h2>
              {props.sub ? <p className="drawer-sub">{props.sub}</p> : null}
            </div>
            {props.actions ? <div className="drawer-actions">{props.actions}</div> : null}
            {/* the design system's icon button (IconButton in index.tsx), written out so this module does not import that file back */}
            <button type="button" className="icon-btn drawer-close" aria-label="Close" title="Close" onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
          {props.banner ? <div className="drawer-banner">{props.banner}</div> : null}
          {props.tabs}
        </div>
        <div className="drawer-body">{props.children}</div>
      </div>
    </div>
  );
}

/** The plain side panel: a drawer with a title and nothing else in its header. */
export function Sheet(props: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  return (
    <Drawer open={props.open} onClose={props.onClose} title={props.title}>
      {props.children}
    </Drawer>
  );
}
