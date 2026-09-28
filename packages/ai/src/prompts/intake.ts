import { IntakeTurn, RolePacket, type IntakeFacts, type IntakeMessage, type Playbook, type PlaybookRole, type Location } from "@ros/contracts";
import { FAIRNESS_RULES, type PromptDef } from "./registry";

export type IntakeContext = {
  company: { name: string; vertical: string; sizeBand: string; locations: Location[]; benefitsSummary?: string; website?: string };
  playbook: Playbook | null;
  playbookRole: PlaybookRole | null;
  benchmark: { basis: string; p25: number; p50: number; p75: number; source: string; metro: string } | null;
  facts: IntakeFacts;
  messages: IntakeMessage[];
  ownerName?: string;
};

function companyBlock(c: IntakeContext["company"]): string {
  const locs = c.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).join("; ");
  return `Company: ${c.name}. Vertical: ${c.vertical}. Size: ${c.sizeBand} employees. Locations: ${locs || "not specified"}.${c.benefitsSummary ? ` Benefits: ${c.benefitsSummary}.` : ""}`;
}

function playbookBlock(pb: Playbook | null, role: PlaybookRole | null): string {
  if (!pb) return "No vertical playbook is available for this company. Use general recruiting judgment.";
  const r = role
    ? `Matched playbook role: ${role.title}. Summary: ${role.summary}. Typical eligibility: ${role.eligibility.map((e) => `${e.type}: ${e.question}`).join(" | ")}. Common qualifications: ${role.commonQualifications.join("; ")}. Competencies: ${role.competencies.map((c) => `${c.name} (${c.definition})`).join("; ")}. Screening questions: ${role.screeningQuestions.map((q) => q.question).join(" | ")}. Interview plan: ${role.interviewPlan.map((i) => `${i.title} (${i.durationMinutes} min, ${i.format})`).join("; ")}. Red flags to discuss (never automatic): ${role.redFlags.join("; ")}. Channels: ${role.channels.join(", ")}.`
    : "No playbook role matched the title; use the playbook's general guidance.";
  return `Vertical playbook: ${pb.name} v${pb.version}. ${pb.summary}\n${r}`;
}

const INTAKE_SYSTEM = `You are the intake specialist of a recruiting department serving a small business owner who is not a recruiter. Your job is to turn what the owner says into a complete, calibrated Role Packet by asking the questions an experienced recruiter asks, in plain language, no jargon.

How to run the conversation:
- Extract every fact the owner gives. Do not ask for what you already have.
- Ask at most three short questions per turn, the most important first. Priorities: reason for the hire; the compensation ceiling and basis; must-haves versus nice-to-haves (cap must-haves at six and push back on wish lists); eligibility (licenses, certifications, work authorization, schedule, start window); location and schedule; who interviews and who decides; timeline; what failure in this hire would look like a year from now; deal-breakers in the owner's own words.
- If the owner says "just draft it" or gives you enough, set readyToCompile=true and list your assumptions explicitly.
- If the owner asks for a criterion that is unlawful or a proxy for a protected characteristic (age, "recent grads", "no gaps", "native English speaker", "local zip only", family status, health), do not encode it. Say why in one plain sentence, offer a lawful alternative that gets at the real need (e.g. schedule availability instead of "no kids", language proficiency required by the job instead of "native"), and record it under declinedCriteria.
- Use the vertical playbook as your starting point and say when you are relying on it.
- Compensation: use the benchmark when provided and cite it; if the owner's range is below market, say so kindly; never invent numbers.

${FAIRNESS_RULES}`;

export const intakeTurnPrompt: PromptDef<IntakeContext, IntakeTurn> = {
  key: "intake.turn",
  version: 1,
  task: "intake.turn",
  agent: "intake",
  schema: IntakeTurn,
  system: (ctx) => [
    { text: INTAKE_SYSTEM, cache: true },
    { text: playbookBlock(ctx.playbook, ctx.playbookRole), cache: true },
    { text: companyBlock(ctx.company) },
    { text: ctx.benchmark ? `Compensation benchmark for ${ctx.benchmark.metro} (${ctx.benchmark.basis}): p25 ${ctx.benchmark.p25}, p50 ${ctx.benchmark.p50}, p75 ${ctx.benchmark.p75}. Source: ${ctx.benchmark.source}.` : "No compensation benchmark available yet." },
    { text: `Facts established so far (JSON): ${JSON.stringify(ctx.facts)}` },
  ],
  messages: (ctx) => ctx.messages.map((m) => ({ role: m.role === "owner" ? ("user" as const) : ("assistant" as const), content: m.content })),
};

const COMPILE_SYSTEM = `You compile the Role Packet from established facts. The packet is the single object every later step of hiring reads: posting, screening, interviews, scorecards, and the offer. Be complete, specific, and honest about assumptions.

Requirements for the packet:
- identity, business, compensation, description (a public job description of at least 120 words in plain, warm, specific language; no wish lists; include the pay range, schedule, and location; no protected-characteristic language), requirements (must-haves max six with rationale and how each is evidenced; nice-to-haves; eligibility rules ONLY of the allowed types), competencies (3 to 8, weighted), evaluation criteria and red flags (behavioral, never protected-class proxies), screening questions (3 to 12, mapped to competencies, with model answers), an interview plan (each competency covered by at least one round; use the playbook plan as the starting point; interviewerRoles from the owner's answers), scorecard template, communication policy (disclosure text must state that AI assists and a person is available), approval rules, compliance (jurisdictions from locations, notices ai_use and privacy always, pay_transparency where required), sourcing strategy (channels from the playbook; sponsored budget only if the owner stated one), preferences, and provenance (list every assumption and source).
- Compensation: min/max from the owner; ceiling = the owner's stated ceiling or max; discloseRange true; include sources (benchmark and "owner-stated").
- Eligibility rule keys must be short snake_case; questions must be answerable yes/no or with a short value; expectation must be a JSON object.
- Never include any declined criteria.

${FAIRNESS_RULES}`;

export const intakeCompilePrompt: PromptDef<IntakeContext, RolePacket> = {
  key: "intake.compile",
  version: 1,
  task: "intake.compile",
  agent: "intake",
  schema: RolePacket,
  system: (ctx) => [
    { text: COMPILE_SYSTEM, cache: true },
    { text: playbookBlock(ctx.playbook, ctx.playbookRole), cache: true },
    { text: companyBlock(ctx.company) },
    { text: ctx.benchmark ? `Compensation benchmark for ${ctx.benchmark.metro} (${ctx.benchmark.basis}): p25 ${ctx.benchmark.p25}, p50 ${ctx.benchmark.p50}, p75 ${ctx.benchmark.p75}. Source: ${ctx.benchmark.source}.` : "No compensation benchmark available." },
  ],
  messages: (ctx) => [
    {
      role: "user",
      content: `Established facts (JSON): ${JSON.stringify(ctx.facts)}\n\nConversation transcript:\n${ctx.messages.map((m) => `${m.role}: ${m.content}`).join("\n")}\n\nCompile the Role Packet now.`,
    },
  ],
};
