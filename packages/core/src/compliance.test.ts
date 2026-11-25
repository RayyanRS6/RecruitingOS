import { describe, expect, it } from "vitest";
import { adverseDecisionLineApplies, beginsWithState, jobNoticesFor, regionFromLocationText, stateAlone, stateOfPlace } from "./compliance";

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
    for (const [place, state] of [["Austin TX", "TX"], ["Boulder CO 80302", "CO"], ["Kansas City MO", "MO"], ["Washington DC", "DC"], ["Brooklyn NY", "NY"]] as const) expect(stateOfPlace(place), place).toBe(state);
    // in small letters it is only a word ("come in", "that is ok"), and alone it is no place
    for (const place of ["austin tx", "anywhere is ok", "TX", "Remote US", "Remote USA"]) expect(stateOfPlace(place), place).toBeNull();
  });

  // A wrong state is worse than none: it puts another state's notices on the job and leaves the right ones off, and
  // nothing on the page shows the owner how the place was read. "LA" is Los Angeles as often as Louisiana, and "OK",
  // "OR", "IN", "ME" and "HI" are everyday words in capitals. Without a comma those six say no state; the builder asks.
  it("takes a code that is also a word, or a city's short name, only after a comma", () => {
    for (const place of ["Downtown LA", "East LA", "LA", "Remote OK", "Hybrid OK", "Portland OR", "Gary IN", "Bangor ME", "Honolulu HI", "Downtown LA 90012"]) expect(stateOfPlace(place), place).toBeNull();
    for (const [place, state] of [["Baton Rouge, LA", "LA"], ["New Orleans, LA 70112", "LA"], ["Tulsa, OK", "OK"], ["Portland, OR", "OR"], ["Gary, IN", "IN"], ["Bangor, ME", "ME"], ["Honolulu, HI", "HI"], ["tulsa, ok", "OK"]] as const) expect(stateOfPlace(place), place).toBe(state);
    // the full name is the state however the place is written, and every other code still reads as the last word
    for (const [place, state] of [["New Orleans Louisiana", "LA"], ["Tulsa Oklahoma", "OK"], ["Los Angeles, California", "CA"], ["Los Angeles CA", "CA"], ["Austin TX", "TX"]] as const) expect(stateOfPlace(place), place).toBe(state);
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
    for (const [text, state] of [["CO", "CO"], ["co", "CO"], ["Co.", "CO"], ["Colorado", "CO"], [" new york ", "NY"], ["West Virginia", "WV"], ["DC", "DC"], ["OK", "OK"], ["CA", "CA"]] as const) expect(stateAlone(text), text).toBe(state);
    for (const text of ["Denver", "Denver, CO", "US", "Colorado Springs", "ok then", "", null, undefined]) expect(stateAlone(text), String(text)).toBeNull();
  });

  // "LA" by itself is Los Angeles as often as Louisiana, so it is no state: the owner says which.
  it("is never 'LA' by itself, in any case, with or without a full stop; Louisiana by its name is", () => {
    for (const text of ["LA", "la", "La", "LA.", "la.", " LA "]) expect(stateAlone(text), text).toBeNull();
    expect(stateAlone("Louisiana")).toBe("LA");
    expect(stateAlone("louisiana.")).toBe("LA");
  });
});

describe("a state written after a city, in a person's own words", () => {
  it("is its code in any case or its name, and for a code that is also a word only after their own comma", () => {
    for (const [after, state] of [[", CO, on site", "CO"], [" co, on site", "CO"], [", Colorado", "CO"], [" Colorado 80302", "CO"], [", LA, on site", "LA"], [", ok", "OK"], [" Louisiana", "LA"], [", Oregon", "OR"]] as const) expect(beginsWithState(after, state), after).toBe(true);
    // "Downtown LA", "Remote OK", "Gary in the mornings": the word is no state
    for (const [after, state] of [[" LA, on site", "LA"], [" OK", "OK"], [" in the mornings", "IN"], [" or Salem", "OR"], [", on site", "CO"], [" Colorado Springs", "CA"], ["", "CO"]] as const) expect(beginsWithState(after, state), after).toBe(false);
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
