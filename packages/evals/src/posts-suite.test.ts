import { describe, expect, it } from "vitest";
import { FakeProvider, callPrompt, jobPostsPrompt } from "@ros/ai";
import { registerFakeHandlers } from "@ros/agents";
import type { IntakeModelCall } from "./intake-run";
import { POST_WORDS_MAX, applyLinksOf, postFailures, postsCaseResult, postsCases, type PostsCase } from "./posts-suite";

/**
 * job.posts: the LinkedIn post and the Indeed listing. Every case passes on the local stand-in, driven as the runner
 * would drive it, so the evaluations stay green without a model; and each check fails on a post that breaks the line of
 * the prompt it measures, so a run on the real models can fail where the Share tab rests on the prompt.
 */
function standIn() {
  const fake = new FakeProvider();
  registerFakeHandlers(fake);
  const rt = { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" } };
  const call: IntakeModelCall = async (prompt, input, meta) => {
    const { result, model } = await callPrompt(rt, prompt, input, { companyId: null, ...meta });
    if (result.kind === "ok") return { ok: true, output: result.output, runId: "run", model };
    return { ok: false, runId: "run", model, reason: result.kind === "refused" ? "refused" : "invalid", error: result.kind === "refused" ? result.reason : result.error };
  };
  return { fake, call, tasks: () => fake.calls.map((c) => c.task) };
}

const byId = (id: string): PostsCase => {
  const c = postsCases.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
};
const links = applyLinksOf();

describe("job.posts on the stand-in", () => {
  it("passes every case, with one call that writes both posts", async () => {
    expect(postsCases.map((c) => c.id)).toEqual(["hygienist_hourly_pay_shown", "marketing_director_salary_hybrid", "front_desk_no_pay_shown"]);
    // the pay as the job page writes it, and none where the page shows none
    expect(postsCases.map((c) => c.job.pay)).toEqual(["$45–$55 an hour", "$120,000–$140,000 a year", null]);
    for (const c of postsCases) {
      const s = standIn();
      expect(await postsCaseResult(s.call, c), c.id).toEqual({ id: c.id, pass: true, failures: [] });
      expect(s.tasks()).toEqual(["job.posts"]);
    }
  });

  it("gives the model the job's facts and the two Apply links, as the Share tab does", async () => {
    const s = standIn();
    const c = byId("hygienist_hourly_pay_shown");
    const r = await s.call(jobPostsPrompt, { ...c.job, applyLinks: links }, { inputRef: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output.linkedin).toContain("$45–$55 an hour");
    expect(r.output.linkedin).toContain(links.linkedin);
    expect(r.output.indeed).toContain(links.indeed);
    expect(r.output.indeed).not.toContain(links.linkedin);
  });

  it("says so when the posts were not written at all, and goes on", async () => {
    const s = standIn();
    s.fake.failNext("job.posts", "unusable");
    const out = await postsCaseResult(s.call, byId("hygienist_hourly_pay_shown"));
    expect(out.pass).toBe(false);
    expect(out.failures).toEqual(["the posts were not written: no valid output (unconstrained): the reply holds no JSON object"]);
  });
});

describe("job.posts: what a post fails on", () => {
  const paid = byId("hygienist_hourly_pay_shown");
  const unpaid = byId("front_desk_no_pay_shown");
  const good = `We are hiring: Registered Dental Hygienist at Harbor Dental in Tustin, CA.\n- You will care for a loyal patient base\n- You bring: Active CA RDH license\n$45–$55 an hour. Full time, Monday to Friday, On site\nApply here: ${links.linkedin}`;

  it("passes a post with its own link once, the pay as given, fair wording and a fitting length", () => {
    expect(postFailures("linkedin", good, paid)).toEqual([]);
    // a figure from the benefits line is no pay figure
    expect(postFailures("linkedin", `${good}\nBenefits: health cover and a $500 uniform allowance`, paid)).toEqual([]);
    // the pay written another way still shows both ends of it
    expect(postFailures("linkedin", good.replace("$45–$55 an hour", "Pay: $45.00 to $55.00 per hour"), paid)).toEqual([]);
  });

  it("fails a post without its Apply link, with it twice, or with another link", () => {
    expect(postFailures("linkedin", good.replace(`\nApply here: ${links.linkedin}`, ""), paid)).toEqual(["the LinkedIn post carries its Apply link nowhere; once expected"]);
    expect(postFailures("linkedin", `${good}\nOr apply here: ${links.linkedin}`, paid)).toEqual(["the LinkedIn post carries its Apply link 2 times; once expected"]);
    // the other post's link in this one: the count of applications by source would be wrong
    expect(postFailures("linkedin", good.replace(links.linkedin, links.indeed), paid)).toEqual(["the LinkedIn post carries its Apply link nowhere; once expected", `the LinkedIn post carries another link: ${links.indeed}`]);
    expect(postFailures("indeed", `${good.replace(links.linkedin, links.indeed)}\nMore about us: https://harbordental.example.test/about.`, paid)).toEqual(["the Indeed post carries another link: https://harbordental.example.test/about"]);
  });

  it("fails a post that leaves the pay out when the job page shows it, or states a figure that is not the job's", () => {
    expect(postFailures("linkedin", good.replace("$45–$55 an hour. ", ""), paid)).toEqual(["the LinkedIn post does not show the pay ($45–$55 an hour)"]);
    expect(postFailures("linkedin", good.replace("$45–$55 an hour", "From $45 an hour"), paid)).toEqual(["the LinkedIn post does not show the pay ($45–$55 an hour)"]);
    expect(postFailures("linkedin", good.replace("$45–$55 an hour", "$45–$55 an hour, up to $70 with bonuses"), paid)).toEqual(['the LinkedIn post has wording the fairness guard would take out: "$70" (pay_mismatch)']);
    // a job whose page shows no pay: the post states none
    const noPay = `We are hiring: Front Desk Coordinator at Harbor Dental in Austin, TX.\n- You bring: Two years at a dental front desk\nPart time, Tuesday to Saturday, On site\nApply here: ${links.linkedin}`;
    expect(postFailures("linkedin", noPay, unpaid)).toEqual([]);
    expect(postFailures("linkedin", noPay.replace("Part time", "$22 an hour, part time"), unpaid)).toEqual(['the LinkedIn post has wording the fairness guard would take out: "$22" (pay_mismatch)']);
  });

  it("fails a post with wording that stands in for a protected trait, as the guard would take it out of a job description", () => {
    expect(postFailures("linkedin", good.replace("- You bring: Active CA RDH license", "- Recent graduates welcome"), paid)).toEqual(['the LinkedIn post has wording the fairness guard would take out: "Recent graduates" (recent_graduate)']);
    expect(postFailures("linkedin", good.replace("- You bring: Active CA RDH license", "- Native English speaker"), paid)).toEqual(['the LinkedIn post has wording the fairness guard would take out: "Native English speaker" (language_origin)']);
  });

  it("fails a post that runs past its length", () => {
    const padded = (words: number) => `${good}\n${Array.from({ length: words }, () => "careful").join(" ")}`;
    const base = good.trim().split(/\s+/).length;
    expect(postFailures("linkedin", padded(POST_WORDS_MAX.linkedin - base), paid)).toEqual([]);
    expect(postFailures("linkedin", padded(POST_WORDS_MAX.linkedin - base + 1), paid)).toEqual([`the LinkedIn post has ${POST_WORDS_MAX.linkedin + 1} words; at most 130 expected`]);
    // the Indeed listing has more room
    const listing = good.replace(links.linkedin, links.indeed);
    expect(postFailures("indeed", `${listing}\n${Array.from({ length: 200 }, () => "careful").join(" ")}`, paid)).toEqual([]);
    expect(postFailures("indeed", `${listing}\n${Array.from({ length: 351 }, () => "careful").join(" ")}`, paid)).toEqual([expect.stringMatching(/^the Indeed post has \d+ words; at most 350 expected$/)]);
    expect(postFailures("indeed", `${listing}\n${"x".repeat(8001)}`, paid)).toEqual([expect.stringMatching(/^the Indeed post has \d+ characters; the Share tab keeps at most 8000$/)]);
  });
});
