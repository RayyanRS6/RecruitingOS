import { z } from "zod";
import { MAX_SUGGESTED_MUST_HAVES, MAX_SUGGESTED_QUESTIONS, intakeSuggestPrompt, runPromptDetached, type IntakeSuggestInput, type IntakeSuggestions } from "@ros/ai";
import { screenCriterion } from "@ros/core";
import type { Container } from "../container";

/**
 * Suggestions for the quick start (Wave S3, G3): POST /api/v1/intake/suggestions. For a job our hiring guides do not
 * know, the assistant (intake.suggest, Haiku 5.5 at low effort) suggests must-have skills and yes/no questions from the
 * answers so far: the job title, the kind of job, the work model and place, and the least experience. Nothing about any
 * candidate goes in. Every line passes the fairness word check (screenCriterion, the same check every must-have and
 * deal-breaker passes) before it is returned, and one that fails is dropped without a word; so is anything too long or a
 * "question" that is not one. The run is logged in ai_runs like every other. A failed or slow run returns no
 * suggestions (`unavailable`), so the page simply keeps "add your own".
 */
export const IntakeSuggestRequest = z.object({
  title: z.string().trim().min(1).max(120),
  employmentType: z.string().trim().max(40).optional(),
  remotePolicy: z.string().trim().max(40).optional(),
  place: z.string().trim().max(200).optional(),
  /** "none", or the least years ("3"), as the quick start's experience step stores it. */
  experience: z.string().trim().max(10).optional(),
}).strict();
export type IntakeSuggestRequest = z.infer<typeof IntakeSuggestRequest>;

export type IntakeSuggestResponse = { mustHaves: string[]; questions: string[]; unavailable?: true };

/** A must-have is a few words; a longer line is a sentence the person would have to rewrite, so it is left out. */
const MUST_HAVE_MAX_CHARS = 100;
const QUESTION_MAX_CHARS = 200;
/** A yes/no question starts the way one does in English and ends with a question mark. */
const YES_NO = /^(?:do|does|did|are|is|was|were|have|has|had|can|could|will|would|should|may)\b[^?]*\?$/i;

/**
 * The call's time: the model gets about 20 seconds (the provider ends a call 30 seconds before the deadline it is given,
 * to leave the route time to answer). The page gives up a little later and shows nothing.
 */
const SUGGEST_DEADLINE_MS = 50_000;

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
const key = (s: string) => tidy(s).toLowerCase().replace(/[.!?]+$/, "");

/** What the model suggested, as the page may show it: short, fair, each once, at most eight and four. */
export function fairSuggestions(out: IntakeSuggestions): { mustHaves: string[]; questions: string[]; dropped: number } {
  let dropped = 0;
  const pick = (items: readonly string[], max: number, ok: (s: string) => boolean) => {
    const kept: string[] = [];
    for (const raw of items) {
      const s = tidy(raw).replace(/^(?:[-*•·]|\d{1,2}[.)])\s+/, "");
      if (!s || !ok(s) || screenCriterion(s)) {
        dropped += 1;
        continue;
      }
      if (kept.some((k) => key(k) === key(s))) continue;
      if (kept.length < max) kept.push(s);
    }
    return kept;
  };
  const mustHaves = pick(out.mustHaves, MAX_SUGGESTED_MUST_HAVES, (s) => s.length <= MUST_HAVE_MAX_CHARS && !s.includes("?"));
  const questions = pick(out.questions, MAX_SUGGESTED_QUESTIONS, (s) => s.length <= QUESTION_MAX_CHARS && YES_NO.test(s));
  return { mustHaves, questions, dropped };
}

/** The quick start's answers as the prompt reads them. */
export function suggestInput(body: IntakeSuggestRequest): IntakeSuggestInput {
  const years = body.experience === "none" ? 0 : body.experience && /^\d{1,2}$/.test(body.experience) ? Number(body.experience) : null;
  return {
    title: body.title,
    employmentType: body.employmentType || null,
    remotePolicy: body.remotePolicy || null,
    place: body.place || null,
    minYears: years,
  };
}

export async function suggestForQuickStart(container: Container, input: { companyId: string; userId: string; body: IntakeSuggestRequest }): Promise<IntakeSuggestResponse> {
  const out = await runPromptDetached(container.db, container.ai, intakeSuggestPrompt, suggestInput(input.body), {
    companyId: input.companyId,
    inputRef: { purpose: "quick_start", requestedBy: input.userId },
    maxTokens: 2000,
    deadlineAt: Date.now() + SUGGEST_DEADLINE_MS,
  });
  if (!out.ok) return { mustHaves: [], questions: [], unavailable: true };
  const { mustHaves, questions } = fairSuggestions(out.output);
  return { mustHaves, questions };
}
