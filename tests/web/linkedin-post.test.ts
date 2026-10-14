import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RolePacket } from "../../apps/web/src/api/client";
import {
  LINKEDIN_MAX, LINKEDIN_OPEN_URL, POST_TONES, linkedInPostHref, linkedInPostLink, linkedInPostText, postFactsOf, postLength, postLengthLine, previewParts, titleHashtag, withTrackedLink,
  type PostFacts,
} from "../../apps/web/src/linkedin-post";

/**
 * The LinkedIn post on the Share tab (Wave S2, slice K3): three tones of words made only from the job's own facts, the
 * same words every time (no AI), the pay only when the job page shows it, at most three must-haves, the job's own
 * LinkedIn link in place of the job page's address once it exists, and the character count LinkedIn goes by.
 */
const JOB = "https://jobs.test/c/bright/jobs/r1";
const LINK = "https://jobs.test/a/li";

const packet = (over: Partial<{ title: string; remote: "onsite" | "hybrid" | "remote"; type: string; discloseRange: boolean; mustHaves: string[]; places: Array<{ city?: string; region?: string }> }> = {}) =>
  ({
    identity: { title: over.title ?? "Dental hygienist", locations: over.places ?? [{ city: "Irvine", region: "CA" }], employmentType: over.type ?? "full_time", remotePolicy: over.remote ?? "onsite" },
    compensation: { basis: "hourly", min: 45, max: 55, ceiling: 58, discloseRange: over.discloseRange ?? true, sources: [], ownerStated: true },
    requirements: { mustHaves: (over.mustHaves ?? ["Active CA RDH license", "2+ years in a dental office", "Local anesthesia permit", "Dentrix"]).map((text, i) => ({ key: `m${i}`, text, rationale: "Why", evidencedBy: ["resume"] })), niceToHaves: [], eligibility: [] },
  }) as unknown as RolePacket;

const facts = (over: Partial<PostFacts> = {}): PostFacts => ({ ...postFactsOf({ title: "Dental hygienist", companyName: "Bright Dental", packet: packet(), payShown: true, url: JOB }), ...over });

describe("the post's facts", () => {
  it("come from the job itself: title, company, place, how it is worked, the kind of job, the pay and up to three must-haves", () => {
    expect(facts()).toEqual({
      title: "Dental hygienist", company: "Bright Dental", place: "Irvine, CA", workModel: "On site", employment: "Full time", pay: "$45–$55 an hour",
      mustHaves: ["Active CA RDH license", "2+ years in a dental office", "Local anesthesia permit"], url: JOB,
    });
  });

  it("leave the pay out when the job page does not show it, and fall back to the owner's choice on an older answer", () => {
    expect(postFactsOf({ title: "x", companyName: "Bright Dental", packet: packet(), payShown: false, url: JOB }).pay).toBeNull();
    expect(postFactsOf({ title: "x", companyName: "Bright Dental", packet: packet({ discloseRange: false }), url: JOB }).pay).toBeNull();
    // the law requires it even though the owner chose not to: the job page shows it, so the post does too
    expect(postFactsOf({ title: "x", companyName: "Bright Dental", packet: packet({ discloseRange: false }), payShown: true, url: JOB }).pay).toBe("$45–$55 an hour");
  });

  it("name a second place as 'and N more', say Remote and Hybrid in words, and keep only the title without a packet", () => {
    expect(postFactsOf({ title: "x", companyName: null, packet: packet({ places: [{ city: "Irvine", region: "CA" }, { city: "Tustin", region: "CA" }] }), url: JOB }).place).toBe("Irvine, CA and 1 more place");
    expect(postFactsOf({ title: "x", companyName: null, packet: packet({ remote: "remote", type: "part_time" }), url: JOB })).toMatchObject({ workModel: "Remote", employment: "Part time", company: null });
    expect(postFactsOf({ title: "x", companyName: null, packet: packet({ remote: "hybrid" }), url: JOB }).workModel).toBe("Hybrid");
    expect(postFactsOf({ title: "Office manager", companyName: "  ", packet: null, url: JOB })).toEqual({ title: "Office manager", company: null, place: null, workModel: null, employment: null, pay: null, mustHaves: [], url: JOB });
  });
});

