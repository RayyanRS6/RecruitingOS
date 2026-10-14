import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GettingStartedStep } from "../../packages/contracts/src/domain/company";
import { HOME_ROWS, LINE_MAX, TODAY_REFRESH, cardLine, firstName, homeHeadline, homeJobs, homeRows, isFyi, homeJobFacts, moreLabel, nextStep, setupActionToast, splitActions } from "../../apps/web/src/today";

/**
 * Home, once called Today (plans B2 and B9; the simple, Kanvis-like Home of 14 October 2026): its cards and updates
 * refresh on focus and every minute while the page is visible, never in a hidden tab, while the app's default stays off
 * for every other page; the getting-started buttons say what they did; each card is one short row with the rest one
 * click away; and "Your jobs" lists the rail's jobs with their few facts, each opening where the rail's does.
 */
const home = readFileSync(new URL("../../apps/web/src/pages/Home.tsx", import.meta.url), "utf8");
const providers = readFileSync(new URL("../../apps/shell/components/Providers.tsx", import.meta.url), "utf8");

describe("Today keeps itself current", () => {
  it("refreshes on focus and once a minute, only while the page is visible", () => {
    expect(TODAY_REFRESH).toEqual({ refetchOnWindowFocus: true, refetchInterval: 60_000, refetchIntervalInBackground: false });
  });

  it("applies to the brief and to the updates on Today, and the app's default stays off", () => {
    expect(home).toMatch(/queryKey: \["brief"\], queryFn: \(\) => api\.get<Brief>\("\/api\/v1\/brief"\), \.\.\.TODAY_REFRESH \}/);
    expect(home).toMatch(/queryKey: \["notifications", "unread"\][^\n]*\.\.\.TODAY_REFRESH \}/);
    expect(providers).toContain("refetchOnWindowFocus: false");
  });
});

describe("the getting-started card's buttons", () => {
  const step = (key: GettingStartedStep["key"], done: boolean): GettingStartedStep => ({ key, title: key, why: "why", done, actions: [] });

  it("make the first step not done yet the one with the primary button", () => {
    expect(nextStep([step("company_details", true), step("team", false), step("ai_rules", false)])?.key).toBe("team");
    expect(nextStep([step("team", true)])).toBeUndefined();
  });

  it("say what they did in plain words", () => {
    expect(setupActionToast({ label: "Hide these steps", method: "POST", path: "/api/v1/companies/current/getting-started", body: { action: "dismiss" } })).toEqual({ title: "Steps hidden.", detail: "Only for you; the rest of your team still sees theirs." });
    expect(setupActionToast({ label: "I've reviewed them", method: "POST", path: "/api/v1/companies/current/getting-started", body: { action: "policies_reviewed" } }).title).toBe("Marked as reviewed.");
    expect(setupActionToast({ label: "Draft it with an ITS recruiter", method: "POST", path: "/api/v1/escalations", body: { kind: "ask", scope: "company" } }).title).toBe("Sent to ITS.");
    expect(setupActionToast({ label: "I've reviewed them", method: "POST", path: "/api/v1/companies/current/getting-started", body: { action: "policies_reviewed" } }).detail).toBe("You can change the AI rules in Settings at any time.");
  });
});

