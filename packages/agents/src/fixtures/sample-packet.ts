import { RolePacket as RolePacketSchema, type RolePacket } from "@ros/contracts";

/**
 * A complete, valid job record for tests: synthetic, fair and checkable as written, so each case changes only what it
 * is about.
 */
export function samplePacket(over: (p: RolePacket) => void = () => {}): RolePacket {
  const p = RolePacketSchema.parse({
    identity: { title: "Dental Assistant", locations: [{ city: "Irvine", region: "CA", country: "US" }], employmentType: "full_time", schedule: "Monday to Friday, 8 to 5", remotePolicy: "onsite" },
    compensation: { basis: "hourly", currency: "USD", min: 24, max: 28, discloseRange: true },
    description: { publicJobDescription: "Harbor Dental is hiring a dental assistant in Irvine. You will seat patients, take digital x-rays and keep the operatories ready, alongside two hygienists and a dentist who explains the plan for every patient." },
    requirements: {
      mustHaves: [
        { key: "mh_xray", text: "Radiography certificate", rationale: "Required to take x-rays" },
        { key: "mh_chairside", text: "Chairside experience in a dental office", rationale: "The core of the job" },
      ],
      niceToHaves: [{ key: "nh_dentrix", text: "Dentrix experience", rationale: "Our software" }],
    },
    competencies: [
      { key: "chairside", name: "Chairside skill", definition: "Anticipates the dentist's next step.", importance: "essential", indicators: ["Examples from recent work"] },
      { key: "patients", name: "Patient care", definition: "Puts nervous patients at ease.", importance: "important", indicators: ["A nervous patient story"] },
      { key: "infection", name: "Infection control", definition: "Follows sterilization steps every time.", importance: "important", indicators: ["Describes the steps"] },
    ],
    screening: {
      questions: [
        { key: "recent", question: "Tell me about your most recent dental assisting work.", kind: "skills", modelAnswer: "Specific procedures" },
        { key: "nervous", question: "Tell me about a nervous patient and what you did.", kind: "behavioral" },
        { key: "available", question: "Which days and hours are you available?", kind: "availability" },
        { key: "pay", question: "What hourly range are you looking for?", kind: "compensation" },
      ],
      maxMinutes: 15,
    },
    formQuestions: [{ kind: "yes_no", key: "schedule", question: "Are you available Monday to Friday, 8 to 5?", help: "The office hours", required: true }],
    communication: { tone: "warm", companyBlurb: "A family practice in Irvine.", signature: "The team at Harbor Dental", disclosureText: "This message was sent by the hiring team at Harbor Dental with help from an AI recruiting assistant. Reply HUMAN at any time to reach a person.", humanAlternativeText: "Reply HUMAN at any time and a person from our team will follow up." },
    compliance: {},
    provenance: {},
  });
  over(p);
  return p;
}