describe("the three tones", () => {
  it("are offered as Proud, Straight and Friendly, each with a short line", () => {
    expect(POST_TONES.map((t) => t.label)).toEqual(["Proud", "Straight", "Friendly"]);
    for (const t of POST_TONES) expect(t.hint.split(" ").length).toBeLessThanOrEqual(6);
  });

  it("Proud: big news, the facts as short lines, what to bring, the link and the hashtags (never a claim the job's facts do not make)", () => {
    expect(linkedInPostText("proud", facts())).not.toMatch(/growing/);
    expect(linkedInPostText("proud", facts())).toBe([
      "Big news: Bright Dental is hiring.",
      "",
      "Job: Dental hygienist",
      "Where: Irvine, CA · On site",
      "Type: Full time",
      "Pay: $45–$55 an hour",
      "",
      "What you'll bring:",
      "• Active CA RDH license",
      "• 2+ years in a dental office",
      "• Local anesthesia permit",
      "",
      `We're proud of our team and can't wait to meet the next person to join it. Apply here: ${JOB}`,
      "",
      "#hiring #DentalHygienist",
    ].join("\n"));
  });

  it("Straight: just the facts", () => {
    expect(linkedInPostText("straight", facts())).toBe([
      "Bright Dental is hiring: Dental hygienist",
      "",
      "Irvine, CA · On site · Full time",
      "Pay: $45–$55 an hour",
      "",
      "Must-haves:",
      "• Active CA RDH license",
      "• 2+ years in a dental office",
      "• Local anesthesia permit",
      "",
      `Apply: ${JOB}`,
      "",
      "#hiring #DentalHygienist",
    ].join("\n"));
  });

  it("Friendly: asks people to pass it on", () => {
    const out = linkedInPostText("friendly", facts());
    expect(out.startsWith("Know someone who would love this job?")).toBe(true);
    expect(out).toContain("Bright Dental is looking for someone to join the team as Dental hygienist.\nWhere: Irvine, CA · On site\nType: Full time\nPay: $45–$55 an hour");
    expect(out).toContain("It helps if you have:\n• Active CA RDH license");
    expect(out).toContain(`Have a look and apply here: ${JOB}\nSharing this post helps too. Thank you!`);
  });

  it("leave out what is not known, with no empty lines or gaps, and speak as 'we' without a company name", () => {
    const bare = facts({ company: null, place: null, workModel: null, employment: null, pay: null, mustHaves: [] });
    expect(linkedInPostText("straight", bare)).toBe(`We're hiring: Dental hygienist\n\nApply: ${JOB}\n\n#hiring #DentalHygienist`);
    expect(linkedInPostText("proud", bare)).toBe(`Big news: we're hiring.\n\nJob: Dental hygienist\n\nWe're proud of our team and can't wait to meet the next person to join it. Apply here: ${JOB}\n\n#hiring #DentalHygienist`);
    expect(linkedInPostText("friendly", bare)).not.toMatch(/\n{3,}/);
    expect(linkedInPostText("friendly", bare)).toContain("We're looking for someone to join the team as Dental hygienist.");
  });

  it("are the same words every time for the same facts", () => {
    for (const t of POST_TONES) expect(linkedInPostText(t.key, facts())).toBe(linkedInPostText(t.key, facts()));
  });

  it("never put the pay in when the job page does not show it", () => {
    const hidden = postFactsOf({ title: "x", companyName: "Bright Dental", packet: packet(), payShown: false, url: JOB });
    for (const t of POST_TONES) expect(linkedInPostText(t.key, hidden)).not.toContain("$45");
  });
});

