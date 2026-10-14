import { describe, expect, it } from "vitest";
import { PLACEHOLDER, hasPlaceholder, restoreQuotes, scoringView, withoutPlaceholders } from "./scoring-view";

/**
 * What the AI sees when it scores (founder decision D-04 = C): the candidate's name, email, phone, street address and
 * links are hidden; everything the job is judged on stays (city and state, employers, dates, schools, licences, skills).
 */
const DANA = { firstName: "Dana", lastName: "Kim", email: "dana.kim@example.com", phone: "(415) 555-0134" };
const RESUME = [
  "DANA KIM, RDH",
  "1420 Ocean View Ave, Apt 3B, San Francisco, CA 94110",
  "dana.kim@example.com | 415.555.0134 | linkedin.com/in/dana-kim-rdh | https://danakim.dev/portfolio",
  "Registered Dental Hygienist at Harbor Dental, Oakland, CA 2019 - present",
  "Hygienist at Bayside Dental 2016 - 2019",
  "RDH license CA #12345678, active through 2027",
  "BS Dental Hygiene, University of the Pacific, 2016",
  "Dana Kim was named Hygienist of the Year by Harbor Dental in 2022. Kim also trains new hires.",
].join("\n");

describe("the scoring view", () => {
  it("hides the name, email, phone, street address, zip code and links, wherever they are in the text", () => {
    const view = scoringView(DANA);
    const out = view.text(RESUME);
    for (const hidden of ["Dana", "DANA", "Kim", "KIM", "dana.kim@example.com", "415", "555-0134", "1420 Ocean View", "94110", "linkedin.com", "danakim.dev"]) expect(out, hidden).not.toContain(hidden);
    expect(out).toContain("[name], RDH");
    expect(out).toContain("[street address], San Francisco, CA [zip code]");
    expect(out).toContain("[email] | [phone] | [link] | [link]");
    expect(out).toContain("[name] was named Hygienist of the Year by Harbor Dental in 2022. [name] also trains new hires.");
    expect(view.counts()).toEqual({ name: 3, email: 1, phone: 1, street: 2, link: 2 });
  });

  it("keeps what the job is judged on: city and state, employers, dates, schools, licences and skills", () => {
    const out = scoringView(DANA).text(RESUME);
    for (const kept of ["San Francisco, CA", "Registered Dental Hygienist at Harbor Dental, Oakland, CA 2019 - present", "Hygienist at Bayside Dental 2016 - 2019", "RDH license CA #12345678, active through 2027", "BS Dental Hygiene, University of the Pacific, 2016"]) expect(out, kept).toContain(kept);
  });

  it("finds phone numbers in their usual forms, and never takes dates or years for one", () => {
    const view = scoringView({});
    for (const phone of ["(415) 555-0134", "415-555-0134", "415.555.0134", "415 555 0134", "+1 415 555 0134", "+44 20 7946 0958", "4155550134"]) expect(view.text(`Call ${phone} today`), phone).toBe("Call [phone] today");
    for (const kept of ["2016 - 2019", "2019-2021", "2020-01-15", "2015 2016 2017 2018 2019", "$45,000 - $55,000", "worked 40 hours a week"]) expect(view.text(kept), kept).toBe(kept);
  });

  it("hides links with or without a scheme, and leaves the sentence's own punctuation", () => {
    const view = scoringView({});
    expect(view.text("See https://example.org/me. Or www.example.com, or github.com/dk.")).toBe("See [link]. Or [link], or [link].");
    expect(view.text("Profile: linkedin.com")).toBe("Profile: [link]");
    // an employer named by its web address without a path stays
    expect(view.text("Worked at Amazon.com for two years")).toBe("Worked at Amazon.com for two years");
  });

  it("hides any email address and the candidate's own phone however it is written", () => {
    expect(scoringView({}).text("Write to someone.else+jobs@mail.example.co.uk.")).toBe("Write to [email].");
    expect(scoringView({ phone: "+1 415 555 0134" }).text("cell: 415 5550134")).toBe("cell: [phone]");
  });

  it("hides a street line and a PO box, and keeps a city and state on their own", () => {
    const view = scoringView({});
    expect(view.text("Lives at 12 N Main St., Fresno, CA 93721")).toBe("Lives at [street address], Fresno, CA [zip code]");
    expect(view.text("PO Box 123, Reno, NV")).toBe("[street address], Reno, NV");
    expect(view.text("Fresno, CA")).toBe("Fresno, CA");
    expect(view.text("I see 9 patients a day")).toBe("I see 9 patients a day");
  });

  it("hides a single name only as a name is written, so ordinary words stay", () => {
    const view = scoringView({ firstName: "Will", lastName: "Mason" });
    expect(view.text("Will Mason. I will relocate; Will is happy to. WILL MASON")).toBe("[name]. I will relocate; [name] is happy to. [name]");
    // particles are hidden only inside the full name
    expect(scoringView({ firstName: "Ana", lastName: "de la Cruz" }).text("Ana de la Cruz worked de facto as lead")).toBe("[name] worked de facto as lead");
    // the name the résumé reading found counts too, and names with accents are whole words
    expect(scoringView({ fullName: "José Núñez" }).text("José Núñez, then NÚÑEZ alone; Joséphine stays")).toBe("[name], then [name] alone; Joséphine stays");
  });

  it("hides inside answers and extractions without touching keys or other values", () => {
    const view = scoringView(DANA);
    expect(view.deep({ el_auth: "yes", note: "Dana can start Monday", years: 4, list: ["dana.kim@example.com"] })).toEqual({ el_auth: "yes", note: "[name] can start Monday", years: 4, list: ["[email]"] });
  });

  it("gives twins that differ only in those details the same text", () => {
    const twin = (who: { firstName: string; lastName: string; email: string; phone: string }, street: string, link: string) =>
      scoringView(who).text(`${who.firstName} ${who.lastName}\n${street}, Irvine, CA 92618\n${who.email} ${who.phone} ${link}\nRDH at Harbor Dental 2019 - present\n${who.firstName} led the perio program.`);
    const a = twin({ firstName: "Emily", lastName: "Walsh", email: "emily.walsh@example.com", phone: "949-555-0101" }, "18 Birch Lane", "linkedin.com/in/ewalsh");
    const b = twin({ firstName: "Lakisha", lastName: "Washington", email: "lakisha.w@example.net", phone: "(949) 555-0199" }, "4400 Jamboree Rd", "https://lakisha.dev/");
    expect(a).toBe(b);
  });

  it("gives a candidate whose name is also a job word, a city or a language the same evidence as a twin", () => {
    const body = (city: string) => `Line Cook, Joe's Diner, ${city}, TX 78701, 2019 - present\nPrep Cook at Taco Town 2017 - 2019\nLanguages: English, Spanish\nMoved to Austin in 2016.`;
    const resume = (first: string, last: string) => `${first} ${last}\n${first.toLowerCase()}.${last.toLowerCase()}@example.com\n${body("Austin")}`;
    // the job's own words (scoring-view's keep list), as triage.ts jobWords passes them from the job and the résumé
    const keep = ["Line Cook", "Austin TX", "English"];
    const austin = scoringView({ firstName: "Austin", lastName: "Cook", keep }).text(resume("Austin", "Cook"));
    const grace = scoringView({ firstName: "Grace", lastName: "English", keep }).text(resume("Grace", "English"));
    const twin = scoringView({ firstName: "Jamie", lastName: "Lee", keep }).text(resume("Jamie", "Lee"));
    // identical apart from nothing: the header's full name and email are hidden for each, the rest is the same
    expect(austin).toBe(twin);
    expect(grace).toBe(twin);
    expect(austin).toContain("Line Cook, Joe's Diner, Austin, TX [zip code]");
    expect(grace).toContain("Languages: English, Spanish");
    expect(austin.split("\n")[0]).toBe("[name]");
    // a city right before a state code is a place even with no keep list
    expect(scoringView({ firstName: "Austin", lastName: "Reed" }).text("Austin Reed\nWorked in Austin, TX")).toBe("[name]\nWorked in Austin, TX");
    // where it is plainly the person, it is still hidden
    expect(scoringView({ firstName: "Austin", lastName: "Cook", keep }).text("Hi, I'm Austin. Thanks, Austin")).toBe("Hi, I'm [name]. Thanks, [name]");
  });
});

