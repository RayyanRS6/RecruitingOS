import { describe, expect, it } from "vitest";
import { FakeProvider, callPrompt, jobPostsPrompt, type AiRuntime, type JobPostsInput } from "@ros/ai";
import { screenCriterion } from "@ros/core";
import { registerFakeHandlers } from "./fake-handlers";

/**
 * The stand-in's two posts for a published job (job.posts v1): written the way the model is told to, from the facts in
 * the request only, each with the pay and its own Apply link.
 */
const fake = new FakeProvider();
registerFakeHandlers(fake);
const rt: AiRuntime = { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" } };

const JOB_URL = "https://jobs.example.test/careers/harbor-dental/jobs/11111111-1111-4111-8111-111111111111";
const input = (over: Partial<JobPostsInput> = {}): JobPostsInput => ({
  companyName: "Harbor Dental",
  title: "Registered Dental Hygienist",
  places: ["Tustin, CA"],
  workArrangement: "On site",
  employmentType: "Full time",
  schedule: "Monday to Friday",
  pay: "$45–$55 an hour",
  benefits: "Health cover",
  description: "Harbor Dental is hiring a Registered Dental Hygienist in Tustin, CA. This is an on-site job, full time, Monday to Friday. You will care for a full schedule of patients. You will chart every visit the same day.",
  mustHaves: ["Active CA RDH license.", "Periodontal charting"],
  applyLinks: { linkedin: `${JOB_URL}?src=linkedin`, indeed: `${JOB_URL}?src=indeed` },
  ...over,
});
const posts = async (over: Partial<JobPostsInput> = {}) => {
  const call = await callPrompt(rt, jobPostsPrompt, input(over), { companyId: null });
  if (call.result.kind !== "ok") throw new Error(`the stand-in did not answer: ${JSON.stringify(call.result)}`);
  return call.result.output;
};

describe("the stand-in's posts for a published job", () => {
  it("writes a short LinkedIn post: the job and the place, points, the pay with the schedule, and the LinkedIn link", async () => {
    const { linkedin } = await posts();
    expect(linkedin.split("\n")).toEqual([
      "We are hiring: Registered Dental Hygienist at Harbor Dental in Tustin, CA.",
      "- You will care for a full schedule of patients",
      "- You bring: Active CA RDH license",
      "- You bring: Periodontal charting",
      "$45–$55 an hour. Full time, Monday to Friday, On site",
      `Apply here: ${JOB_URL}?src=linkedin`,
    ]);
    expect(fake.calls.at(-1)).toMatchObject({ task: "job.posts", promptKey: "job.posts", promptVersion: 1 });
  });

  it("writes the Indeed listing under its five headings, with the benefits and the Indeed link", async () => {
    const { indeed } = await posts();
    expect(indeed.split("\n")).toEqual([
      "About the job",
      "Harbor Dental is hiring a Registered Dental Hygienist in Tustin, CA. This is an on-site job, full time, Monday to Friday.",
      "",
      "What you will do",
      "- You will care for a full schedule of patients",
      "- You will chart every visit the same day",
      "",
      "What you need",
      "- Active CA RDH license",
      "- Periodontal charting",
      "",
      "Pay and schedule",
      "Pay: $45–$55 an hour",
      "Full time, Monday to Friday, On site",
      "Benefits: Health cover",
      "",
      "How to apply",
      `Apply on our job page: ${JOB_URL}?src=indeed`,
    ]);
  });

  it("gives each post its own link and no other, states no pay or benefits it was not given, and names no place for a remote job", async () => {
    const both = await posts();
    expect(both.linkedin).not.toContain("src=indeed");
    expect(both.indeed).not.toContain("src=linkedin");
    for (const text of [both.linkedin, both.indeed]) expect(screenCriterion(text)).toBeNull();
    const bare = await posts({ pay: null, benefits: null, schedule: null, workArrangement: "Remote" });
    for (const text of [bare.linkedin, bare.indeed]) {
      expect(text).not.toMatch(/\$\d|Benefits:/);
      expect(text).toContain(JOB_URL);
    }
    expect(bare.linkedin.split("\n")[0]).toBe("We are hiring: Registered Dental Hygienist at Harbor Dental.");
    expect(bare.linkedin).toContain("\nFull time, Remote\n");
    expect(bare.indeed).toContain("Pay and schedule\nFull time, Remote\n");
  });
});
