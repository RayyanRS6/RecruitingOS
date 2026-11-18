import { describe, expect, it } from "vitest";
import { ZONE_CHOICES, snapTimeZone, zoneName } from "../../apps/web/src/company-setup";

/** The first screens' pure pieces: the time zone the sign-up form starts from, and how a zone is named on every other screen. */
describe("the sign-up form", () => {
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
