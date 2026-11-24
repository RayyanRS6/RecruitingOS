import { describe, expect, it } from "vitest";
import { RolePacket } from "@ros/contracts";
import { tapFormatFor } from "@ros/core";
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
