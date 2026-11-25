import type { FakeProvider, StructuredRequest } from "@ros/ai";
import { screenCriterion } from "@ros/core";
import { fakeResumeExtract, fakeScreenAssess, fakeScreenTurn, fakeTriageAssess } from "./fake-candidate";
import { fakeIntakeCompile, fakeIntakeExtract, fakeIntakeTurn, fakeJobPosts } from "./fake-job";

/**
 * Deterministic handlers for the fake AI provider. They exist so tests, evals, and local development run
 * without a model. They are heuristics, not intelligence, and the UI labels the provider as "fake".
 * Never used in production (the runtime refuses to boot with AI_PROVIDER=fake there).
 */
export function registerFakeHandlers(fake: FakeProvider): void {
  fake.register("intake.turn", fakeIntakeTurn);
  fake.register("intake.compile", fakeIntakeCompile);
  fake.register("intake.extract", fakeIntakeExtract);
  fake.register("job.posts", fakeJobPosts);
  fake.register("resume.extract", fakeResumeExtract);
  fake.register("triage.assess", fakeTriageAssess);
  fake.register("screen.turn", fakeScreenTurn);
  fake.register("screen.assess", fakeScreenAssess);
  fake.register("company.about", (req) => fakeCompanyAbout(req));
}

/**
 * company.about (D10): a few plain sentences built only from the facts in the request, the way the model is told to
 * write them, and nothing but the text, which is all it is asked for. A sentence from the company's notes is kept when it
 * reads as a fact about the company; one that stands in for a protected trait ("young, energetic team") is left out, and
 * so is one that tries to give instructions.
 */
function fakeCompanyAbout(req: StructuredRequest<unknown>): { text: string } {
  const text = req.messages.map((m) => m.content).join("\n");
  const fact = (label: string) => text.match(new RegExp(`^${label}: (.+?)\\.?$`, "m"))?.[1]?.trim() ?? "";
  const name = fact("Company") || "The company";
  const kind = fact("Kind of business") || "local";
  const places = fact("Places").split("; ").filter(Boolean);
  const jobs = fact("Jobs they hire for").split("; ").filter(Boolean);
  const notes = (text.match(/<notes>\n([\s\S]*?)\n<\/notes>/)?.[1] ?? "").trim();
  const where = places.length ? ` in ${places.length > 2 ? `${places.slice(0, 2).join(", ")} and other places` : places.join(" and ")}` : "";
  const sentences = [`${name} is a ${kind} business${where}.`];
  if (jobs.length) sentences.push(`The team hires for roles such as ${jobs.slice(0, 2).join(" and ").toLowerCase()}.`);
  // A note's sentence is kept only as a plain fact: no proxy wording, no instruction, no figure, nothing about pay or software.
  const own = (notes.match(/[^.!?]+[.!?]?/g) ?? []).map((s) => s.trim()).filter((s) => s.length >= 12 && !screenCriterion(s) && !/\b(?:ignore|instructions?|rules?|system|prompt)\b/i.test(s) && !/\byoung\b|\bfamily\b|\benergetic\b|\bdigital natives?\b/i.test(s) && !/[$\d]|\b(?:pay|salary|wages?|AI|software)\b/i.test(s));
  for (const s of own.slice(0, 2)) sentences.push(/[.!?]$/.test(s) ? s : `${s}.`);
  const size = fact("Size");
  if (sentences.length < 2 && size) sentences.push(`It is a team of ${size}.`);
  if (sentences.length < 2) sentences.push("Its open jobs are listed on its careers page.");
  return { text: sentences.join(" ") };
}
