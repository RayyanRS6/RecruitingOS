import { REVISABLE_SECTION_LABEL, formatPayRange, packetVisibility, type DraftRolePacket, type Location, type PacketDiff, type PacketDiffChange, type PacketDiffSection } from "@ros/contracts";
import { EMPLOYMENT_LABEL, WORK_MODEL_LABEL } from "./job-preview";

/**
 * What changed between two packets, field by field, in plain words (plan C10: the version diff, and the change a chat
 * request would make before anyone confirms it). Items with keys (must-haves, questions, interview steps) are matched by
 * key, so a reworded must-have reads as one change, not a removal and an addition. Provenance and the approval rules
 * are the server's own record and are not listed; the legal notices are, because a new place can bring a new notice.
 */

const REASON: Record<string, string> = { new_position: "A new position", replacement: "Replacing someone who left", growth: "The team is growing", seasonal: "Seasonal help", other: "Other" };
const URGENCY: Record<string, string> = { low: "No rush", normal: "Normal", high: "Soon", critical: "Urgently" };
const FORMAT: Record<string, string> = { video: "video call", phone: "phone call", onsite: "in person", working_session: "working session" };
const TONE: Record<string, string> = { warm: "Warm", direct: "Direct", formal: "Formal" };
const ELIGIBILITY: Record<string, string> = { license: "license", certification: "certification", work_authorization: "work authorization", schedule_availability: "schedule", start_date: "start date", location_radius: "distance", physical_requirement_bona_fide: "physical task", minimum_age_legal: "legal minimum age" };
const CHANNEL: Record<string, string> = { careers_page: "Careers page", google_jobs: "Google", indeed: "Indeed", linkedin_basic: "LinkedIn", ziprecruiter: "ZipRecruiter", referrals: "Referrals", rediscovery: "Past applicants", associations: "Associations", schools: "Schools", other: "Other" };
const NOTICE: Record<string, string> = { ai_use: "AI use notice", privacy: "Privacy notice", pay_transparency: "Pay transparency notice", sms_consent: "Text message consent", recording: "Recording notice", adverse_decision_explanation: "Decision explanation notice" };

const place = (l: Location) => [l.label, [l.city, l.region].filter(Boolean).join(", ")].filter(Boolean).join(": ") || l.country;
const dollars = (n: number) => `$${n.toLocaleString("en-US")}`;
const text = (v: string | null | undefined) => (v === undefined || v === null || v.trim() === "" ? null : v.trim());

type Field = { path: string; label: string; get: (p: DraftRolePacket) => string | null };
type KeyedList = { path: string; label: string; items: (p: DraftRolePacket) => Array<{ key: string; value: string }> };
type PlainList = { path: string; label: string; items: (p: DraftRolePacket) => string[] };
type Section = { section: string; label: string; fields?: Field[]; keyed?: KeyedList[]; lists?: PlainList[] };

