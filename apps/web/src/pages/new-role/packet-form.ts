import type { RolePacket } from "../../api/client";

/**
 * The role editor's plain fields (plan C11, apps/web/src/pages/RoleEditor.tsx): the packet as the form holds it, the
 * first thing wrong with it in plain words, and the packet a save sends. Pure, so tests/web/job-builder.test.ts can
 * check that a save keeps everything the form does not show and respects the packet's limits (one place at least,
 * screening questions 3 to 12, must-haves 1 to 6).
 */

export const SCREENING_MIN = 3;
export const SCREENING_MAX = 12;

/** The kinds of screening question, in plain words. */
export const QUESTION_KINDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "skills", label: "Skills" },
  { value: "behavioral", label: "Past behaviour" },
  { value: "availability", label: "Availability" },
  { value: "compensation", label: "Pay expectations" },
  { value: "motivation", label: "Motivation" },
  { value: "logistics", label: "Logistics" },
  { value: "eligibility", label: "Eligibility" },
];

/** The only kinds of question that may hold an application (EligibilityRuleType in @ros/contracts), in plain words. */
export const ELIGIBILITY_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "license", label: "A licence the job needs" },
  { value: "certification", label: "A certification the job needs" },
  { value: "work_authorization", label: "Allowed to work in the US" },
  { value: "schedule_availability", label: "Available for the schedule" },
  { value: "start_date", label: "Can start by the date" },
  { value: "location_radius", label: "Can get to the workplace" },
  { value: "physical_requirement_bona_fide", label: "A physical requirement the job truly needs" },
  { value: "minimum_age_legal", label: "Legal minimum age (only where a law sets one)" },
];

export const TONES: ReadonlyArray<{ value: "warm" | "direct" | "formal"; label: string }> = [
  { value: "warm", label: "Warm" },
  { value: "direct", label: "Direct" },
  { value: "formal", label: "Formal" },
];

export type PlaceRow = { city: string; region: string };
export type QuestionRow = { key: string | null; question: string; kind: string };
export type EligibilityRow = { key: string | null; type: string; question: string; rationale: string; knockout: boolean };

export type PacketForm = {
  title: string;
  places: PlaceRow[];
  employmentType: string;
  schedule: string;
  remotePolicy: "onsite" | "hybrid" | "remote";
  basis: "hourly" | "salary";
  min: string;
  max: string;
  ceiling: string;
  benefits: string;
  questions: QuestionRow[];
  eligibility: EligibilityRow[];
  dealBreakers: string[];
  /** A team member's id and name, or "" with a name for someone not on the team yet. */
  decisionMakerUserId: string;
  decisionMakerName: string;
  tone: "warm" | "direct" | "formal";
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "item";
}

type Extra = { communication?: { tone?: string }; compensation: { benefitsSummary?: string } };

export function packetFormFrom(p: RolePacket): PacketForm {
  const x = p as RolePacket & Extra;
  return {
    title: p.identity.title,
    places: p.identity.locations.length ? p.identity.locations.map((l) => ({ city: l.city ?? "", region: l.region ?? "" })) : [{ city: "", region: "" }],
    employmentType: p.identity.employmentType,
    schedule: p.identity.schedule ?? "",
    remotePolicy: p.identity.remotePolicy ?? "onsite",
    basis: p.compensation.basis === "salary" ? "salary" : "hourly",
    min: String(p.compensation.min),
    max: String(p.compensation.max),
    ceiling: String(p.compensation.ceiling),
    benefits: x.compensation.benefitsSummary ?? "",
    questions: p.screening.questions.map((q) => ({ key: q.key, question: q.question, kind: q.kind })),
    eligibility: p.requirements.eligibility.map((e) => ({ key: e.key, type: e.type, question: e.question, rationale: e.rationale, knockout: e.knockout })),
    dealBreakers: [...p.preferences.dealBreakersInTheirWords],
    decisionMakerUserId: p.preferences.decisionMakerUserId ?? "",
    decisionMakerName: p.preferences.decisionMakerName ?? "",
    tone: x.communication?.tone === "direct" || x.communication?.tone === "formal" ? x.communication.tone : "warm",
  };
}

/** Moves a row up (-1) or down (+1), staying inside the list. */
export function moveRow<T>(rows: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= rows.length) return [...rows];
  const out = [...rows];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

const amount = (s: string) => Number(s.replace(/[$,\s]/g, ""));

