import { MATCH_WEIGHT, MISSING_MUST_HAVE_CAP, importanceOf, matchBand, type Confidence, type EvidenceAssessment, type Importance, type MatchCriterion, type MatchScore, type MatchUnknown, type MustHaveSummary, type ReadingVersion, type RolePacket } from "@ros/contracts";

/**
 * The match score (founder decision B2; plan-adjustments section 1): a 0-100 number worked out by code from the stored,
 * quote-checked findings, never written by the model. Pure, and imports nothing but the contracts, so the list, the
 * board, the candidate panel and the evals (packages/evals) all read the same function over the same rows.
 *
 * - Each must-have and each skill of the role is a requirement. Must-haves count most; a skill counts by its importance
 *   (Essential, Important, Helpful; plan F3).
 * - A requirement the evidence says nothing about is set aside, not penalised: it is left out of the score and shown as
 *   coverage ("based on 5 of 7 requirements") and as an open question.
 * - Met counts in full, partly met counts half, not met counts nothing. A must-have counts as not met, and a skill as
 *   going against the candidate, only on a verified quote from their own words; anything else is "not known".
 * - A must-have shown not met holds the score at 54 at most and is named ("Missing must-have: ...").
 * - Per requirement the screening conversation's finding wins where it has one (the candidate spoke to it directly);
 *   otherwise the résumé reading's counts.
 */
export const MATCH_SCORE_PROMISE = "A match score worked out from checked evidence, with the breakdown shown. A person always decides.";

type Findings = Pick<EvidenceAssessment, "requirementFindings" | "competencyFindings">;
/** A stored reading as the score reads it: "triage" (the résumé reading) or "screen" (the scorecard). */
export type ScoredReading = { kind: string; confidence?: string | null; packetVersion?: number | null; createdAt?: string | null; result: Findings & { confidence?: string } };
export type ReadingPair<T extends ScoredReading = ScoredReading> = { resume: T | null; screen: T | null };

/** The newest résumé reading and the newest scorecard among an application's assessments, given in any order. */
export function readingPair<T extends ScoredReading>(rows: readonly T[]): ReadingPair<T> {
  const newest = (kind: (k: string) => boolean) => {
    let best: T | null = null;
    for (const r of rows) {
      if (!kind(r.kind)) continue;
      if (!best || (r.createdAt && best.createdAt && Date.parse(r.createdAt) > Date.parse(best.createdAt))) best = r;
    }
    return best;
  };
  return { resume: newest((k) => k !== "screen"), screen: newest((k) => k === "screen") };
}

type Status = "yes" | "partly" | "no" | "unknown";
/** `unquotedNo`: still not known, but a reading said "not met" (or "goes against it") with nothing quoted to back it. */
type Resolved = { status: Status; source: "resume" | "screen"; quote: string | null; unquoted: boolean; unquotedNo: boolean };
type Evidence = { quote?: string; unquoted?: boolean } | undefined;
type Found = { status: Status; e: Evidence; saidNo: boolean };

const verified = (e: Evidence) => !!e?.quote?.trim() && !e.unquoted;

function requirementStatus(met: string, e: Evidence): Status {
  if (met === "yes") return "yes";
  if (met === "partially") return "partly";
  return met === "no" && verified(e) ? "no" : "unknown";
}

function competencyStatus(finding: string, e: Evidence): Status {
  if (finding === "evidenced") return "yes";
  if (finding === "partially_evidenced") return "partly";
  // "not evidenced" is missing information, set aside; "goes against it" needs the candidate's own words
  return finding === "contradicted" && verified(e) ? "no" : "unknown";
}

/** The finding for one requirement: the screen's when it has a known one, otherwise the résumé reading's. */
function resolve(pair: ReadingPair, find: (r: Findings) => Found | null): Resolved {
  const pick = (r: ScoredReading | null, source: "resume" | "screen"): Resolved | null => {
    const f = r ? find(r.result) : null;
    return f && f.status !== "unknown" ? { status: f.status, source, quote: f.e?.quote?.trim() || null, unquoted: !!f.e?.unquoted || !f.e?.quote?.trim(), unquotedNo: false } : null;
  };
  const unquotedNo = [pair.screen, pair.resume].some((r) => !!r && !!find(r.result)?.saidNo);
  return pick(pair.screen, "screen") ?? pick(pair.resume, "resume") ?? { status: "unknown", source: pair.screen && !pair.resume ? "screen" : "resume", quote: null, unquoted: true, unquotedNo };
}

