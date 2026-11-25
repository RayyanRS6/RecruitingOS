import { describe, expect, it } from "vitest";
import { RolePacket } from "@ros/contracts";
import { cvScoreFromReading, guardPacket, tapFormatFor } from "@ros/core";
import { applyFieldEdit } from "./services/packet-fields";

/**
 * What an edit in the one editor does to the three parts of an item the editor neither shows nor carries, each written
 * by the model for the item's words: why a must-have matters (`rationale`), what shows a skill (`indicators`) and an AI
 * interview question's `kind`. The code check of 25 November 2026: all three stayed with an item whose words a person
 * had rewritten, and a question added in the editor was always kept as an open one. So a rewritten must-have was read
 * beside its old "why it matters", and "Can you work Saturdays?" got no Yes and No and a "No" was followed by "tell me
 * about something similar".
 */
const job = (): RolePacket =>
  RolePacket.parse({
    identity: { title: "Dental Assistant", locations: [{ city: "Irvine", region: "CA", country: "US" }], employmentType: "full_time", remotePolicy: "onsite" },
    compensation: { basis: "hourly", currency: "USD", min: 24, max: 28, discloseRange: true },
    description: { publicJobDescription: "Harbor Dental is hiring a dental assistant in Irvine. You will seat patients, take digital x-rays and keep the operatories ready." },
    requirements: {
      mustHaves: [{ key: "mh_xray", text: "Radiography certificate", rationale: "State law asks for it." }, { key: "mh_chairside", text: "Two years of chairside assisting", rationale: "The dentist works four-handed." }],
      niceToHaves: [{ key: "nh_dentrix", text: "Dentrix", rationale: "Our charting software." }, { key: "nh_spanish", text: "Spanish", rationale: "Many patients speak it." }],
    },
    competencies: [
      { key: "chairside", name: "Chairside skill", definition: "Anticipates the dentist's next step.", importance: "essential", indicators: ["Four-handed dentistry"] },
      { key: "patients", name: "Patient care", definition: "Puts nervous patients at ease.", importance: "important", indicators: ["A nervous patient story"] },
      { key: "infection", name: "Infection control", definition: "Follows sterilization steps every time.", importance: "helpful", indicators: ["Names the steps"] },
    ],
    screening: {
      questions: [
        { key: "recent", question: "Tell me about your most recent dental assisting work.", kind: "skills", modelAnswer: "Names chairside work." },
        { key: "nervous", question: "Tell me about a nervous patient and what you did.", kind: "behavioral" },
        { key: "available", question: "Which days and hours are you available?", kind: "availability" },
        { key: "pay", question: "What hourly range are you looking for?", kind: "compensation" },
        { key: "licence", question: "Do you hold a radiography certificate?", kind: "skills" },
      ],
    },
    communication: { tone: "warm", companyBlurb: "A family practice in Irvine.", signature: "The hiring team at Harbor Dental", disclosureText: "This message was sent by the hiring team at Harbor Dental with help from an AI recruiting assistant.", humanAlternativeText: "To reach a person at any time, reply to any of our emails or use the contact on the job page." },
    compliance: {},
    provenance: {},
  });
const comp = { basis: "hourly" as const, currency: "USD" };

