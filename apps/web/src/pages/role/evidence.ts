import type { EvidenceSource } from "../../api/client";
import { checkedInLabel } from "../../skills-form";

/**
 * Where a must-have is checked, in one set of words for the job's Scoring tab ("Evidenced in", RolePlan.tsx
 * RequirementList) and the editor's ticks (RoleEditor.tsx): the screening conversation is the "AI interview", as in the
 * skill rows (skills-form.ts checkedInLabel). Pure; apps/shell/components/role-evidence-ui.test.ts checks it.
 */
export const EVIDENCE_LABEL: Readonly<Record<EvidenceSource, string>> = { resume: "résumé", application: "application", screen: checkedInLabel("screen"), interview: "interview" };

/** The editor's ticks for where a must-have is checked, in this order. */
export const EVIDENCE_CHOICES: ReadonlyArray<{ value: EvidenceSource; label: string }> = (["resume", "application", "screen", "interview"] as const).map((value) => ({ value, label: EVIDENCE_LABEL[value] }));

/** A must-have's "Evidenced in" words: its sources joined by " / ", an unknown one as it came, or "not set". */
export function evidencedInWords(sources: readonly EvidenceSource[] | null | undefined): string {
  return (sources ?? []).map((e) => EVIDENCE_LABEL[e] ?? e).join(" / ") || "not set";
}