const SECTIONS: Section[] = [
  {
    section: "identity",
    label: REVISABLE_SECTION_LABEL.identity,
    fields: [
      { path: "identity.title", label: "Job title", get: (p) => text(p.identity.title) },
      { path: "identity.locations", label: "Where", get: (p) => p.identity.locations.map(place).join("; ") || null },
      { path: "identity.employmentType", label: "Job type", get: (p) => EMPLOYMENT_LABEL[p.identity.employmentType] ?? p.identity.employmentType },
      { path: "identity.schedule", label: "Schedule", get: (p) => text(p.identity.schedule) },
      { path: "identity.remotePolicy", label: "Work model", get: (p) => WORK_MODEL_LABEL[p.identity.remotePolicy] ?? p.identity.remotePolicy },
      { path: "identity.department", label: "Department", get: (p) => text(p.identity.department) },
      { path: "identity.reportsTo", label: "Reports to", get: (p) => text(p.identity.reportsTo) },
    ],
  },
  {
    section: "business",
    label: REVISABLE_SECTION_LABEL.business,
    fields: [
      { path: "business.reason", label: "Why you are hiring", get: (p) => REASON[p.business.reason] ?? p.business.reason },
      { path: "business.reasonDetail", label: "More on why", get: (p) => text(p.business.reasonDetail) },
      { path: "business.timeline.targetStartDate", label: "Target start date", get: (p) => text(p.business.timeline.targetStartDate) },
      { path: "business.timeline.urgency", label: "How soon", get: (p) => URGENCY[p.business.timeline.urgency] ?? p.business.timeline.urgency },
      { path: "business.timeline.inactivityDays", label: "Follow up with a quiet applicant after", get: (p) => `${p.business.timeline.inactivityDays} days` },
    ],
  },
  {
    section: "compensation",
    label: REVISABLE_SECTION_LABEL.compensation,
    fields: [
      { path: "compensation.basis", label: "Paid", get: (p) => (p.compensation ? (p.compensation.basis === "hourly" ? "By the hour" : "A yearly salary") : null) },
      { path: "compensation.min", label: "Pay range", get: (p) => (p.compensation ? formatPayRange(p.compensation) : "Not set yet") },
      { path: "compensation.ceiling", label: "Private ceiling", get: (p) => (p.compensation ? dollars(p.compensation.ceiling) : null) },
      { path: "compensation.bonus", label: "Bonus", get: (p) => text(p.compensation?.bonus) },
      { path: "compensation.benefitsSummary", label: "Benefits", get: (p) => text(p.compensation?.benefitsSummary) },
      { path: "compensation.discloseRange", label: "Pay range shown on the job ad", get: (p) => (p.compensation ? (p.compensation.discloseRange ? "Yes" : "No") : null) },
    ],
  },
  {
    section: "description",
    label: REVISABLE_SECTION_LABEL.description,
    fields: [
      { path: "description.publicJobDescription", label: "Job description", get: (p) => text(p.description.publicJobDescription) },
      { path: "description.internalNotes", label: "Notes for the team", get: (p) => text(p.description.internalNotes) },
    ],
  },
  {
    section: "requirements",
    label: REVISABLE_SECTION_LABEL.requirements,
    keyed: [
      { path: "requirements.mustHaves", label: "Must-have", items: (p) => p.requirements.mustHaves.map((m) => ({ key: m.key, value: m.text })) },
      { path: "requirements.niceToHaves", label: "Nice-to-have", items: (p) => p.requirements.niceToHaves.map((m) => ({ key: m.key, value: m.text })) },
      { path: "requirements.eligibility", label: "Eligibility question", items: (p) => p.requirements.eligibility.map((e) => ({ key: e.key, value: `${e.question} (${ELIGIBILITY[e.type] ?? e.type}${e.knockout ? "" : ", asked but not required"}). Why: ${e.rationale}` })) },
    ],
  },
  {
    section: "competencies",
    label: REVISABLE_SECTION_LABEL.competencies,
    keyed: [{ path: "competencies", label: "What you look for", items: (p) => p.competencies.map((c) => ({ key: c.key, value: `${c.name} (importance ${c.weight} of 5): ${c.definition}` })) }],
  },
  {
    section: "evaluation",
    label: REVISABLE_SECTION_LABEL.evaluation,
    lists: [
      { path: "evaluation.criteria", label: "How applicants are judged", items: (p) => p.evaluation.criteria },
      { path: "evaluation.redFlags", label: "Warning sign to talk about", items: (p) => p.evaluation.redFlags },
    ],
  },
  {
    section: "screening",
    label: REVISABLE_SECTION_LABEL.screening,
    fields: [
      { path: "screening.questions", label: "Order of the screening questions", get: (p) => p.screening.questions.map((q) => q.key).join(" ") },
      { path: "screening.maxMinutes", label: "Screening chat length", get: (p) => `About ${p.screening.maxMinutes} minutes` },
    ],
    keyed: [{ path: "screening.questions", label: "Screening question", items: (p) => p.screening.questions.map((q) => ({ key: q.key, value: q.question })) }],
  },
  {
    section: "interviews",
    label: REVISABLE_SECTION_LABEL.interviews,
    keyed: [{ path: "interviews.plan", label: "Interview step", items: (p) => p.interviews.plan.map((r) => ({ key: r.key, value: `${r.title} (${r.durationMinutes} minutes, ${FORMAT[r.format] ?? r.format}${r.interviewerUserIds.length ? `, ${r.interviewerUserIds.length} ${r.interviewerUserIds.length === 1 ? "interviewer" : "interviewers"}` : ""})` })) }],
  },
  {
    section: "communication",
    label: REVISABLE_SECTION_LABEL.communication,
    fields: [
      { path: "communication.tone", label: "Message tone", get: (p) => TONE[p.communication.tone] ?? p.communication.tone },
      { path: "communication.companyBlurb", label: "About the company", get: (p) => text(p.communication.companyBlurb) },
      { path: "communication.signature", label: "Signature", get: (p) => text(p.communication.signature) },
      { path: "communication.disclosureText", label: "AI notice", get: (p) => text(p.communication.disclosureText) },
      { path: "communication.humanAlternativeText", label: "How to reach a person", get: (p) => text(p.communication.humanAlternativeText) },
    ],
    lists: [{ path: "communication.candidateMayBeTold", label: "What the assistant may tell candidates", items: (p) => p.communication.candidateMayBeTold }],
  },
  {
    section: "sourcing",
    label: REVISABLE_SECTION_LABEL.sourcing,
    fields: [
      { path: "sourcing.summary", label: "Posting plan", get: (p) => text(p.sourcing.summary) },
      { path: "sourcing.sponsoredDailyBudget", label: "Paid ads per day", get: (p) => (p.sourcing.sponsoredDailyBudget ? dollars(p.sourcing.sponsoredDailyBudget) : "None") },
    ],
    lists: [
      { path: "sourcing.channels", label: "Posted on", items: (p) => p.sourcing.channels.map((c) => CHANNEL[c] ?? c) },
      { path: "sourcing.targetSources", label: "Places to look", items: (p) => p.sourcing.targetSources },
    ],
  },
  {
    section: "preferences",
    label: REVISABLE_SECTION_LABEL.preferences,
    fields: [
      { path: "preferences.decisionMakerUserId", label: "Decision maker", get: (p) => text(p.preferences.decisionMakerName) ?? (p.preferences.decisionMakerUserId ? "A team member" : null) },
      { path: "preferences.whatFailureLooksLike", label: "What a bad hire would look like", get: (p) => text(p.preferences.whatFailureLooksLike) },
      { path: "preferences.interviewStyle", label: "Interview style", get: (p) => text(p.preferences.interviewStyle) },
    ],
    lists: [
      { path: "preferences.dealBreakersInTheirWords", label: "Deal-breaker", items: (p) => p.preferences.dealBreakersInTheirWords },
      { path: "preferences.schedulingWindows", label: "Times for interviews", items: (p) => p.preferences.schedulingWindows },
    ],
  },
  {
    section: "compliance",
    label: "Legal notices",
    lists: [{ path: "compliance.notices", label: "Notice shown to candidates", items: (p) => p.compliance.notices.map((n) => NOTICE[n] ?? n) }],
  },
];

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function change(path: string, label: string, before: string | null, after: string | null, visibilityPath = path): PacketDiffChange | null {
  if (before === after) return null;
  const kind = before === null ? "added" : after === null ? "removed" : "changed";
  return { path, label, kind, before, after, visibility: packetVisibility(visibilityPath) };
}

