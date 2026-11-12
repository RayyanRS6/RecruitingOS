import { describe, expect, it } from "vitest";
import { mustHaveOf } from "./intake";

/**
 * A deal-breaker as the must-have it rules people out on (live test, 12 November 2026: "No active California RDA
 * license" became a must-have in those very words). Only clear shapes are turned round; anything else stays as written,
 * so the fairness check still reads the owner's own words.
 */
describe("a deal-breaker as the must-have it counts as", () => {
  it("turns round a missing licence, certificate or permit, and what someone cannot or will not do", () => {
    expect(mustHaveOf("No active California RDA license")).toBe("Active California RDA license");
    expect(mustHaveOf("no current BLS certification")).toBe("Current BLS certification");
    expect(mustHaveOf("Does not have an X-ray permit")).toBe("X-ray permit");
    expect(mustHaveOf("Without a valid driver's licence")).toBe("Valid driver's licence");
    expect(mustHaveOf("Cannot work Saturdays")).toBe("Able to work Saturdays");
    expect(mustHaveOf("Can't lift 50 pounds")).toBe("Able to lift 50 pounds");
    expect(mustHaveOf("Unable to start within two weeks")).toBe("Able to start within two weeks");
    expect(mustHaveOf("Not licensed in California")).toBe("Licensed in California");
    expect(mustHaveOf("not available on weekends")).toBe("Available on weekends");
    expect(mustHaveOf("Won't work weekends")).toBe("Willing to work weekends");
    expect(mustHaveOf("  No   active  CA RDH license ")).toBe("Active CA RDH license");
  });

  it("keeps everything else as written, so a proxy is still refused in the owner's own words", () => {
    for (const same of ["Must work Saturdays", "No recent grads", "No felons", "Smokers", "No kids", "No RDA", "Active CA RDH license"]) expect(mustHaveOf(same), same).toBe(same);
  });
});
