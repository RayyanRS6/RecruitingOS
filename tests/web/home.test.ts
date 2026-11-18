import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AI_HELP_UPGRADE_QUESTION, type HomeJob } from "../../packages/contracts/src/index";
import { KEEP_CURRENT, firstName, greeting, homeJobRow, noticeAsk } from "../../apps/web/src/home";
import { TRIAL_ASK } from "../../apps/web/src/trial";

/**
 * Home: it keeps itself current while it is in view (the app's default stays off for every other page), greets by
 * first name, and lists each open or paused job with the counts that lead into its candidates.
 */
const home = readFileSync(new URL("../../apps/web/src/pages/Home.tsx", import.meta.url), "utf8");
const providers = readFileSync(new URL("../../apps/shell/components/Providers.tsx", import.meta.url), "utf8");

describe("Home keeps itself current", () => {
  it("refreshes on focus and once a minute, only while the page is visible", () => {
    expect(KEEP_CURRENT).toEqual({ refetchOnWindowFocus: true, refetchInterval: 60_000, refetchIntervalInBackground: false });
  });

  it("applies to Home's one call, and the app's default stays off", () => {
    expect(home).toContain('useQuery({ queryKey: ["home"], queryFn: () => api.get<HomeView>("/api/v1/home"), ...KEEP_CURRENT })');
    expect(providers).toContain("refetchOnWindowFocus: false");
  });
});

describe("the greeting", () => {
  it("greets by first name, by the time of day", () => {
    expect(firstName("Sam Sample")).toBe("Sam");
    expect(firstName("  ")).toBeNull();
    expect(firstName(null)).toBeNull();
    expect(greeting(8, "Sam Sample")).toBe("Good morning, Sam");
    expect(greeting(12, "Sam Sample")).toBe("Good afternoon, Sam");
    expect(greeting(17, null)).toBe("Good afternoon");
    expect(greeting(18)).toBe("Good evening");
    expect(greeting(0)).toBe("Good morning");
  });
});

describe("a job on Home", () => {
  const job = (over: Partial<HomeJob> = {}): HomeJob => ({ id: "r1", title: "Dental Assistant", status: "open", statusLabel: "Open", toReview: 3, interviewed: 2, applicants: 9, ...over });

  it("opens its candidates, and each count opens the people it counts", () => {
    expect(homeJobRow(job())).toEqual({
      id: "r1",
      title: "Dental Assistant",
      href: "/roles/r1/talent",
      status: null,
      toReview: { text: "3 new to review", href: "/roles/r1/talent?tab=new" },
      interviewed: { text: "2 finished the AI interview", href: "/roles/r1/talent?tab=interviewed" },
      applicants: "9 applicants",
    });
  });

  it("shows a count only when there is someone to open, and says when nobody has applied", () => {
    const quiet = homeJobRow(job({ toReview: 0, interviewed: 0, applicants: 0 }));
    expect(quiet).toMatchObject({ toReview: null, interviewed: null, applicants: "No applicants yet" });
    expect(homeJobRow(job({ applicants: 1 })).applicants).toBe("1 applicant");
  });

  it("says a job's status only when it is paused, in the API's word", () => {
    expect(homeJobRow(job({ status: "paused", statusLabel: "Paused" })).status).toBe("Paused");
    expect(homeJobRow(job({ status: "open", statusLabel: "Open" })).status).toBeNull();
  });
});

describe("a notice's Upgrade", () => {
  it("says why it is asked: a plan after the trial, or more AI help", () => {
    expect(noticeAsk("trial_ending")).toBe(TRIAL_ASK);
    expect(noticeAsk("trial_ended")).toBe(TRIAL_ASK);
    expect(noticeAsk("ai_help_warning")).toBe(AI_HELP_UPGRADE_QUESTION);
    expect(noticeAsk("ai_help_used_up")).toBe(AI_HELP_UPGRADE_QUESTION);
  });
});