/** The first thing in the plain fields that cannot be saved, in the owner's words, or null. */
export function packetFormProblem(f: PacketForm): string | null {
  if (f.title.trim().length < 2) return "Give the job a title.";
  if (!f.places.some((p) => p.city.trim() || p.region.trim())) return "Say where the job is: at least a city or a state.";
  const [min, max] = [amount(f.min), amount(f.max)];
  const ceiling = f.ceiling.trim() ? amount(f.ceiling) : max;
  if ([min, max, ceiling].some((n) => !Number.isFinite(n) || n < 0)) return "Pay minimum, maximum and the most you would pay must be numbers.";
  if (min > max) return "The pay minimum is above the maximum.";
  if (ceiling < max) return "The most you would pay must not be below the top of the range.";
  const qs = f.questions.filter((q) => q.question.trim());
  if (qs.length < SCREENING_MIN) return `Keep at least ${SCREENING_MIN} screening questions.`;
  if (qs.length > SCREENING_MAX) return `At most ${SCREENING_MAX} screening questions.`;
  if (f.eligibility.some((e) => e.question.trim() && !e.rationale.trim())) return "Every question on the application form needs a line on why it is asked.";
  return null;
}

/**
 * The packet a save sends: the form's fields written over a copy of the packet it was opened on, so everything the form
 * does not show is kept as it was. A row that keeps its key keeps it (assessments refer to it); a new one gets a
 * readable key. Empty rows are dropped.
 */
export function applyPacketForm(p: RolePacket, f: PacketForm): RolePacket {
  const next = structuredClone(p) as RolePacket & Extra;
  next.identity.title = f.title.trim();
  const before = p.identity.locations;
  next.identity.locations = f.places
    .filter((r) => r.city.trim() || r.region.trim())
    .map((r, i) => ({ ...(before[i] ?? {}), city: r.city.trim() || undefined, region: r.region.trim().toUpperCase() || undefined }));
  next.identity.employmentType = f.employmentType;
  next.identity.schedule = f.schedule.trim() || undefined;
  next.identity.remotePolicy = f.remotePolicy;
  next.compensation.basis = f.basis;
  next.compensation.min = amount(f.min);
  next.compensation.max = amount(f.max);
  next.compensation.ceiling = Math.max(f.ceiling.trim() ? amount(f.ceiling) : amount(f.max), amount(f.max));
  if (f.benefits.trim()) next.compensation.benefitsSummary = f.benefits.trim();
  else delete next.compensation.benefitsSummary;
  const oldQs = new Map(p.screening.questions.map((q) => [q.key, q]));
  const used = new Set<string>();
  next.screening.questions = f.questions
    .filter((q) => q.question.trim())
    .map((q, i) => {
      const was = q.key ? oldQs.get(q.key) : undefined;
      let key = q.key ?? `q_${i + 1}_${slug(q.question)}`;
      while (used.has(key)) key = `${key}_${i + 1}`;
      used.add(key);
      // A question whose words changed drops the model answer written for the old words.
      const same = was && was.question === q.question.trim();
      return { ...(same ? was : {}), key, question: q.question.trim(), kind: q.kind } as RolePacket["screening"]["questions"][number];
    });
  const oldRules = new Map(p.requirements.eligibility.map((e) => [e.key, e]));
  next.requirements.eligibility = f.eligibility
    .filter((e) => e.question.trim())
    .map((e, i) => {
      const was = e.key ? oldRules.get(e.key) : undefined;
      return { ...(was ?? { expectation: {} }), key: e.key ?? `elig_${i + 1}_${slug(e.question)}`, type: e.type, question: e.question.trim(), rationale: e.rationale.trim(), knockout: e.knockout } as RolePacket["requirements"]["eligibility"][number];
    });
  next.preferences.dealBreakersInTheirWords = f.dealBreakers.map((d) => d.trim()).filter(Boolean);
  if (f.decisionMakerUserId) {
    next.preferences.decisionMakerUserId = f.decisionMakerUserId;
    if (f.decisionMakerName.trim()) next.preferences.decisionMakerName = f.decisionMakerName.trim();
  } else {
    delete next.preferences.decisionMakerUserId;
    if (f.decisionMakerName.trim()) next.preferences.decisionMakerName = f.decisionMakerName.trim();
    else delete next.preferences.decisionMakerName;
  }
  if (next.communication) next.communication.tone = f.tone;
  return next;
}