/**
 * The differences from `before` to `after` (`before` null: everything in `after` reads as added). `includePay` false
 * leaves the pay section out entirely, for people who may not see pay. `from` and `to` name the versions, when they are.
 */
export function diffPackets(before: DraftRolePacket | null, after: DraftRolePacket, opts: { from?: number | null; to?: number | null; includePay?: boolean } = {}): PacketDiff {
  const sections: PacketDiffSection[] = [];
  for (const s of SECTIONS) {
    if (s.section === "compensation" && opts.includePay === false) continue;
    const changes: PacketDiffChange[] = [];
    for (const f of s.fields ?? []) {
      const c = change(f.path, f.label, before ? f.get(before) : null, f.get(after));
      // The order line only matters when the same questions moved; additions and removals are listed one by one below.
      if (c && f.path === "screening.questions") {
        const was = new Set(before?.screening.questions.map((q) => q.key) ?? []);
        const now = new Set(after.screening.questions.map((q) => q.key));
        if (!before || was.size !== now.size || [...now].some((k) => !was.has(k))) continue;
        changes.push({ ...c, before: before.screening.questions.map((q) => q.question).join(" / "), after: after.screening.questions.map((q) => q.question).join(" / ") });
        continue;
      }
      if (c) changes.push(c);
    }
    for (const list of s.keyed ?? []) {
      const was = before ? list.items(before) : [];
      const now = list.items(after);
      for (const item of now) {
        const prior = was.find((w) => w.key === item.key);
        const c = change(`${list.path}[${item.key}]`, list.label, prior?.value ?? null, item.value, list.path);
        if (c) changes.push(c);
      }
      for (const item of was) if (!now.some((n) => n.key === item.key)) changes.push(change(`${list.path}[${item.key}]`, list.label, item.value, null, list.path)!);
    }
    for (const list of s.lists ?? []) {
      const was = before ? list.items(before) : [];
      const now = list.items(after);
      now.forEach((v, i) => { if (!was.some((w) => norm(w) === norm(v))) changes.push(change(`${list.path}[${i}]`, list.label, null, v, list.path)!); });
      was.forEach((v, i) => { if (!now.some((n) => norm(n) === norm(v))) changes.push(change(`${list.path}[${i}]`, list.label, v, null, list.path)!); });
    }
    if (changes.length) sections.push({ section: s.section, label: s.label, changes });
  }
  return { from: opts.from ?? null, to: opts.to ?? null, sections, total: sections.reduce((n, s) => n + s.changes.length, 0) };
}
