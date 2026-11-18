import { describe, expect, it } from "vitest";
import { VERTICAL_TO_PLAYBOOK } from "../../packages/playbooks/src/index";
import { MAX_LEVELS, MIN_LEVELS } from "../../packages/core/src/policy";
import { GUIDED_VERTICALS, VERTICALS, ZONE_CHOICES, snapTimeZone, verticalHint, zoneName } from "../../apps/web/src/company-setup";
import { LEVELS, allowedLevels } from "../../apps/web/src/policy-levels";

/**
 * The first screens' pure pieces (plan items 0.3, 0.4 and 0.10): the sign-up form's honest drafting hint and its time
 * zone, and Setup's allowed levels.
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

  // Live test, 12 November 2026: the owner's screens showed "America/Los_Angeles" where this form said "Pacific time (Los Angeles)".
  it("gives every zone it offers a name in its own words for the other screens, never the id", () => {
    for (const z of ZONE_CHOICES) {
      expect(zoneName(z.value), z.value).toBe(z.label);
      expect(zoneName(z.value, "short"), z.value).toMatch(/^[A-Z][a-z]+ time$/);
    }
    expect(zoneName("America/Los_Angeles")).toBe("Pacific time (Los Angeles)");
    expect(zoneName("America/Los_Angeles", "short")).toBe("Pacific time");
    expect(zoneName("America/Phoenix", "short")).toBe("Arizona time");
    // a zone the form does not offer reads as the browser names it, else as stored
    expect(zoneName("America/Detroit", "short")).not.toContain("/");
    expect(zoneName("Not/A_Zone")).toBe("Not/A_Zone");
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
