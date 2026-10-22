import type { ReactNode } from "react";
import { cx, Icon } from "@ros/ui";

/**
 * The Recruiting OS mark: a plum tile with three bars, then the name with "OS" in coral. Used by the rail (and its top
 * bar on phones) and the not-found page. `sub` adds a small line under the name; `textClassName` lets the folded rail
 * keep only the tile on screen. Hook-free, so server pages can use it.
 *
 * The name is 19px bold, the welcome page's wordmark: the coral "OS" is 3.8:1 on the light surface, which passes WCAG AA
 * only as large text (bold from 18.66px), so it must not be drawn smaller or lighter.
 */
export function BrandMark(props: { sub?: ReactNode; textClassName?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-primary text-on-primary shadow-primary">
        <Icon name="bars" size={18} />
      </span>
      <span className={cx("grid min-w-0 text-left leading-tight", props.textClassName)}>
        <span className="truncate font-display text-[19px] font-bold tracking-[-0.02em] text-ink">
          Recruiting <span className="text-accent">OS</span>
        </span>
        {props.sub}
      </span>
    </span>
  );
}
