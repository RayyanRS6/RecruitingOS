"use client";

import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import { cx, domId, type Move, nextIndex, tabIds } from "./helpers";
import { Icon, type IconName } from "./icons";

/** `marker`: something new in this tab since the reader last opened it; a dot, announced as "new". */
export type TabItem = { id: string; label: string; count?: number; icon?: IconName; disabled?: boolean; marker?: boolean };

const KEY_MOVES: Record<string, Move> = { ArrowRight: "next", ArrowLeft: "prev", Home: "first", End: "last" };

/**
 * Underlined tabs (docs/07), keyboard accessible the WAI-ARIA way: Tab reaches the chosen tab, the arrow keys, Home and
 * End move between tabs and choose as they go, and disabled tabs are passed over. Controlled with `value` and
 * `onChange`, or left to itself with `defaultValue`.
 *
 * The panel: pass `children` and the tabs wrap them in the chosen tab's panel; or, when the panel sits elsewhere (a
 * drawer's body, with the tabs in its header), give the same `idBase` to these tabs and to a <TabPanel>.
 * The `counts` variant puts each count above its label, for a stage strip ("6 New · 2 Shortlist").
 */
export function Tabs(props: { items: TabItem[]; label: string; value?: string; defaultValue?: string; onChange?: (id: string) => void; idBase?: string; variant?: "underline" | "counts"; children?: ReactNode }) {
  const reactId = useId();
  const base = props.idBase ?? domId("tabs", reactId);
  const [own, setOwn] = useState(props.defaultValue ?? props.items.find((t) => !t.disabled)?.id ?? "");
  const value = props.value ?? own;
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const chosen = props.items.findIndex((t) => t.id === value && !t.disabled);
  // Exactly one tab is reachable with Tab: the chosen one, or the first that can be chosen.
  const reachable = chosen >= 0 ? chosen : nextIndex(props.items.length, -1, "next", (i) => !!props.items[i].disabled);
  const panelShown = props.children !== undefined || props.idBase !== undefined;
  const choose = (id: string) => {
    if (props.value === undefined) setOwn(id);
    props.onChange?.(id);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const move = KEY_MOVES[e.key];
    if (!move) return;
    e.preventDefault();
    const to = nextIndex(props.items.length, from, move, (i) => !!props.items[i].disabled);
    if (to === from || to < 0) return;
    buttons.current[to]?.focus();
    choose(props.items[to].id);
  };
  return (
    <>
      <div role="tablist" aria-label={props.label} className={cx("tabs", props.variant === "counts" && "counts")} tabIndex={-1}>
        {props.items.map((t, i) => {
          const selected = i === chosen;
          const ids = tabIds(base, t.id);
          return (
            <button
              key={t.id}
              ref={(el) => {
                buttons.current[i] = el;
              }}
              type="button"
              role="tab"
              id={ids.tab}
              className="tab"
              aria-selected={selected}
              aria-controls={selected && panelShown ? ids.panel : undefined}
              tabIndex={i === reachable ? 0 : -1}
              disabled={t.disabled}
              data-empty={t.count === 0 ? "true" : undefined}
              onClick={() => choose(t.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {t.icon ? <Icon name={t.icon} size={16} /> : null}
              {/* data-label: the label keeps the width of its bold self, so choosing a tab never nudges the others (tokens.css) */}
              <span className="tab-label" data-label={t.label}>{t.label}</span>
              {/* the space keeps "New 2" two words for a screen reader; flex layout drops it on screen */}
              {t.count !== undefined ? <>{" "}<span className="count">{t.count}</span></> : null}
              {t.marker ? (
                <>
                  <span className="tab-dot" aria-hidden="true" />
                  <span className="sr-only"> (new)</span>
                </>
              ) : null}
            </button>
          );
        })}
      </div>
      {props.children !== undefined && chosen >= 0 ? (
        <TabPanel idBase={base} value={props.items[chosen].id}>
          {props.children}
        </TabPanel>
      ) : null}
    </>
  );
}

/** The content of the chosen tab, tied to it for screen readers. Use with the same `idBase` as the <Tabs>. */
export function TabPanel(props: { idBase: string; value: string; children: ReactNode }) {
  const ids = tabIds(props.idBase, props.value);
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the WAI-ARIA tabs pattern lets Tab reach a panel that may hold nothing focusable
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} tabIndex={0} className="tab-panel">
      {props.children}
    </div>
  );
}
