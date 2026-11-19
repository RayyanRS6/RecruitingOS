import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AboutInput, UpdateCompany, type CompanyView, type PlanView, type TeamView } from "../../packages/contracts/src/index";
import {
  ABOUT_MAX, ABOUT_MIN, CONFIRM_FIRST_LINE, SIZE_BANDS, aboutProblem, afterLeaving, companyEdit, companyFormFrom, companyFormProblem, contactLine, defaultInviteRole, emailSwitchWords, invitationFacts,
  inviteToast, logoProblem, memberChangedWords, parseLocations, planLines, reauthLine, roleChangeQuestion, roleOptions,
} from "../../apps/web/src/settings";

/**
 * Settings: one page with four sections (Company, Team, Plan, Email updates). What a person may do with the team comes
 * with the team from the API; these lay it out, check the obvious before anything is sent, and send only what changed.
 */
const page = readFileSync(new URL("../../apps/web/src/pages/Settings.tsx", import.meta.url), "utf8");

const company: Pick<CompanyView, "name" | "website" | "timezone" | "sizeBand" | "locations" | "benefitsSummary"> = {
  name: "Bright Dental", website: "brightdental.example", timezone: "America/Los_Angeles", sizeBand: "1-19",
  locations: [{ city: "Irvine", region: "CA", country: "US", timezone: "America/Los_Angeles", postalCode: "92618" }, { city: "Tustin", region: "CA", country: "US" }],
  benefitsSummary: "Health, dental and paid time off",
};

