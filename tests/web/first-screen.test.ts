import { describe, expect, it } from "vitest";
import { VERTICAL_TO_PLAYBOOK } from "../../packages/playbooks/src/index";
import { MAX_LEVELS, MIN_LEVELS } from "../../packages/core/src/policy";
import { GUIDED_VERTICALS, VERTICALS, ZONE_CHOICES, snapTimeZone, verticalHint } from "../../apps/web/src/company-setup";
import { LEVELS, allowedLevels } from "../../apps/web/src/policy-levels";
import { ACCESS_LIMITS, accessChip, accessWords, requestSentText, scopeOf } from "../../apps/web/src/recruiter-access";
import { can } from "../../packages/core/src/permissions";

/**
 * The first screens' pure pieces (plan items 0.3, 0.4 and 0.10): the sign-up form's honest drafting hint and its time
 * zone, Setup's allowed levels, and the words every screen uses for a recruiter's access.
 */
describe("the sign-up form", () => {
  it("says a business type has a hiring guide exactly when a playbook serves it", () => {
    for (const [key] of VERTICALS) expect(GUIDED_VERTICALS.has(key), key).toBe(key in VERTICAL_TO_PLAYBOOK);
    expect(verticalHint("dental")).toMatch(/hiring guide for this kind of business/);
    expect(verticalHint("veterinary")).toMatch(/do not have a hiring guide/);
    expect(verticalHint("")).not.toMatch(/guide/);
  });

  it("starts from the owner's own time zone, snapped to the ones offered, and never guesses Los Angeles", () => {
    const winter = new Date("2026-01-15T18:00:00Z");
    expect(snapTimeZone("America/Chicago", winter)).toBe("America/Chicago");
    expect(snapTimeZone("America/Detroit", winter)).toBe("America/New_York");
    expect(snapTimeZone("America/Boise", winter)).toBe("America/Denver");
    // Arizona keeps one clock all year: it is Phoenix, not Denver
    expect(snapTimeZone("America/Phoenix", winter)).toBe("America/Phoenix");
    expect(snapTimeZone("Europe/Paris", winter)).toBe("");
    expect(snapTimeZone("Not/A_Zone", winter)).toBe("");
    expect(snapTimeZone(undefined, winter)).toBe("");
    for (const z of ZONE_CHOICES) expect(() => new Intl.DateTimeFormat("en-US", { timeZone: z.value })).not.toThrow();
  });
});

describe("Setup's rule choices", () => {
  it("offer only the levels between each action's floor and ceiling", () => {
    expect(allowedLevels({ locked: true }).map((l) => l.value)).toEqual(["human_only"]);
    expect(allowedLevels({ locked: false, minLevel: MIN_LEVELS["role_packet.approve"], maxLevel: MAX_LEVELS["role_packet.approve"] }).map((l) => l.value)).toEqual(["approval"]);
    expect(allowedLevels({ locked: false, minLevel: MIN_LEVELS["offer.send"], maxLevel: null }).map((l) => l.value)).toEqual(["approval", "human_only"]);
    expect(allowedLevels({ locked: false }).map((l) => l.value)).toEqual(LEVELS.map((l) => l.value));
  });
});

describe("the words for a recruiter's access", () => {
  it("name what the recruiter will see, never more", () => {
    expect(accessWords(scopeOf({ roleId: "r", applicationId: "a" }))).toBe("this candidate and the role they applied for");
    expect(accessWords(scopeOf({ roleId: "r" }))).toBe("this role and its candidates");
    expect(accessWords(scopeOf({}))).toMatch(/^all of your hiring/);
    expect(accessChip({ roleId: null, roleTitle: null, applicationId: null })).toBe("all of your hiring");
    expect(accessChip({ roleId: "r", roleTitle: "Hygienist", applicationId: null })).toBe("role: Hygienist");
    expect(accessChip({ roleId: "r", roleTitle: "Hygienist", applicationId: "a" })).toBe("one candidate");
  });

  it("say who can end the access, since hiring managers and HR may ask but only owners and admins can end it", () => {
    expect(ACCESS_LIMITS).toContain("An owner or admin can end it sooner in Settings");
    expect(ACCESS_LIMITS).not.toMatch(/You can end it/);
    expect(can("hiring_manager", "escalation.create") && !can("hiring_manager", "staff_access.revoke")).toBe(true);
    expect(can("hr", "escalation.create") && !can("hr", "staff_access.revoke")).toBe(true);
  });

  it("after a one-click request, Today shows the API's own words about the access, not a bare 'sent'", () => {
    const message = "A recruiter will respond by Monday 9:00 AM (business hours are ...). They will see this role and its candidates. Their access starts when they pick the request up.";
    expect(requestSentText({ id: "e1", scope: "role", message })).toBe(message);
    expect(requestSentText({ id: "e1" })).toBe("Sent to a recruiter.");
    expect(requestSentText(null)).toBe("Sent to a recruiter.");
    expect(requestSentText({ message: "  " })).toBe("Sent to a recruiter.");
  });
});