describe("the one editor: an edit works out again what the edit changes", () => {
  it("a must-have or a nice-to-have whose words changed loses its old 'why it matters'; an untouched one keeps it, also when the list is reordered", () => {
    const { packet: p, fields } = applyFieldEdit(job(), {
      requirements: {
        mustHaves: [{ key: "mh_chairside", text: "Two years of chairside assisting" }, { key: "mh_xray", text: "Current California radiography permit" }, { text: "Coronal polishing certificate" }],
        niceToHaves: [{ key: "nh_dentrix", text: "Eaglesoft" }, { key: "nh_spanish", text: " Spanish " }],
      },
    });
    expect(p.requirements.mustHaves).toEqual([
      { key: "mh_chairside", text: "Two years of chairside assisting", rationale: "The dentist works four-handed." },
      { key: "mh_xray", text: "Current California radiography permit" },
      { key: "mh_coronal_polishing_certificate", text: "Coronal polishing certificate" },
    ]);
    expect(p.requirements.mustHaves[1]).not.toHaveProperty("rationale");
    expect(p.requirements.niceToHaves).toEqual([{ key: "nh_dentrix", text: "Eaglesoft" }, { key: "nh_spanish", text: " Spanish ", rationale: "Many patients speak it." }]);
    expect(fields).toEqual(["requirements"]);
    // a change of case or of a full stop is a change of the words: what was written for the old ones goes
    const recased = applyFieldEdit(job(), { requirements: { mustHaves: [{ key: "mh_xray", text: "radiography certificate." }, { key: "mh_chairside", text: "Two years of chairside assisting" }] } }).packet;
    expect(recased.requirements.mustHaves).toEqual([{ key: "mh_xray", text: "radiography certificate." }, { key: "mh_chairside", text: "Two years of chairside assisting", rationale: "The dentist works four-handed." }]);
  });

  it("a skill whose name or meaning changed loses its old 'what shows it'; one whose importance alone changed keeps it", () => {
    const { packet: p } = applyFieldEdit(job(), {
      competencies: [
        { key: "chairside", name: "Chairside skill", importance: "important" },
        { key: "patients", name: "Patient care", importance: "important", definition: "Explains every step before doing it." },
        { key: "infection", name: "Sterilization", importance: "helpful", definition: "Follows sterilization steps every time." },
        { name: "Digital x-rays", importance: "helpful" },
      ],
    });
    expect(p.competencies).toEqual([
      { key: "chairside", name: "Chairside skill", definition: "Anticipates the dentist's next step.", importance: "important", indicators: ["Four-handed dentistry"] },
      { key: "patients", name: "Patient care", definition: "Explains every step before doing it.", importance: "important", indicators: [] },
      { key: "infection", name: "Sterilization", definition: "Follows sterilization steps every time.", importance: "helpful", indicators: [] },
      { key: "skill_digital_x_rays", name: "Digital x-rays", definition: "", importance: "helpful", indicators: [] },
    ]);
    // sent back as it was, meaning included: nothing changes
    const same = applyFieldEdit(job(), { competencies: job().competencies.map((c) => ({ key: c.key, name: c.name, importance: c.importance, definition: c.definition })) });
    expect(same.packet.competencies).toEqual(job().competencies);
    expect(same.fields).toEqual([]);
  });

  it("an AI interview question that is new or reworded gets its kind from its words; an untouched question keeps its kind, whatever its words", () => {
    const { packet: p } = applyFieldEdit(job(), {
      screening: {
        questions: [
          // reworded as a yes-or-no question: a question about a fact now
          { key: "recent", question: "Have you assisted chairside in the last two years?" },
          // reworded, still open: the kind it had
          { key: "nervous", question: "Tell me about an anxious patient and what you did." },
          // untouched, spacing aside
          { key: "available", question: "Which days and  hours are you available? " },
          // the pay question, reworded: still the pay question
          { key: "pay", question: "What hourly pay range are you looking for?" },
          // untouched: its words are yes-or-no, but nobody changed them, so it keeps the kind it has
          { key: "licence", question: "Do you hold a radiography certificate?" },
          // new: one that can only be answered yes or no, and one that asks for their own words
          { question: "Can you work Saturdays?" },
          { question: "How do you set up for a crown prep?", modelAnswer: "Names the tray and the steps." },
        ],
      },
    });
    expect(p.screening.questions.map((q) => [q.key, q.kind, q.modelAnswer ?? null])).toEqual([
      ["recent", "eligibility", "Names chairside work."],
      ["nervous", "behavioral", null],
      ["available", "availability", null],
      ["pay", "compensation", null],
      ["licence", "skills", null],
      ["q_can_you_work_saturdays", "eligibility", null],
      ["q_how_do_you_set_up_for_a_crown", "skills", "Names the tray and the steps."],
    ]);
    // what a candidate gets for each: Yes and No for the two questions about a fact, the days, a pay range, and their own words for the rest
    expect(p.screening.questions.map((q) => tapFormatFor(q, comp)?.kind ?? null)).toEqual(["yes_no", null, "days", "pay_range", null, "yes_no", null]);
    // a pay question rewritten into another question is no pay question: an open one, with no pay range under it
    const replaced = applyFieldEdit(job(), { screening: { questions: [{ key: "pay", question: "Tell me about a time you stayed late to finish the day's work." }, { key: "recent", question: "Tell me about your most recent dental assisting work." }, { key: "nervous", question: "Tell me about a nervous patient and what you did." }] } }).packet;
    expect(replaced.screening.questions.map((q) => [q.key, q.kind])).toEqual([["pay", "skills"], ["recent", "skills"], ["nervous", "behavioral"]]);
  });
});

/**
 * A stored reading's findings are matched to a job's must-haves and skills by key, a scorecard's to the AI interview's
 * questions and a candidate's answers to the form's questions, and nothing held a record's keys apart (code check of 25
 * November 2026). The editor's save leaves every item with a key no other of its kind has: here for the lists it is
 * sent, and through the fairness guard, which every save goes on to, for the rest.
 */
