"use client";

import type { LegalCheck, PacketFlag } from "@ros/contracts";
import { Card, Icon } from "@ros/ui";

/**
 * What the law of the job's places asks of the ad, item by item as the server checked it: met or not, what is wrong
 * or what will happen, and how to fix it. Nothing here is worked out on the page.
 */
export function LegalCheckCard({ check }: { check: LegalCheck }) {
  if (!check.items.length) return null;
  return (
    <Card title="Legal check">
      <ul className="grid divide-y divide-line [&>li]:py-2.5 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0">
        {check.items.map((item) => (
          <li key={item.key} className="flex items-start gap-2.5">
            <span className={item.met ? "mt-0.5 flex-none text-good" : "mt-0.5 flex-none text-caution"}><Icon name={item.met ? "check-circle" : "alert"} size={18} label={item.met ? "Met" : "Not met yet"} /></span>
            <span className="grid min-w-0 gap-0.5">
              <strong>{item.label}</strong>
              {item.detail ? <span className="small text-ink-2">{item.detail}</span> : null}
              {!item.met && item.fix ? <span className="small text-ink-2">{item.fix}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The flagged wording a person chose to keep on a published job, with who kept it and why: folded, for the record. */
export function KeptWording({ flags }: { flags: readonly PacketFlag[] }) {
  const kept = flags.filter((f) => f.kept);
  if (!kept.length) return null;
  return (
    <details className="more">
      <summary>{`Wording kept on purpose (${kept.length})`}</summary>
      <ul className="grid gap-2">
        {kept.map((f) => (
          <li key={f.id} className="small text-ink-2 wrap-anywhere"><strong className="text-ink">"{f.text}"</strong> {f.kept?.reason}{f.kept?.by.name ? ` (${f.kept.by.name})` : ""}</li>
        ))}
      </ul>
    </details>
  );
}