describe("the page", () => {
  it("is one page with four sections in this order, each with the address other pages link to, and no tabs", () => {
    expect([...page.matchAll(/<Section id="([^"]+)"/g)].map((m) => m[1])).toEqual(["setup-company", "setup-team", "setup-plan", "setup-notifications"]);
    expect(page).toContain('<PageHeader title="Settings"');
    expect(page).not.toMatch(/<Tabs\b/);
  });

  it("says what came of confirming it's you, on the way back", () => {
    expect(reauthLine("ok")).toEqual({ tone: "info", text: "Thanks, that is confirmed. For the next few minutes you can make someone an admin or an owner." });
    expect(reauthLine("mismatch")?.tone).toBe("critical");
    expect(reauthLine("mismatch")?.text).toMatch(/a different account/);
    expect(reauthLine("failed")).toEqual({ tone: "critical", text: "The confirmation did not complete. Try again." });
    expect(reauthLine(null)).toBeNull();
    expect(reauthLine("anything-else")).toBeNull();
    expect(CONFIRM_FIRST_LINE).toMatch(/needs a recent sign-in/);
  });
});

describe("Company", () => {
  const form = companyFormFrom(company);

  it("opens the form on the company as it is, one place a line", () => {
    expect(form).toEqual({ name: "Bright Dental", website: "brightdental.example", timezone: "America/Los_Angeles", sizeBand: "1-19", locations: "Irvine, CA\nTustin, CA", benefits: "Health, dental and paid time off" });
    expect(companyFormFrom({ ...company, website: null, benefitsSummary: null })).toMatchObject({ website: "", benefits: "" });
    expect(SIZE_BANDS).toContain("1-19");
  });

  it("sends nothing when nothing changed, and only the details that did", () => {
    expect(companyEdit(company, form)).toEqual({});
    expect(companyEdit(company, { ...form, name: " Bright Dental Group " })).toEqual({ name: "Bright Dental Group" });
    expect(companyEdit(company, { ...form, website: "", benefits: "" })).toEqual({ website: "", benefitsSummary: "" });
    expect(companyEdit(company, { ...form, timezone: "America/Chicago", sizeBand: "20-49" })).toEqual({ timezone: "America/Chicago", sizeBand: "20-49" });
    // every edit is one the API takes
    for (const edit of [companyEdit(company, { ...form, website: "", benefits: "" }), companyEdit(company, { ...form, timezone: "America/Chicago", sizeBand: "20-49" })]) expect(UpdateCompany.safeParse(edit).success).toBe(true);
  });

  it("keeps a place that was not touched whole, and reads a new line as a city and a state", () => {
    const edit = companyEdit(company, { ...form, locations: "Irvine, CA\ncosta mesa, ca\n\n" });
    expect(edit).toEqual({ locations: [company.locations[0], { city: "costa mesa", region: "CA", country: "US" }] });
    expect(UpdateCompany.safeParse(edit).success).toBe(true);
    expect(parseLocations("Remote", [])).toEqual([{ city: "Remote", country: "US" }]);
    expect(parseLocations(" \n ", company.locations)).toEqual([]);
  });

  it("asks for a name and at least one location before anything is sent", () => {
    expect(companyFormProblem(form)).toBeNull();
    expect(companyFormProblem({ ...form, name: " B " })).toBe("Give the company a name.");
    expect(companyFormProblem({ ...form, locations: " \n" })).toBe("Keep at least one location, as City, ST.");
  });

  it("says who candidates write to: the company's own address, or the ITS inbox until it sets one", () => {
    expect(contactLine({ contactShown: { email: "jobs@brightdental.example", name: "Hiring team", kind: "company" } })).toBe("Hiring team, jobs@brightdental.example");
    expect(contactLine({ contactShown: { email: "jobs@brightdental.example", name: null, kind: "company" } })).toBe("jobs@brightdental.example");
    expect(contactLine({ contactShown: { email: "hiring@its.example", name: null, kind: "its" } })).toBe("hiring@its.example (the ITS inbox, until you set your own)");
  });

  it("takes a small picture for the logo, and says what is wrong with anything else", () => {
    expect(logoProblem({ type: "image/png", size: 200_000 })).toBeNull();
    expect(logoProblem({ type: "image/webp", size: 2 * 1024 * 1024 })).toBeNull();
    expect(logoProblem({ type: "image/svg+xml", size: 2000 })).toBe("Use a PNG, JPG or WebP picture.");
    expect(logoProblem({ type: "application/pdf", size: 2000 })).toBe("Use a PNG, JPG or WebP picture.");
    expect(logoProblem({ type: "image/jpeg", size: 2 * 1024 * 1024 + 1 })).toBe("That picture is larger than 2 MB. Use a smaller one.");
    expect(logoProblem({ type: "image/png", size: 0 })).toBe("That file is empty.");
  });

  it("holds the text about the company to the length the API takes", () => {
    expect([ABOUT_MIN, ABOUT_MAX]).toEqual([40, 1200]);
    expect(aboutProblem("Too short.")).toBe("Write a few sentences about the company (at least 40 characters).");
    expect(aboutProblem("x".repeat(1201))).toBe("Keep it under 1200 characters.");
    const fine = "A family dental practice in Irvine, open since 2009.";
    expect(aboutProblem(fine)).toBeNull();
    expect(AboutInput.safeParse({ text: fine }).success).toBe(true);
    expect(AboutInput.safeParse({ text: null }).success).toBe(true);
  });
});

describe("Team", () => {
  const viewer = (grantableRoles: TeamView["viewer"]["grantableRoles"]) => ({ grantableRoles });

  it("offers exactly the roles the API says the person may give, in the words on screen", () => {
    expect(roleOptions(viewer(["owner", "admin", "hiring_manager"]))).toEqual([{ value: "owner", label: "Owner" }, { value: "admin", label: "Admin" }, { value: "hiring_manager", label: "Member" }]);
    expect(roleOptions(viewer(["admin", "hiring_manager"])).map((r) => r.label)).toEqual(["Admin", "Member"]);
    // a member may give none: no role to choose, so no invite form
    expect(roleOptions(viewer([]))).toEqual([]);
    expect(defaultInviteRole(viewer([]))).toBeNull();
  });

  it("starts an invitation on Member", () => {
    expect(defaultInviteRole(viewer(["owner", "admin", "hiring_manager"]))).toBe("hiring_manager");
    expect(defaultInviteRole(viewer(["admin"]))).toBe("admin");
  });

  it("says where an open invitation stands: its role, until when its link works, and what became of its email", () => {
    const now = new Date(2026, 10, 18, 15, 0);
    const inv = { roleLabel: "Member", expiresAt: new Date(2026, 10, 25, 9, 0).toISOString(), emailState: "sent" as const };
    expect(invitationFacts(inv, now)).toEqual(["Member", "Link works until Nov 25", "Email sent"]);
    expect(invitationFacts({ ...inv, emailState: "failed" }, now).at(-1)).toBe("Email did not arrive");
    expect(invitationFacts({ ...inv, emailState: "on_its_way" }, now).at(-1)).toBe("Email on its way");
    expect(invitationFacts({ ...inv, emailState: null }, now)).toEqual(["Member", "Link works until Nov 25"]);
  });

  it("says after inviting whether the email is on its way, or that the link is theirs to send", () => {
    const invitation = { email: "new.person@example.com" };
    expect(inviteToast({ emailed: true, invitation })).toEqual({ title: "Invited.", detail: "The email to new.person@example.com is on its way." });
    expect(inviteToast({ emailed: false, invitation })).toEqual({ title: "Invited.", detail: "No email went out. Copy the link and send it yourself." });
  });

  it("asks before a role changes, and says what happened afterwards", () => {
    expect(roleChangeQuestion("Sam Sample", "admin")).toBe("Make Sam Sample an admin?");
    expect(roleChangeQuestion("Sam Sample", "owner")).toBe("Make Sam Sample an owner?");
    expect(roleChangeQuestion("Sam Sample", "hiring_manager")).toBe("Make Sam Sample a member?");
    expect(memberChangedWords({ role: "admin", status: "active" }, "Sam Sample")).toBe("Sam Sample is now an admin.");
    expect(memberChangedWords({ role: "hiring_manager", status: "removed" }, "Sam Sample")).toBe("Sam Sample is no longer on the team.");
  });

  it("after leaving, goes to the other company the person works in, or to sign in when there is none", () => {
    expect(afterLeaving({ movedTo: { companyId: "co2", companyName: "Harbor Clinic" }, signedOut: false })).toBe("/");
    expect(afterLeaving({ movedTo: null, signedOut: true })).toBe("/login");
    expect(afterLeaving({ movedTo: null, signedOut: false })).toBe("/login");
  });
});

describe("Plan", () => {
  const plan = (over: Partial<PlanView> = {}): Pick<PlanView, "name" | "usage" | "trial"> => ({
    name: "Basic",
    usage: [
      { key: "jobs_total" as never, label: "Jobs", used: 1, limit: 3, unit: "count", resetsAt: null, words: "1 of 3 jobs" },
      { key: "seats" as never, label: "People", used: 2, limit: 3, unit: "count", resetsAt: null, words: "2 of 3 people" },
      { key: "ai_credit" as never, label: "AI help", used: 40, limit: 100, unit: "percent", resetsAt: "2026-12-05T00:00:00.000Z", words: "AI help: 40% used" },
    ],
    trial: null,
    ...over,
  });

  it("shows the plan's name and one usage line, each limit in the server's words, AI help never in money", () => {
    const lines = planLines(plan());
    expect(lines).toEqual({ name: "Basic", trial: null, usage: "1 of 3 jobs · 2 of 3 people · AI help: 40% used" });
    expect(lines.usage).not.toMatch(/\$/);
  });

  it("says where a trial stands on the company's calendar", () => {
    const trial = { started: true, startedAt: "2026-11-01T19:00:00.000Z", endsAt: "2026-12-01T07:59:00.000Z", daysLeft: 12, endingSoon: false, ended: false, extendedDays: 0 };
    expect(planLines(plan({ name: "Trial", trial }), "America/Los_Angeles").trial).toBe("Trial until November 30");
    expect(planLines(plan({ name: "Trial", trial: { ...trial, ended: true } }), "America/Los_Angeles").trial).toBe("Trial ended on November 30");
  });
});

describe("Email updates", () => {
  it("says what the one switch did, and that the app still shows everything when emails are off", () => {
    expect(emailSwitchWords(true)).toEqual({ title: "Emails on.", detail: "Updates are emailed to you as they happen." });
    expect(emailSwitchWords(false)).toEqual({ title: "Emails off.", detail: "You still see every update in the app." });
  });
});
