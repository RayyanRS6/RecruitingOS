"use client";

import type { IntakeDraftSummary } from "@ros/contracts";
import { Icon, IconChip, Pill } from "@ros/ui";
import { draftRow } from "../jobs";
import { Link } from "../nav";
import { LINKED_ROW, ROW_TITLE } from "../pages/look";

/** Unfinished drafts as rows, each opening the job builder on it: on Home, on the Jobs page and under the builder's first box. */
export function DraftRows({ drafts, label }: { drafts: readonly IntakeDraftSummary[]; label: string }) {
  if (!drafts.length) return null;
  return (
    <ul className="list-card" aria-label={label}>
      {drafts.map((d) => {
        const row = draftRow(d);
        return (
          <li key={row.id} className={LINKED_ROW}>
            <span className="list-row-lead"><IconChip icon="file-text" tone="peach" size="sm" /></span>
            <span className="list-row-main">
              <Link to={row.href} className={ROW_TITLE}>{row.title}</Link>
              {row.facts.length ? <span className="list-row-meta">{row.facts.map((f) => <span key={f}>{f}</span>)}</span> : null}
            </span>
            <span className="list-row-end"><Pill size="sm">Draft</Pill></span>
            <Icon name="arrow-right" className="chev max-sm:hidden" />
          </li>
        );
      })}
    </ul>
  );
}