describe("the one editor: every item is saved with a key of its own", () => {
  /** A record from before keys were held unique: two must-haves, two skills and two form questions under one key each. */
  const twins = (): RolePacket => {
    const p = job();
    p.requirements.mustHaves[1].key = "mh_xray";
    p.competencies[2].key = "chairside";
    p.formQuestions = [{ kind: "yes_no", key: "fq", question: "Can you work Saturdays?", required: true }, { kind: "yes_no", key: "fq", question: "Do you hold a current CPR card?", required: true }];
    return p;
  };
  const guardCtx = { companyName: "Harbor Dental", companyLocations: [{ city: "Irvine", region: "CA", country: "US" }] };
  /** A resume reading that shows the first must-have and says nothing of the second. */
  const reading = { requirementFindings: [{ requirementKey: "mh_xray", met: "yes" as const, evidence: { source: "resume" as const, quote: "California radiography certificate, 2021" } }], competencyFindings: [] };

  it("saves a list whose stored keys repeat: the first item keeps the key that stored readings point at, the next gets its own", () => {
    // the editor shows no keys, so it sends back the two it was given; this used to be refused as "in the list twice"
    const sent = { requirements: { mustHaves: [{ key: "mh_xray", text: "Radiography certificate" }, { key: "mh_xray", text: "Two years of chairside assisting" }] } };
    const { packet: p } = applyFieldEdit(twins(), sent);
    expect(p.requirements.mustHaves).toEqual([
      { key: "mh_xray", text: "Radiography certificate", rationale: "State law asks for it." },
      { key: "mh_xray_2", text: "Two years of chairside assisting", rationale: "The dentist works four-handed." },
    ]);
    // each must-have is now read on its own finding: one shown of two, where the record as it was showed both on one finding
    expect(cvScoreFromReading(reading, twins()).mustHaves).toEqual({ shown: 2, total: 2 });
    expect(cvScoreFromReading(reading, p).mustHaves).toEqual({ shown: 1, total: 2 });
    // the same for the form's questions, whose answers are kept by key, with a new question beside them
    const form = applyFieldEdit(twins(), { formQuestions: [{ kind: "yes_no", key: "fq", question: "Can you work Saturdays?" }, { kind: "yes_no", key: "fq", question: "Do you hold a current CPR card?" }, { kind: "yes_no", question: "Can you start within 30 days?" }] }).packet;
    expect(form.formQuestions.map((q) => q.key)).toEqual(["fq", "fq_2", "fq_can_you_start_within_30_days"]);
  });

  it("holds the lists an edit did not send the same way when the record is saved, and changes no key that is already its own", () => {
    // the guard is what both saves go on to: a draft's (`saveDraftEdit`) and a published job's (`guardPacketVersion`)
    const saved = guardPacket(applyFieldEdit(twins(), { identity: { title: "Lead Dental Assistant" } }).packet, guardCtx).packet;
    expect(saved.requirements.mustHaves.map((m) => m.key)).toEqual(["mh_xray", "mh_xray_2"]);
    expect(saved.competencies.map((c) => c.key)).toEqual(["chairside", "patients", "chairside_2"]);
    expect(saved.formQuestions.map((q) => q.key)).toEqual(["fq", "fq_2"]);
    expect(saved.requirements.niceToHaves.map((m) => m.key)).toEqual(["nh_dentrix", "nh_spanish"]);
    expect(saved.screening.questions.map((q) => q.key)).toEqual(["recent", "nervous", "available", "pay", "licence"]);
    // a record whose keys are already unique comes back with every one of them, edited or not
    const plain = guardPacket(applyFieldEdit(job(), { requirements: { mustHaves: [{ key: "mh_chairside", text: "Two years of chairside assisting" }, { key: "mh_xray", text: "Radiography certificate" }] } }).packet, guardCtx).packet;
    expect(plain.requirements.mustHaves.map((m) => m.key)).toEqual(["mh_chairside", "mh_xray"]);
    expect(plain.competencies.map((c) => c.key)).toEqual(["chairside", "patients", "infection"]);
  });

  it("still refuses a key sent more often than the job holds it, and a key the job does not hold", () => {
    expect(() => applyFieldEdit(job(), { requirements: { mustHaves: [{ key: "mh_xray", text: "Radiography certificate" }, { key: "mh_xray", text: "Coronal polishing certificate" }] } })).toThrow("Must-have 2 is in the list twice.");
    expect(() => applyFieldEdit(twins(), { requirements: { mustHaves: [{ key: "mh_xray", text: "One" }, { key: "mh_xray", text: "Two" }, { key: "mh_xray", text: "Three" }] } })).toThrow("Must-have 3 is in the list twice.");
    expect(() => applyFieldEdit(job(), { requirements: { mustHaves: [{ key: "mh_gone", text: "Radiography certificate" }] } })).toThrow("One of these items is no longer on this job. Reload the page and try again.");
  });

  it("gives a new item a key unlike every key the list has, the own key of a repeat included", () => {
    // "Xray" as a new must-have would be keyed mh_xray, which this job holds twice: the repeat takes mh_xray_2, the new one the next
    const { packet: p } = applyFieldEdit(twins(), { requirements: { mustHaves: [{ key: "mh_xray", text: "Radiography certificate" }, { key: "mh_xray", text: "Two years of chairside assisting" }, { text: "Xray" }] } });
    expect(p.requirements.mustHaves.map((m) => [m.key, m.text])).toEqual([["mh_xray", "Radiography certificate"], ["mh_xray_2", "Two years of chairside assisting"], ["mh_xray_3", "Xray"]]);
    // and in a job whose keys are its own, it takes the first free one, as before
    const again = applyFieldEdit(job(), { requirements: { mustHaves: [{ key: "mh_xray", text: "Radiography certificate" }, { key: "mh_chairside", text: "Two years of chairside assisting" }, { text: "Xray" }] } }).packet;
    expect(again.requirements.mustHaves.map((m) => m.key)).toEqual(["mh_xray", "mh_chairside", "mh_xray_2"]);
  });
});
