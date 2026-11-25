import { describe, expect, it } from "vitest";
import { adverseDecisionLineApplies, jobNoticesFor, regionFromLocationText, stateAlone, stateOfPlace } from "./compliance";

/**
 * The state of a job's place is read from the owner's own words and from nowhere else: since 25 November 2026 the AI is
 * no longer asked for it. The state is on the job page and decides which notices the page carries, so the reading never
 * guesses, and the job builder asks again when it finds none.
 */
describe("the state of a job's place, as its owner wrote it", () => {
  it("reads the two-letter code after a comma, in any case, with a ZIP code or the country after it", () => {
    for (const [place, state] of [["Tustin, CA", "CA"], ["Denver, CO", "CO"], ["denver, co", "CO"], ["St. Louis, MO.", "MO"], ["Irvine, CA 92618, USA", "CA"], ["Paris, TX", "TX"], ["Washington, DC", "DC"]] as const) expect(stateOfPlace(place), place).toBe(state);
    // the code after the last comma is the state, whatever the city is called
    for (const [place, state] of [["Kansas City, MO", "MO"], ["Indiana, PA", "PA"], ["Nevada, MO", "MO"], ["Nevada City, CA", "CA"], ["Colorado Springs, CO", "CO"]] as const) expect(stateOfPlace(place), place).toBe(state);
  });

  it("reads the code in capitals as the last word when no comma was typed, and only after another word", () => {
    for (const [place, state] of [["Austin TX", "TX"], ["Boulder CO 80302", "CO"], ["Kansas City MO", "MO"], ["Portland OR", "OR"], ["Washington DC", "DC"]] as const) expect(stateOfPlace(place), place).toBe(state);
    // in small letters it is only a word ("come in", "that is ok"), and alone it is no place
    for (const place of ["austin tx", "anywhere is ok", "TX", "Remote US", "Remote USA"]) expect(stateOfPlace(place), place).toBeNull();
  });

  it("reads a state's full name where it ends the place or stands after a comma", () => {
    for (const [place, state] of [
      ["New York", "NY"], ["Reno, Nevada", "NV"], ["Reno Nevada", "NV"], ["colorado", "CO"], ["Boulder, Colorado 80302", "CO"], ["Tustin, California, USA", "CA"], ["Reno, Nevada area", "NV"],
      ["Texas, remote", "TX"], ["Kansas City, Kansas", "KS"], ["Kansas City, Missouri", "MO"], ["New York, New York", "NY"], ["District of Columbia", "DC"],
    ] as const) expect(stateOfPlace(place), place).toBe(state);
  });

  // "Kansas City" is as often in Missouri as in Kansas, and "Nevada City" is in California. The model used to fill the
  // state in; nothing does now, so a name inside a longer place name must leave the question open, not answer it wrongly.
  it("never takes a state's name inside a longer place name for the state", () => {
    for (const place of ["Kansas City", "Nevada City", "Oklahoma City", "Virginia Beach", "New York City", "Colorado Springs", "Iowa City", "Jersey City", "Texas City", "Remote (Texas only)"]) expect(stateOfPlace(place), place).toBeNull();
    expect(stateOfPlace("Indiana, PA")).not.toBe("IN");
  });

  it("takes the last part that names a state, and the longest name in a part", () => {
    expect(stateOfPlace("West Virginia")).toBe("WV");
    expect(stateOfPlace("Charleston, West Virginia")).toBe("WV");
    expect(stateOfPlace("Indiana, Pennsylvania")).toBe("PA");
    expect(stateOfPlace("Little Rock, Arkansas")).toBe("AR");
    expect(stateOfPlace("Fargo, North Dakota")).toBe("ND");
  });

  it("finds none where the words say none", () => {
    for (const place of ["Denver", "Tustin", "somewhere nice", "Remote", "Anywhere in the US", "Downtown", "", "   "]) expect(stateOfPlace(place), place).toBeNull();
    expect(stateOfPlace(null)).toBeNull();
    expect(stateOfPlace(undefined)).toBeNull();
  });

  it("gives the job page the state's notice once the place says the state", () => {
    const notices = (place: string) => jobNoticesFor({ jobLocations: [{ city: "Denver", ...(stateOfPlace(place) ? { region: stateOfPlace(place)! } : {}), country: "US" }] }).map((n) => n.key);
    expect(notices("Denver, CO")).toEqual(["ai_use", "privacy", "pay_transparency", "adverse_decision_explanation"]);
    expect(notices("Denver")).toEqual(["ai_use", "privacy"]);
  });
});

describe("a state and nothing else", () => {
  it("is a code in any case or a full name", () => {
    for (const [text, state] of [["CO", "CO"], ["co", "CO"], ["Co.", "CO"], ["Colorado", "CO"], [" new york ", "NY"], ["West Virginia", "WV"], ["DC", "DC"]] as const) expect(stateAlone(text), text).toBe(state);
    for (const text of ["Denver", "Denver, CO", "US", "Colorado Springs", "ok then", "", null, undefined]) expect(stateAlone(text), String(text)).toBeNull();
  });
});

// The other reading, of a candidate's own location, decides whether a decision message carries Colorado's line. There
// reading one state too many only adds a line, and missing one drops a line the law asks for. It stays as it was.
describe("a candidate's own location keeps its wider reading", () => {
  it("still reads a state's name wherever it stands", () => {
    expect(regionFromLocationText("Colorado Springs")).toBe("CO");
    expect(regionFromLocationText("Boulder, Colorado 80302")).toBe("CO");
    expect(regionFromLocationText("Denver, CO")).toBe("CO");
    expect(regionFromLocationText("Charleston, West Virginia")).toBe("WV");
    expect(regionFromLocationText("somewhere nice")).toBeNull();
    expect(adverseDecisionLineApplies({ jobLocations: [{ city: "Irvine", region: "CA", country: "US" }], candidateLocationText: "Colorado Springs" })).toBe(true);
    expect(adverseDecisionLineApplies({ jobLocations: [{ city: "Irvine", region: "CA", country: "US" }], candidateLocationText: "Tustin, CA" })).toBe(false);
  });
});
