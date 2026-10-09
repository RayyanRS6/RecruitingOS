"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cx, domId, type Move, nextIndex, type OwnerStage, ownerStage, stageMenuItems, type Tone, typeaheadIndex } from "./helpers";
import { Icon, type IconName } from "./icons";

/**
 * One choice in a menu. `current` marks where things stand now (the stage a candidate is in). A `disabled` item stays
 * visible and reachable with the arrow keys, with its `reason` underneath, so a person can see why it cannot be chosen.
 */
export type MenuItem = { id: string; label: string; tone?: Tone; icon?: IconName; hint?: string; current?: boolean; disabled?: boolean; reason?: string; danger?: boolean };

const KEY_MOVES: Record<string, Move> = { ArrowDown: "next", ArrowUp: "prev", Home: "first", End: "last" };

/** The space kept between an open menu and the edge of the window. */
const EDGE = 8;

/**
 * Which side a menu of `width` opens on under a button at `button` (left and right, in window pixels): the preferred
 * side ("start" lines its left edge up with the button's, "end" its right edge), unless that runs past an edge of the
 * window and the other side runs past less.
 */
export function menuSide(preferred: "start" | "end", button: { left: number; right: number }, width: number, windowWidth: number): "start" | "end" {
  const past = (side: "start" | "end") => {
    const left = side === "start" ? button.left : button.right - width;
    return Math.max(0, EDGE - left) + Math.max(0, left + width - (windowWidth - EDGE));
  };
  const other = preferred === "start" ? "end" : "start";
  return past(preferred) > past(other) ? other : preferred;
}

/**
 * A button that opens a list of choices (docs/07), such as "Move to stage". Keyboard: Enter, Space or the down arrow
 * opens it on the current choice; the arrows, Home and End move; a letter jumps to the next choice starting with it;
 * Enter chooses; Escape closes and returns to the button; Tab closes and moves on. A click outside closes it too.
 * When any item has `current` set, the items act as a one-of-many choice and the current one is announced as checked.
 */
export function Menu(props: { label: ReactNode; items: MenuItem[]; onSelect: (id: string) => void; heading?: string; ariaLabel?: string; title?: string; buttonClassName?: string; align?: "start" | "end"; disabled?: boolean; currentLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const reactId = useId();
  const menuId = domId("menu", reactId);
  const oneOfMany = props.items.some((i) => i.current !== undefined);
  const preferred = props.align ?? "start";
  const [side, setSide] = useState<"start" | "end">(preferred);

  // The menu opens on its preferred side unless that would run past the edge of the window where the other side would
  // not (a button that wrapped to the left of a phone screen): nothing past the edge can be scrolled to.
  useLayoutEffect(() => {
    if (!open) return;
    const at = wrap.current?.getBoundingClientRect();
    const width = panel.current?.offsetWidth ?? 0;
    if (!at || !width) return setSide(preferred);
    setSide(menuSide(preferred, { left: at.left, right: at.right }, width, document.documentElement.clientWidth || window.innerWidth));
  }, [open, preferred]);
  useEffect(() => {
    if (open && active >= 0) items.current[active]?.focus();
  }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (e: PointerEvent) => {
      if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  const openAt = (where: "current" | "last") => {
    const current = props.items.findIndex((i) => i.current);
    setActive(where === "last" ? props.items.length - 1 : current >= 0 ? current : 0);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (refocus) trigger.current?.focus();
  };
  const choose = (item: MenuItem) => {
    if (item.disabled) return;
    close(true);
    if (!item.current) props.onSelect(item.id);
  };
  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openAt(e.key === "ArrowUp" ? "last" : "current");
    }
  };
  const onItemKey = (e: KeyboardEvent<HTMLButtonElement>, at: number) => {
    const move = KEY_MOVES[e.key];
    if (move) {
      e.preventDefault();
      setActive(nextIndex(props.items.length, at, move));
    } else if (e.key === "Escape") {
      // Handled here so a drawer around the menu stays open (it ignores keys already used).
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") {
      // Focus goes back to the button before the menu closes, and the browser's own Tab then moves on from the button:
      // the item that had focus is removed as the menu closes, so a drawer's Tab trap would otherwise find focus outside
      // the panel and send it to the panel's first control. No preventDefault: Tab moves on, Shift+Tab goes back.
      close(true);
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      setActive(typeaheadIndex(props.items.map((i) => i.label), at, e.key));
    }
  };

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className={props.buttonClassName ?? "btn secondary sm"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={props.ariaLabel}
        title={props.title}
        disabled={props.disabled}
        onClick={() => (open ? close(false) : openAt("current"))}
        onKeyDown={onTriggerKey}
      >
        {props.label}
        <Icon name="chevron-down" size={14} />
      </button>
      {open ? (
        <div ref={panel} className="menu" data-align={side}>
          {props.heading ? (
            <div className="menu-heading" aria-hidden="true">
              {props.heading}
            </div>
          ) : null}
          <div role="menu" id={menuId} aria-label={props.heading ?? props.ariaLabel ?? "Choices"} tabIndex={-1}>
            {props.items.map((item, i) => (
              <button
                key={item.id}
                ref={(el) => {
                  items.current[i] = el;
                }}
                type="button"
                {...(oneOfMany ? { role: "menuitemradio", "aria-checked": !!item.current } : { role: "menuitem" })}
                aria-disabled={item.disabled || undefined}
                tabIndex={i === active ? 0 : -1}
                className={cx("menu-item", item.danger && "danger")}
                onClick={() => choose(item)}
                onKeyDown={(e) => onItemKey(e, i)}
              >
                {item.tone ? <span className={cx("dot", item.tone)} aria-hidden="true" /> : item.icon ? <Icon name={item.icon} size={16} /> : <span aria-hidden="true" />}
                <span>{item.label}</span>
                {item.current ? <span className="menu-hint">{props.currentLabel ?? "Current"}</span> : item.hint ? <span className="menu-hint">{item.hint}</span> : <span />}
                {item.disabled && item.reason ? <span className="menu-reason">{item.reason}</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The stage button on a candidate's row and panel (plan adjustments §2): a pill with the stage's dot and word that opens
 * "Move to stage". Every stage is listed; one that cannot be chosen now stays visible, greyed, with its reason from
 * `blocked`. The page decides what a choice does (set a mark, open the interview card, the private decline) in `onMove`.
 * `label` replaces the stage's own word on the button when the page knows a closer one ("Not a fit for now").
 */
export function StageButton(props: { stage: string; onMove: (stage: OwnerStage) => void; blocked?: Partial<Record<OwnerStage, string>>; disabled?: boolean; align?: "start" | "end"; label?: string }) {
  const current = ownerStage(props.stage);
  const word = props.label ?? current.label;
  return (
    <Menu
      label={
        <>
          <span className="dot" aria-hidden="true" />
          {word}
        </>
      }
      items={stageMenuItems(current.id, props.blocked)}
      onSelect={(id) => props.onMove(id as OwnerStage)}
      heading="Move to stage"
      ariaLabel={`Stage: ${word}. Move to another stage`}
      buttonClassName={cx("pill-button", current.tone)}
      currentLabel="Now"
      align={props.align}
      disabled={props.disabled}
    />
  );
}