describe("Home's rows", () => {
  it("shows the first sentence and keeps the rest one click away", () => {
    expect(cardLine("Nothing has stopped. If they run out, applications are still accepted.")).toEqual({ line: "Nothing has stopped.", rest: "If they run out, applications are still accepted." });
    // a list of names with no full stop is its own line
    expect(cardLine("Maria Reyes (Ready for your review), Ben Ortiz (Being screened)")).toEqual({ line: "Maria Reyes (Ready for your review), Ben Ortiz (Being screened)", rest: "" });
    // the first paragraph only: a message under it stays behind the fold
    expect(cardLine("Dana wrote to Maria about Dental Hygienist:\n\nHi Maria, could you come in on Friday?")).toEqual({ line: "Dana wrote to Maria about Dental Hygienist:", rest: "Hi Maria, could you come in on Friday?" });
    // amounts and quotes do not end a sentence early
    expect(cardLine("Pay is $24.50 an hour. More later.").line).toBe("Pay is $24.50 an hour.");
    expect(cardLine("ITS wrote: \"Sign-in failed.\" Ask ITS again.").line).toBe("ITS wrote: \"Sign-in failed.\"");
    // a title's full stop does not end the sentence either
    expect(cardLine("3 people applied to Sr. Hygienist since yesterday. 2 need you.")).toEqual({ line: "3 people applied to Sr. Hygienist since yesterday.", rest: "2 need you." });
    expect(cardLine("Dr. Lee Dental confirmed the time. Nothing else to do.").line).toBe("Dr. Lee Dental confirmed the time.");
    expect(cardLine("Add a skill, e.g. Spanish, to the job. It helps.").line).toBe("Add a skill, e.g. Spanish, to the job.");
    expect(cardLine("")).toEqual({ line: "", rest: "" });
    expect(cardLine(null)).toEqual({ line: "", rest: "" });
  });

  it("cuts a long first sentence at a word and keeps the whole text behind the fold", () => {
    const long = `${"word ".repeat(40).trim()}. Second sentence.`;
    const { line, rest } = cardLine(long);
    expect(line.length).toBeLessThanOrEqual(LINE_MAX);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toMatch(/ …$/);
    expect(rest).toBe(long);
  });

  it("names what the fold opens: the message on a card asking to send one, else why", () => {
    expect(moreLabel({ kind: "decision", body: "Dana wrote to Maria:\n\nHello" })).toBe("Read the message");
    expect(moreLabel({ kind: "decision", body: "Next round, finalist, or not moving forward." })).toBe("Why");
    expect(moreLabel({ kind: "needs_review", body: "a\n\nb" })).toBe("Why");
  });

  it("keeps up to three buttons on a row, and past three the first two with the rest under More", () => {
    expect(splitActions([1, 2, 3])).toEqual({ shown: [1, 2, 3], more: [] });
    expect(splitActions([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2], more: [3, 4, 5] });
    expect(splitActions([])).toEqual({ shown: [], more: [] });
    expect(HOME_ROWS).toBe(5);
  });

  it("gives getting started its own card, shows the empty card only alone, and lists what needs a person first", () => {
    const cards = [{ kind: "getting_started" }, { kind: "escalation" }, { kind: "decision" }, { kind: "screening" }, { kind: "needs_review" }, { kind: "empty" }];
    const { setup, rows, empty } = homeRows(cards);
    expect(setup).toEqual({ kind: "getting_started" });
    expect(empty).toEqual({ kind: "empty" });
    expect(rows.map((r) => r.kind)).toEqual(["decision", "needs_review", "escalation", "screening"]);
    expect(isFyi("escalation") && isFyi("screening") && !isFyi("decision")).toBe(true);
    expect(homeRows([])).toEqual({ setup: null, rows: [], empty: null });
  });

  it("greets by first name and says in one line how many things need you", () => {
    expect(firstName("Dana Whitfield")).toBe("Dana");
    expect(firstName("  ")).toBeNull();
    expect(firstName(null)).toBeNull();
    expect(homeHeadline(0)).toBe("All caught up");
    expect(homeHeadline(0, { firstRun: true })).toBe("Start with your first hire");
    expect(homeHeadline(1)).toBe("1 thing needs you");
    expect(homeHeadline(3)).toBe("3 things need you");
  });
});

describe("Home's jobs", () => {
  const job = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id, title: `Job ${id}`, status, createdAt: "2026-10-01T00:00:00Z", openedAt: status === "draft" || status === "pending_approval" ? null : "2026-10-02T00:00:00Z", counts: { total: 0 }, needsYou: 0, ...over });

  it("lists the rail's jobs in its order, each opening on its Candidates once live and on the job before", () => {
    const list = homeJobs([job("d", "draft"), job("c", "closed"), job("o", "open", { counts: { total: 5, waiting_on_you: 2 }, stageCounts: { new: 3 } }), job("w", "pending_approval", { needsYou: 1 })], { role: "owner" });
    expect(list).toEqual([
      { id: "o", title: "Job o", status: "open", href: "/roles/o/talent", facts: "3 new · 2 to review" },
      { id: "w", title: "Job w", status: "pending_approval", href: "/roles/w", facts: "Not live yet · 1 decision waiting" },
      { id: "d", title: "Job d", status: "draft", href: "/roles/d", facts: "Not live yet" },
    ]);
  });

  it("says how many applied when nobody is new or waiting, or that nobody has yet", () => {
    expect(homeJobFacts(job("o", "open", { counts: { total: 4 }, stageCounts: { new: 0 } }), { role: "owner" })).toBe("4 applicants");
    expect(homeJobFacts(job("o", "open", { counts: { total: 1 } }), { role: "owner" })).toBe("1 applicant");
    expect(homeJobFacts(job("o", "open"), { role: "owner" })).toBe("No applicants yet");
    expect(homeJobFacts(job("p", "paused", { counts: { total: 2, waiting_on_you: 2 }, needsYou: 2 }), { role: "admin" })).toBe("2 to review · 2 decisions waiting");
  });

  it("never shows an interviewer counts, and opens every job of theirs on the job itself", () => {
    const [row] = homeJobs([job("o", "open", { counts: { total: 0 }, countsHidden: true })], { role: "interviewer" });
    expect(row).toEqual({ id: "o", title: "Job o", status: "open", href: "/roles/o", facts: "" });
    expect(homeJobFacts(job("o", "open", { counts: { total: 5 } }), { role: "interviewer" })).toBe("");
  });
});
