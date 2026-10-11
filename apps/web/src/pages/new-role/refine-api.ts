import { PACKET_REVISION_MESSAGE_MAX, type PacketFlag, type PacketRevisionProposal, type RequirementSuggestion, type RequirementsCheck, type RevisableSection } from "@ros/contracts";
import { sectionOfPath, type SectionId } from "./rules";

/**
 * "Change it by asking" (plan C10), the requirements check (C16) and the candidate view (C9), as the job builder and the
 * role page use them. The API is apps/api/src/routes/role-packets.ts: a request in the person's words comes back as a
 * proposed change (a summary and the change field by field); nothing is saved until a person presses Confirm, and "Keep
 * as is" is recorded too. The requirements check only suggests; each suggestion's fixes apply with one tap. Every
 * address the pages call is here.
 */

export type { PacketRevisionProposal, RequirementSuggestion, RequirementsCheck };

/** A draft still being written (before the role exists), or a role (a confirmed change becomes a new version). */
export type RefineTarget = { kind: "draft"; sessionId: string } | { kind: "role"; roleId: string };

/** A change request is a short instruction; longer text belongs in the conversation. */
export const CHANGE_REQUEST_MAX = PACKET_REVISION_MESSAGE_MAX;

export function refinePaths(t: RefineTarget) {
  const base = t.kind === "draft" ? `/api/v1/intake/sessions/${encodeURIComponent(t.sessionId)}` : `/api/v1/roles/${encodeURIComponent(t.roleId)}`;
  return {
    /** POST { message } → PacketRevisionProposal */
    revise: `${base}/revisions`,
    /** POST → { session, draft } for a draft; the new version ({ version, outcome }) for a role */
    apply: (revisionId: string) => `${base}/revisions/${encodeURIComponent(revisionId)}/apply`,
    /** POST → recorded as kept as it was */
    discard: (revisionId: string) => `${base}/revisions/${encodeURIComponent(revisionId)}/discard`,
    /** GET → RequirementsCheck */
    check: `${base}/requirements-check`,
    /** POST { base, fixIds } → the draft's session, or the role's new version */
    applyFixes: `${base}/requirements-check/apply`,
    /** GET → JobPreview (`?version=N` for a role's version) */
    preview: `${base}/preview`,
  };
}

/** Where each part of the packet a change may rewrite shows in the draft panel, when the change names no field. */
const PANEL_OF_SECTION: Readonly<Record<RevisableSection, SectionId | null>> = {
  identity: "basics",
  compensation: "basics",
  business: "why",
  description: "about",
  requirements: "must",
  screening: "screening",
  interviews: "team",
  preferences: "team",
  competencies: null,
  evaluation: null,
  communication: null,
  sourcing: null,
};

/** The draft panel's parts a proposal changes, each once, from the fields it changes (or the sections it names). */
export function proposalSections(p: Pick<PacketRevisionProposal, "diff" | "sections"> | null | undefined): SectionId[] {
  const out: SectionId[] = [];
  const add = (id: SectionId | null) => {
    if (id && !out.includes(id)) out.push(id);
  };
  for (const s of p?.diff.sections ?? []) for (const c of s.changes) add(sectionOfPath(c.path));
  if (!out.length) for (const s of p?.sections ?? []) add(PANEL_OF_SECTION[s] ?? null);
  return out;
}

/** The assistant asked back instead of changing anything: shown as its question, with nothing to confirm. */
export function asksBack(p: Pick<PacketRevisionProposal, "question" | "sections">): boolean {
  return !!p.question && p.sections.length === 0;
}

/** What pressing Confirm does, said before it is pressed. */
export function takesEffectWords(t: PacketRevisionProposal["takesEffect"]): string {
  if (t === "draft") return "Confirming changes the draft. Nothing is sent to anyone.";
  if (t === "now") return "Confirming saves a new version, used straight away. Every earlier version is kept.";
  if (t === "after_approval") return "Confirming saves a new version; it takes effect once it is approved.";
  return "Confirming saves a new version; it is used once the role is approved.";
}

/** One changed field as a line: added, taken out, or what it was and what it would be (long text shortened). */
export function changeLine(c: { kind: "added" | "removed" | "changed"; before: string | null; after: string | null }, max = 160): string {
  const cut = (s: string | null) => (s && s.length > max ? `${s.slice(0, max - 1)}…` : s ?? "");
  if (c.kind === "added") return `Added: ${cut(c.after)}`;
  if (c.kind === "removed") return `Taken out: ${cut(c.before)}`;
  return `${cut(c.before)} → ${cut(c.after)}`;
}

/** What a flagged phrase's "Change the wording" asks for: the words, and the lawful way to say what is meant. */
export function rewordInstruction(flag: Pick<PacketFlag, "text" | "alternative">): string {
  return `Reword "${flag.text}" so it no longer says that.${flag.alternative ? ` ${flag.alternative}` : ""} Keep everything else as it is.`;
}

/** The wording checks still waiting for a person: neither edited out nor kept with a reason. */
export function openFlags(flags: readonly PacketFlag[] | undefined): PacketFlag[] {
  return (flags ?? []).filter((f) => !f.kept);
}

/** The check's suggestions the person has not set aside on this page, with the panel part each is about. */
export function suggestionsBySection(check: Pick<RequirementsCheck, "suggestions"> | null | undefined, dismissed: readonly string[]): Map<SectionId | "other", RequirementSuggestion[]> {
  const out = new Map<SectionId | "other", RequirementSuggestion[]>();
  for (const s of check?.suggestions ?? []) {
    if (dismissed.includes(s.id)) continue;
    const id = sectionOfPath(s.path) ?? "other";
    out.set(id, [...(out.get(id) ?? []), s]);
  }
  return out;
}

/**
 * A short fingerprint of what the requirements check reads (the requirements, the description, the screening
 * questions), so the check is asked for again only when one of them changed, not on every edit.
 */
export function checkSignature(packet: { requirements: unknown; description: { publicJobDescription: string }; screening: { questions: unknown } } | null | undefined): string {
  if (!packet) return "none";
  const text = JSON.stringify([packet.requirements, packet.description.publicJobDescription, packet.screening.questions]);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}-${(h >>> 0).toString(36)}`;
}