const mustHaveFound = (m: { key: string }) => (r: Findings): Found | null => {
  const f = (r.requirementFindings ?? []).find((x) => x.requirementKey === m.key);
  return f ? { status: requirementStatus(f.met, f.evidence), e: f.evidence, saidNo: f.met === "no" } : null;
};

const PCT: Record<Exclude<Status, "unknown">, number> = { yes: 100, partly: 50, no: 0 };
const MUST_HAVE_WORDS: Record<Exclude<Status, "unknown">, string> = { yes: "Shown", partly: "Partly shown", no: "Not met" };
const SKILL_WORDS: Record<Exclude<Status, "unknown">, string> = { yes: "Shown", partly: "Partly shown", no: "Goes against it" };

type Requirement = { key: string; label: string; mustHave: boolean; importance: Importance | null; weight: number; found: Resolved };

function requirementsOf(pair: ReadingPair, packet: Pick<RolePacket, "requirements" | "competencies">): Requirement[] {
  const must = packet.requirements.mustHaves.map((m): Requirement => ({ key: m.key, label: m.text, mustHave: true, importance: null, weight: MATCH_WEIGHT.must_have, found: resolve(pair, mustHaveFound(m)) }));
  const skills = packet.competencies.map((c): Requirement => {
    const importance = importanceOf(c);
    return {
      key: c.key, label: c.name, mustHave: false, importance, weight: MATCH_WEIGHT[importance],
      found: resolve(pair, (r) => { const f = (r.competencyFindings ?? []).find((x) => x.competencyKey === c.key); return f ? { status: competencyStatus(f.finding, f.evidence), e: f.evidence, saidNo: f.finding === "contradicted" } : null; }),
    };
  });
  return [...must, ...skills];
}

/** The newer of the two readings: its confidence is the one shown beside the score. */
function latestOf(pair: ReadingPair): ScoredReading | null {
  const { resume, screen } = pair;
  if (resume && screen && resume.createdAt && screen.createdAt) return Date.parse(resume.createdAt) > Date.parse(screen.createdAt) ? resume : screen;
  return screen ?? resume;
}

const confidenceOf = (r: ScoredReading | null): Confidence | null => {
  const c = r?.confidence ?? r?.result.confidence;
  return c === "high" || c === "medium" || c === "low" ? c : null;
};

/**
 * The match score of one application from its readings, against the version of the role they were read against.
 * Null when there is no reading at all; `score` null when no requirement could be judged yet.
 */
