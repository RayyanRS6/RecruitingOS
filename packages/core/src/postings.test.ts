import { describe, expect, it } from "vitest";
import type { RolePacket } from "@ros/contracts";
import { BOARD_CHANNELS, POSTING_STATES, POSTING_TRANSITIONS, PostingTransitionError, assertPostingTransition, canTransitionPosting, isBoardChannel, payLine, postingPackage } from "./postings";
import { jobNoticesFor, payShown, payTransparencyApplies } from "./compliance";
import { LINK_TOKEN_LENGTH, SHARE_PLACES, SOURCES, SOURCE_LABEL, applyLinkUrl, isLinkPreviewBot, isLinkToken, newLinkToken, sourceForChannel } from "./application-links";
import { jobUrlsFor } from "./job-urls";

describe("posting state machine (docs/spec/20 item 11)", () => {
  it("names the nine states", () => {
    expect(POSTING_STATES).toEqual(["draft", "approved", "ready_to_post", "posted_manually", "submitted_integration", "live_verified", "paused", "failed", "closed"]);
    for (const s of POSTING_STATES) expect(Object.keys(POSTING_TRANSITIONS)).toContain(s);
  });

  it("allows every listed transition", () => {
    const allowed: Array<[string, string]> = [
      ["draft", "approved"], ["draft", "closed"],
      ["approved", "ready_to_post"], ["approved", "submitted_integration"], ["approved", "closed"],
      ["ready_to_post", "posted_manually"], ["ready_to_post", "submitted_integration"], ["ready_to_post", "paused"], ["ready_to_post", "failed"], ["ready_to_post", "closed"],
      ["posted_manually", "live_verified"], ["posted_manually", "failed"], ["posted_manually", "paused"], ["posted_manually", "closed"],
      ["submitted_integration", "live_verified"], ["submitted_integration", "failed"], ["submitted_integration", "paused"], ["submitted_integration", "closed"],
      ["live_verified", "posted_manually"], ["live_verified", "paused"], ["live_verified", "closed"], ["live_verified", "failed"],
      ["paused", "ready_to_post"], ["paused", "posted_manually"], ["paused", "live_verified"], ["paused", "closed"],
      ["failed", "ready_to_post"], ["failed", "posted_manually"], ["failed", "submitted_integration"], ["failed", "closed"],
    ];
    for (const [from, to] of allowed) {
      expect(canTransitionPosting(from, to), `${from} -> ${to}`).toBe(true);
      expect(() => assertPostingTransition(from, to)).not.toThrow();
    }
    // the table holds exactly these and nothing more
    const listed = Object.entries(POSTING_TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}>${to}`)).sort();
    expect(listed).toEqual(allowed.map(([f, t]) => `${f}>${t}`).sort());
  });

  it("refuses what the table does not list: nothing is live without a URL check, closed is terminal, unknown states never move", () => {
    expect(canTransitionPosting("ready_to_post", "live_verified")).toBe(false);
    expect(canTransitionPosting("closed", "ready_to_post")).toBe(false);
    expect(canTransitionPosting("draft", "live_verified")).toBe(false);
    expect(canTransitionPosting("pending", "ready_to_post")).toBe(false);
    expect(canTransitionPosting("ready_to_post", "ready_to_post")).toBe(false);
    expect(() => assertPostingTransition("ready_to_post", "live_verified")).toThrow(PostingTransitionError);
    try {
      assertPostingTransition("closed", "live_verified");
    } catch (e) {
      const err = e as PostingTransitionError;
      expect(err.from).toBe("closed");
      expect(err.to).toBe("live_verified");
      expect(err.message).toMatch(/Closed/);
      expect(err.message).toMatch(/Live and verified/);
    }
  });

  it("knows which channels are boards", () => {
    expect(BOARD_CHANNELS).toEqual(["linkedin_basic", "indeed", "ziprecruiter"]);
    expect(isBoardChannel("indeed")).toBe(true);
    expect(isBoardChannel("careers_page")).toBe(false);
    expect(isBoardChannel("google_jobs")).toBe(false);
    expect(isBoardChannel("email_in")).toBe(false);
  });
});

describe("tracked application links (items 7, 8 and 19)", () => {
  it("makes twelve lower-case letters and digits, different every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = newLinkToken();
      expect(t).toMatch(/^[a-z0-9]{12}$/);
      expect(t).toHaveLength(LINK_TOKEN_LENGTH);
      expect(isLinkToken(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(200);
    expect(isLinkToken("ABCDEFGHIJKL")).toBe(false);
    expect(isLinkToken("short")).toBe(false);
    expect(isLinkToken("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("maps channels to the source vocabulary", () => {
    // The share places (plan D8) have sources of their own, so "Applications by source" can tell a LinkedIn post from the LinkedIn board.
    expect(SOURCES).toEqual(["careers_page", "email_in", "linkedin", "indeed", "ziprecruiter", "referral", "school", "community", "shared_email", "shared_text", "whatsapp", "linkedin_post", "facebook", "x", "direct", "other"]);
    for (const s of SOURCES) expect(SOURCE_LABEL[s]).toBeTruthy();
    for (const p of Object.values(SHARE_PLACES)) expect(SOURCES).toContain(p.source);
    expect(sourceForChannel("linkedin_basic")).toBe("linkedin");
    expect(sourceForChannel("indeed")).toBe("indeed");
    expect(sourceForChannel("ziprecruiter")).toBe("ziprecruiter");
    expect(sourceForChannel("careers_page")).toBe("careers_page");
    expect(sourceForChannel("google_jobs")).toBe("careers_page");
    expect(sourceForChannel("email_in")).toBe("email_in");
    expect(sourceForChannel("something_else")).toBe("other");
  });

  it("tells link-preview fetchers and crawlers from people (plan D8): they are never counted as visits", () => {
    for (const bot of [
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Twitterbot/1.0",
      "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "WhatsApp/2.23.20.0 A",
      "TelegramBot (like TwitterBot)",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      "RecruitingOS-LinkCheck/1.0",
    ]) expect(isLinkPreviewBot(bot), bot).toBe(true);
    // no user agent at all (some privacy tools strip it) counts like a person
    expect(isLinkPreviewBot(undefined)).toBe(false);
    expect(isLinkPreviewBot("")).toBe(false);
    for (const person of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Linux; Android 13; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 LinkedInApp",
    ]) expect(isLinkPreviewBot(person), person).toBe(false);
  });

  it("builds every public URL from the jobs host, with no trailing slash doubled", () => {
    expect(applyLinkUrl("https://jobs.example.com/", "abc123def456")).toBe("https://jobs.example.com/a/abc123def456");
    expect(jobUrlsFor("https://jobs.example.com", { slug: "brightline", roleId: "r1" })).toEqual({ careers: "https://jobs.example.com/careers/brightline", job: "https://jobs.example.com/careers/brightline/jobs/r1", apply: "https://jobs.example.com/careers/brightline/jobs/r1/apply" });
  });
});

describe("posting package (item 9)", () => {
  const packet = {
    identity: { title: "Registered Dental Hygienist", locations: [{ city: "Irvine", region: "CA", country: "US" }, { city: "Tustin", region: "CA", country: "US" }], employmentType: "full_time", remotePolicy: "onsite", schedule: "Tuesday to Saturday" },
    compensation: { basis: "hourly", currency: "USD", min: 45, max: 55, ceiling: 58, discloseRange: true },
    description: { publicJobDescription: "Join a friendly practice in Irvine. You will provide preventive care and patient education." },
    screening: { questions: [{ key: "q1", question: "Do you hold an active RDH license in California?", kind: "eligibility" }, { key: "q2", question: "Tell us about your perio experience.", kind: "skills" }], maxMinutes: 15 },
  } as unknown as RolePacket;

  it("names the client as the employer and carries the board's tracked link, the intake address and the job page", () => {
    const pkg = postingPackage({ packet, companyName: "Brightline Dental Group", jobUrl: "https://jobs.example.com/careers/brightline/jobs/r1", applyUrl: "https://jobs.example.com/a/abc123def456", intakeAddress: "apply-x@intake.example.com", boardName: "Indeed" });
    expect(pkg.fields).toMatchObject({ title: "Registered Dental Hygienist", employer: "Brightline Dental Group", location: "Irvine, CA; Tustin, CA", employmentType: "Full time", pay: "$45–$55 an hour (hourly, USD)", applyUrl: "https://jobs.example.com/a/abc123def456", intakeAddress: "apply-x@intake.example.com", jobUrl: "https://jobs.example.com/careers/brightline/jobs/r1", schedule: "Tuesday to Saturday" });
    expect(pkg.fields.screeningQuestions).toBe("1. Do you hold an active RDH license in California?\n2. Tell us about your perio experience.");
    expect(pkg.text).toContain("Posting package for Indeed");
    expect(pkg.text).toContain("Employer: Brightline Dental Group");
    expect(pkg.text).toContain("Apply link (use this as the application method): https://jobs.example.com/a/abc123def456");
    expect(pkg.text).toContain("apply-x@intake.example.com");
    expect(pkg.text).toContain("Job page: https://jobs.example.com/careers/brightline/jobs/r1");
    expect(pkg.text).toContain(packet.description.publicJobDescription);
  });

  it("keeps an undisclosed pay range out of the package where no pay transparency law covers the job", () => {
    const hidden = { ...packet, identity: { ...packet.identity, locations: [{ city: "Austin", region: "TX", country: "US" }] }, compensation: { ...packet.compensation, discloseRange: false } } as RolePacket;
    const pkg = postingPackage({ packet: hidden, companyName: "Brightline Dental Group", jobUrl: "https://j/x", applyUrl: "https://j/a/t" });
    expect(pkg.fields.pay).toBe("Not disclosed publicly");
    expect(pkg.text).not.toContain("$45");
    expect(pkg.text).not.toContain("send applications instead");
    // the company's own location counts too, as on the job page
    expect(postingPackage({ packet: hidden, companyName: "Brightline Dental Group", jobUrl: "https://j/x", applyUrl: "https://j/a/t", companyLocations: [{ city: "Denver", region: "CO", country: "US" }] }).fields.pay).toBe("$45–$55 an hour (hourly, USD)");
  });

  it("states the range where a pay transparency law covers the job, whatever the packet says, the same rule as the job page", () => {
    const hidden = { ...packet, compensation: { ...packet.compensation, discloseRange: false } } as RolePacket;
    const pkg = postingPackage({ packet: hidden, companyName: "Brightline Dental Group", jobUrl: "https://j/x", applyUrl: "https://j/a/t" });
    expect(pkg.fields.pay).toBe("$45–$55 an hour (hourly, USD)");
    expect(payLine(hidden)).toBe(pkg.fields.pay);
    const notices = jobNoticesFor({ jobLocations: hidden.identity.locations });
    expect(payTransparencyApplies(notices)).toBe(true);
    expect(payShown(hidden.compensation, notices)).toBe(true);
    expect(payShown(hidden.compensation, jobNoticesFor({ jobLocations: [{ city: "Austin", region: "TX", country: "US" }] }))).toBe(false);
  });
});
