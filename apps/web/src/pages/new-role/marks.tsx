"use client";

import type { ReactNode } from "react";
import { PACKET_VISIBILITY_LABEL, type PacketVisibility } from "@ros/contracts";
import { Icon, IconLabel, type IconName } from "@ros/ui";
import { AI_NOTE } from "./quick-suggest";

/**
 * The job builder's small marks (fewer words, 23 October 2026): who sees a part of the job, and where an offered answer
 * came from. Each is the kit's IconLabel, an icon whose words a screen reader reads and a mouse sees as a tooltip, so the
 * same information is there without the words on screen. One exception keeps its words: the quick start's "AI suggestion".
 */

/** Who sees a part of the job: the eye when candidates see it or are asked it, the lock otherwise. */
export function SeenBy({ v, className }: { v: PacketVisibility; className?: string }) {
  return <IconLabel icon={v === "public" || v === "asked" ? "eye" : "lock"} label={PACKET_VISIBILITY_LABEL[v]} className={className} />;
}

/**
 * A field with who sees its answer at the end of its label row: the kit's field, two columns wide so the mark sits beside
 * the label. The mark stays outside the label, so the field's name is still its label alone.
 */
export function SeenField(props: { label: string; htmlFor: string; seen: PacketVisibility; hint?: string; children: ReactNode }) {
  return (
    <div className="field grid-cols-[minmax(0,1fr)_auto] items-center">
      <label htmlFor={props.htmlFor}>{props.label}</label>
      <SeenBy v={props.seen} />
      <div className="col-span-full grid min-w-0">{props.children}</div>
      {props.hint ? <span className="hint col-span-full">{props.hint}</span> : null}
    </div>
  );
}

/** Where an offered answer came from (an IntakeQuestion option's `origin`, or the quick start's job ad). */
const ORIGIN: Readonly<Record<string, { icon: IconName; label: string }>> = {
  assistant: { icon: "sparkle", label: AI_NOTE },
  playbook: { icon: "file-text", label: "Our hiring guide" },
  benchmark: { icon: "chart", label: "Market data" },
  owner: { icon: "user", label: "Your words" },
  ad: { icon: "paperclip", label: "Your job ad" },
};

/**
 * The mark at the end of an answer's row; the assistant's own ideas carry the sparkle. Nothing for the team's names.
 * With `aiInWords`, the assistant's say "AI suggestion" on screen too (an `.option-tag`; the row should wrap, see
 * OPTION_ROW_TAGGED): the quick start's AI-made must-haves and questions sit among the guide's, the job ad's and the
 * general ones, on steps with no other AI line, and they judge or are asked of applicants. AI use is a required notice
 * (docs/07: "labelled 'AI suggestion'"). In the job builder's question card the conversation's AI line covers it.
 */
export function OriginMark({ origin, aiInWords }: { origin?: string; aiInWords?: boolean }) {
  if (aiInWords && origin === "assistant") {
    return <span className="option-tag inline-flex items-center gap-1"><Icon name="sparkle" size={12} className="text-accent" />{AI_NOTE}</span>;
  }
  const o: { icon: IconName; label: string } | undefined = origin ? ORIGIN[origin] : undefined;
  return o ? <IconLabel icon={o.icon} label={o.label} /> : null;
}