describe("quotes are shown in the candidate's own words", () => {
  it("map a placeholder in a quote back to the original text it stands for", () => {
    const view = scoringView(DANA);
    view.text(RESUME);
    expect(view.restore("[name] was named Hygienist of the Year", [RESUME])).toBe("Dana Kim was named Hygienist of the Year");
    expect(view.restore("[name], RDH", [RESUME])).toBe("DANA KIM, RDH");
    expect(view.restore("[name]  also trains new hires", [RESUME])).toBe("Kim also trains new hires");
    // a quote with no placeholder is left as it is, a quote that cannot be mapped back too (so the check fails it)
    expect(view.restore("Hygienist at Bayside Dental", [RESUME])).toBe("Hygienist at Bayside Dental");
    expect(view.restore("[name] invented this", [RESUME])).toBe("[name] invented this");
    expect(hasPlaceholder("[name] invented this")).toBe(true);
    expect(hasPlaceholder("Dana Kim")).toBe(false);
    expect(PLACEHOLDER.street).toBe("[street address]");
  });

  it("leave no placeholder in the model's own words that owners read; quotes are left to the quote check", () => {
    const reading = { summary: "[name] has six years of perio; their [link] portfolio shows cases.", strengths: [{ claim: "[name] trains staff", evidence: { source: "resume", quote: "[name] trained six" } }], unknowns: ["Is the [street address] near the office?"], confidence: "high", score: 3 };
    const out = withoutPlaceholders(reading);
    expect(out.summary).toBe("the candidate has six years of perio; their a detail that was hidden portfolio shows cases.");
    expect(out.strengths[0]!.claim).toBe("the candidate trains staff");
    expect(out.strengths[0]!.evidence.quote).toBe("[name] trained six");
    expect(out.unknowns[0]).toBe("Is the a detail that was hidden near the office?");
    expect({ confidence: out.confidence, score: out.score }).toEqual({ confidence: "high", score: 3 });
    const owners = JSON.stringify({ ...out, strengths: out.strengths.map((s) => ({ claim: s.claim })) });
    expect(hasPlaceholder(owners)).toBe(false);
  });

  it("walk every quote in a reading, looking first in the source each one cites", () => {
    const view = scoringView(DANA);
    view.text(RESUME);
    const reading = { strengths: [{ claim: "Award", evidence: { source: "resume", quote: "[name] was named Hygienist of the Year" } }], other: { quote: "no placeholder" }, n: 3 };
    const out = restoreQuotes(reading, view, (source) => (source === "resume" ? [RESUME] : []));
    expect(out.strengths[0]!.evidence.quote).toBe("Dana Kim was named Hygienist of the Year");
    expect(out.other.quote).toBe("no placeholder");
    expect(out.n).toBe(3);
  });
});