describe("the hashtag, the count and the link", () => {
  it("makes one hashtag from the title, keeping short capitals", () => {
    expect(titleHashtag("Dental hygienist")).toBe("#DentalHygienist");
    expect(titleHashtag("RN (night shift)")).toBe("#RNNightShift");
    expect(titleHashtag("Café manager")).toBe("#CafeManager");
    expect(titleHashtag("!!!")).toBe("");
    expect(titleHashtag("2026")).toBe("");
  });

  it("counts characters as LinkedIn does, and says how far over the limit a post is", () => {
    expect(LINKEDIN_MAX).toBe(3000);
    expect(postLength("héllo 👋")).toBe(7);
    expect(postLengthLine("a".repeat(1204))).toEqual({ line: "1,204 of 3,000 characters", over: false });
    expect(postLengthLine("a".repeat(3000)).over).toBe(false);
    expect(postLengthLine("a".repeat(3012))).toEqual({ line: "3,012 of 3,000 characters: 12 too many for LinkedIn.", over: true });
    // every tone, from a full job, fits with room to spare
    for (const t of POST_TONES) expect(postLength(linkedInPostText(t.key, facts()))).toBeLessThan(LINKEDIN_MAX / 3);
  });

  it("swaps the job page's address for the LinkedIn link wherever it is, and leaves other words alone", () => {
    expect(withTrackedLink(`Apply: ${JOB}\nAgain: ${JOB}`, JOB, LINK)).toBe(`Apply: ${LINK}\nAgain: ${LINK}`);
    expect(withTrackedLink("No address here.", JOB, LINK)).toBe("No address here.");
    expect(withTrackedLink(`Apply: ${JOB}`, JOB, JOB)).toBe(`Apply: ${JOB}`);
  });

  it("splits the preview into words and addresses", () => {
    expect(previewParts(`Apply: ${JOB}\nThanks`)).toEqual([{ text: "Apply: ", link: false }, { text: JOB, link: true }, { text: "\nThanks", link: false }]);
    expect(previewParts("Plain words")).toEqual([{ text: "Plain words", link: false }]);
  });

  it("opens the person's own LinkedIn feed with the new-post box, and the Share tab at the post", () => {
    expect(LINKEDIN_OPEN_URL).toBe("https://www.linkedin.com/feed/?shareActive=true");
    expect(linkedInPostHref("r 1")).toBe("/roles/r%201?tab=share#linkedin");
  });
});

describe("nothing from LinkedIn, nothing posted for anyone", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("loads no script and calls no LinkedIn API: the words are copied and linkedin.com opens without access back to our page", () => {
    const card = read("../../apps/web/src/components/LinkedInPost.tsx");
    expect(card).not.toMatch(/<script|<iframe|platform\.linkedin|api\.linkedin|ugcPosts|\/v2\//);
    expect(card).toContain("navigator.clipboard");
    expect(card).toContain("el.select();");
    expect(card).toContain("tab.opener = null;");
    // the only request it makes is our own tracked link for LinkedIn, the one the LinkedIn share button makes
    expect(card.match(/\bapi\.(get|post|put|patch|delete)\b/g)).toEqual(["api.get", "api.post"]);
    expect(card).toContain('/share-links`, { place: "linkedin" }');
    // and no AI: the words come from the templates
    expect(card).not.toMatch(/\/ai\/|assistant|draft/i);
  });

  it("sits on the Share tab at #linkedin, where the jobs list's 'Post on LinkedIn' lands", () => {
    expect(read("../../apps/web/src/pages/RolePosting.tsx")).toContain('<section id="linkedin" className="setup-section" tabIndex={-1}>');
  });
});

describe("when the Share tab offers the post (the public link's rule)", () => {
  const share = { jobUrl: JOB, places: [{ place: "linkedin" as const, label: "Shared on LinkedIn", link: { id: "l", url: LINK, visits: 0 } }] };
  const ready = { state: "ready" };

  it("only for a live job whose company ITS has confirmed", () => {
    expect(linkedInPostLink({ roleStatus: "open", check: "confirmed", publishing: ready, share, jobUrl: JOB })).toEqual({ jobUrl: JOB, linkUrl: LINK });
    // while the company is still loading, as for the public link
    expect(linkedInPostLink({ roleStatus: "open", check: "unknown", publishing: ready, share, jobUrl: JOB })).not.toBeNull();
    expect(linkedInPostLink({ roleStatus: "open", check: "waiting", publishing: ready, share, jobUrl: JOB })).toBeNull();
    expect(linkedInPostLink({ roleStatus: "open", check: "confirmed", publishing: { state: "waiting_for_company_check" }, share, jobUrl: JOB })).toBeNull();
    for (const status of ["draft", "pending_approval", "paused", "closed"]) expect(linkedInPostLink({ roleStatus: status, check: "confirmed", publishing: ready, share, jobUrl: JOB })).toBeNull();
  });

  it("uses the job page's address until the job has a LinkedIn link of its own", () => {
    expect(linkedInPostLink({ roleStatus: "open", check: "confirmed", publishing: ready, share: { jobUrl: JOB, places: [] }, jobUrl: JOB })).toEqual({ jobUrl: JOB, linkUrl: null });
    expect(linkedInPostLink({ roleStatus: "open", check: "confirmed", publishing: ready, share: null, jobUrl: JOB })).toEqual({ jobUrl: JOB, linkUrl: null });
    expect(linkedInPostLink({ roleStatus: "open", check: "confirmed", publishing: ready, share: null, jobUrl: "" })).toBeNull();
  });
});