export function matchScore(pair: ReadingPair, packet: Pick<RolePacket, "requirements" | "competencies">, opts: { packetVersion?: number | null } = {}): MatchScore | null {
  if (!pair.resume && !pair.screen) return null;
  const all = requirementsOf(pair, packet);
  const known = all.filter((r) => r.found.status !== "unknown");
  const total = known.reduce((n, r) => n + r.weight, 0);
  let lost = 0;
  const breakdown: MatchCriterion[] = known.map((r) => {
    const status = r.found.status as Exclude<Status, "unknown">;
    const share = (100 * r.weight) / total;
    const exactLost = share * (1 - PCT[status] / 100);
    lost += exactLost;
    return { key: r.key, label: r.label, mustHave: r.mustHave, importance: r.importance, weightPct: Math.round(share), pctMet: PCT[status], pointsLost: Math.round(exactLost), finding: (r.mustHave ? MUST_HAVE_WORDS : SKILL_WORDS)[status], source: r.found.source, quote: r.found.quote, unquoted: r.found.unquoted };
  });
  // The costliest first; then must-haves, the heavier, and by name, so the order never depends on the input's.
  breakdown.sort((a, b) => b.pointsLost - a.pointsLost || Number(b.mustHave) - Number(a.mustHave) || b.weightPct - a.weightPct || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  const missingMustHave = known.filter((r) => r.mustHave && r.found.status === "no").map((r) => ({ key: r.key, label: r.label, quote: r.found.quote ?? "" }));
  const raw = known.length ? Math.round(100 - lost) : null;
  const capped = raw !== null && missingMustHave.length > 0 && raw > MISSING_MUST_HAVE_CAP;
  const score = raw === null ? null : Math.min(100, Math.max(0, capped ? MISSING_MUST_HAVE_CAP : raw));
  const band = matchBand(score);
  const unknown: MatchUnknown[] = all.filter((r) => r.found.status === "unknown").map((r) => ({ key: r.key, label: r.label, mustHave: r.mustHave, importance: r.importance, ...(r.found.unquotedNo ? { unquotedNo: true } : {}) }));
  const sources = new Set(known.map((r) => r.found.source));
  const basedOn = sources.size === 2 || (!sources.size && pair.resume && pair.screen) ? "resume_and_screen" : sources.has("screen") || (!sources.size && pair.screen) ? "screen" : "resume";
  const latest = latestOf(pair);
  return {
    score,
    band: band?.band ?? null,
    bandLabel: band?.label ?? null,
    coverage: { known: known.length, total: all.length, words: coverageWords(known.length, all.length) },
    breakdown,
    unknown,
    fullMarks: breakdown.filter((c) => c.pctMet === 100).length,
    missingMustHave,
    capped,
    confidence: confidenceOf(latest),
    basedOn,
    packetVersion: opts.packetVersion ?? latest?.packetVersion ?? null,
  };
}

/** "Based on 5 of 7 requirements", in the words the badge and the panel show beside the score. */
export function coverageWords(known: number, total: number): string {
  if (!total) return "The role lists no requirements to score against.";
  if (!known) return "Nothing to score yet: the application does not speak to any requirement either way.";
  return known === total ? `Based on all ${total} requirements` : `Based on ${known} of ${total} requirements`;
}

/**
 * The must-have line on a card (plan F1), from the same findings as the score: shown, partly shown, shown not met (a
 * verified quote only) and not yet known. Null without a reading.
 */
export function mustHaveSummary(pair: ReadingPair, packet: Pick<RolePacket, "requirements">): MustHaveSummary | null {
  if (!pair.resume && !pair.screen) return null;
  const rows = packet.requirements.mustHaves.map((m) => ({ m, found: resolve(pair, mustHaveFound(m)) }));
  const count = (s: Status) => rows.filter((r) => r.found.status === s).length;
  const out = { total: rows.length, shown: count("yes"), partly: count("partly"), notShown: count("no"), unknown: count("unknown"), gaps: rows.filter((r) => r.found.status === "no").map((r) => ({ key: r.m.key, text: r.m.text, quote: r.found.quote ?? "" })) };
  return { ...out, words: mustHaveWords(out) };
}

function mustHaveWords(s: { total: number; shown: number; partly: number; notShown: number; unknown: number }): string {
  if (!s.total) return "This role lists no must-haves.";
  const parts = [`${s.shown} of ${s.total} shown`];
  if (s.partly) parts.push(`${s.partly} partly`);
  if (s.notShown) parts.push(`${s.notShown} not met`);
  if (s.unknown) parts.push(`${s.unknown} not yet known`);
  return `Must-haves: ${parts.join(", ")}`;
}

/**
 * The label when a reading was made against an earlier version of the role (plan F4); null when it is the current one.
 * With both packets, it also says whether the must-haves changed between them (added, removed or reworded).
 */
export function readingVersion(readAgainst: number | null | undefined, current: number | null | undefined, packets?: { then: Pick<RolePacket, "requirements"> | null | undefined; now: Pick<RolePacket, "requirements"> | null | undefined }): ReadingVersion | null {
  if (!readAgainst || !current || readAgainst === current) return null;
  const changed = packets?.then && packets.now ? mustHavesKey(packets.then) !== mustHavesKey(packets.now) : undefined;
  return { readAgainst, current, label: `Read against version ${readAgainst} of the role; the role is now on version ${current}.${changed ? " Its must-haves have changed since." : ""}`, ...(changed === undefined ? {} : { mustHavesChanged: changed }) };
}

const mustHavesKey = (p: Pick<RolePacket, "requirements">) => p.requirements.mustHaves.map((m) => `${m.key}=${m.text.trim().toLowerCase()}`).sort().join("|");
