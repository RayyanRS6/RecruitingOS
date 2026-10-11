import { describe, expect, it } from "vitest";
import { barFigures, barTone } from "./score-bars";

describe("the match score's bars", () => {
  it("are green in full, amber when partly met, and red only for a must-have that is not met", () => {
    expect(barTone(100)).toBe("good");
    expect(barTone(100, true)).toBe("good");
    expect(barTone(50)).toBe("caution");
    expect(barTone(50, true)).toBe("caution");
    expect(barTone(0, true)).toBe("critical");
    // a skill that goes against them is not an alarm: grey, and the words say what it is
    expect(barTone(0)).toBe("neutral");
  });

  it("say how much was met and what it cost, in words beside the bar", () => {
    expect(barFigures(50, 6)).toEqual({ met: "50% met", lost: "6 points lost" });
    expect(barFigures(0, 1)).toEqual({ met: "0% met", lost: "1 point lost" });
    expect(barFigures(100, 0)).toEqual({ met: "100% met", lost: "full marks" });
    // a requirement that weighs very little can cost less than a point once rounded
    expect(barFigures(50, 0)).toEqual({ met: "50% met", lost: "under 1 point lost" });
  });

  it("keep the numbers inside 0-100 and whole", () => {
    expect(barFigures(130, -2)).toEqual({ met: "100% met", lost: "full marks" });
    expect(barFigures(49.6, 5.4).met).toBe("50% met");
    expect(barTone(Number.NaN)).toBe("neutral");
  });
});
