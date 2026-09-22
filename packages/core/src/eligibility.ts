import type { EligibilityResult, EligibilityRule } from "@ros/contracts";

/**
 * Deterministic evaluation of owner-authored eligibility rules against the candidate's own answers.
 * No model is involved: the only automatic hold in the system is a rule the owner wrote, evaluated
 * against what the candidate said. Anything the candidate did not answer is "unverifiable", never a fail.
 */
export function evaluateEligibility(rules: EligibilityRule[], answers: Record<string, unknown>, now = new Date()): EligibilityResult {
  const failed: EligibilityResult["failedRules"] = [];
  const unverifiable: EligibilityResult["unverifiable"] = [];

  for (const rule of rules) {
    if (!rule.knockout) continue;
    const answer = answers[rule.key];
    if (answer === undefined || answer === null || answer === "") {
      unverifiable.push({ key: rule.key, question: rule.question, reason: "not answered" });
      continue;
    }
    const verdict = evaluateRule(rule, answer, now);
    if (verdict.ok === false) failed.push({ key: rule.key, question: rule.question, answer, reason: verdict.reason });
    if (verdict.ok === "unknown") unverifiable.push({ key: rule.key, question: rule.question, reason: verdict.reason });
  }
  return { evaluatedAt: now.toISOString(), passed: failed.length === 0, failedRules: failed, unverifiable };
}

type Verdict = { ok: true } | { ok: false; reason: string } | { ok: "unknown"; reason: string };

function truthy(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["yes", "y", "true", "1"].includes(s)) return true;
    if (["no", "n", "false", "0"].includes(s)) return false;
  }
  return null;
}

function evaluateRule(rule: EligibilityRule, answer: unknown, now: Date): Verdict {
  const exp = rule.expectation as Record<string, unknown>;
  switch (rule.type) {
    case "license":
    case "certification":
    case "work_authorization":
    case "physical_requirement_bona_fide":
    case "minimum_age_legal": {
      const t = truthy(answer);
      if (t === null) return { ok: "unknown", reason: "answer not yes/no" };
      return t ? { ok: true } : { ok: false, reason: `answered no to: ${rule.question}` };
    }
    case "schedule_availability": {
      const required = (exp.days as string[] | undefined) ?? [];
      if (required.length === 0) {
        const t = truthy(answer);
        if (t === null) return { ok: "unknown", reason: "answer not yes/no" };
        return t ? { ok: true } : { ok: false, reason: "not available for the required schedule" };
      }
      const given = Array.isArray(answer) ? (answer as string[]).map((d) => d.toLowerCase()) : String(answer).toLowerCase().split(/[,\s]+/);
      const missing = required.filter((d) => !given.includes(String(d).toLowerCase()));
      return missing.length === 0 ? { ok: true } : { ok: false, reason: `not available: ${missing.join(", ")}` };
    }
    case "start_date": {
      const withinDays = Number(exp.withinDays ?? 0);
      const t = truthy(answer);
      if (t !== null) return t ? { ok: true } : { ok: false, reason: `cannot start within ${withinDays} days` };
      const d = Date.parse(String(answer));
      if (Number.isNaN(d)) return { ok: "unknown", reason: "start date not parseable" };
      const limit = now.getTime() + withinDays * 86_400_000;
      return d <= limit ? { ok: true } : { ok: false, reason: `earliest start ${String(answer)} is after ${withinDays} days` };
    }
    case "location_radius": {
      // We never geocode candidates automatically; the candidate answers whether they can commute.
      const t = truthy(answer);
      if (t === null) return { ok: "unknown", reason: "answer not yes/no" };
      return t ? { ok: true } : { ok: false, reason: "cannot work at the required location" };
    }
    default:
      return { ok: "unknown", reason: "unsupported rule type" };
  }
}
