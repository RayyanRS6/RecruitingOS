import { RolePacket as RolePacketSchema, type RolePacket } from "@ros/contracts";

/**
 * A complete, valid Role Packet for the packet tool tests (requirements check, change by chat): synthetic, fair and
 * checkable as written, so each case changes only what it is about.
 */
export function samplePacket(over: (p: RolePacket) => void = () => {}): RolePacket {
  const p = RolePacketSchema.parse({
    identity: { title: "Dental Assistant", locations: [{ city: "Irvine", region: "CA", country: "US" }], employmentType: "full_time", schedule: "Monday to Friday, 8 to 5", remotePolicy: "onsite" },
    business: { reason: "replacement", timeline: { urgency: "normal", inactivityDays: 10 } },
    compensation: { basis: "hourly", currency: "USD", min: 24, max: 28, ceiling: 30, discloseRange: true, sources: [{ name: "owner-stated", detail: "24–28 hourly" }], ownerStated: true },
    description: { publicJobDescription: "Harbor Dental is hiring a dental assistant in Irvine. You will seat patients, take digital x-rays and keep the operatories ready, alongside two hygienists and a dentist who explains the plan for every patient." },
    requirements: {
      mustHaves: [
        { key: "mh_xray", text: "Radiography certificate", rationale: "Required to take x-rays", evidencedBy: ["resume", "screen"] },
        { key: "mh_chairside", text: "Chairside experience in a dental office", rationale: "The core of the job", evidencedBy: ["resume", "screen"] },
      ],
      niceToHaves: [{ key: "nh_dentrix", text: "Dentrix experience", rationale: "Our software", evidencedBy: ["resume"] }],
      eligibility: [{ key: "schedule", type: "schedule_availability", question: "Are you available Monday to Friday, 8 to 5?", expectation: {}, rationale: "The office hours", knockout: true }],
    },
    competencies: [
      { key: "chairside", name: "Chairside skill", definition: "Anticipates the dentist's next step.", weight: 5, evaluatedIn: "both", indicators: ["Examples from recent work"] },
      { key: "patients", name: "Patient care", definition: "Puts nervous patients at ease.", weight: 4, evaluatedIn: "both", indicators: ["A nervous patient story"] },
      { key: "infection", name: "Infection control", definition: "Follows sterilization steps every time.", weight: 4, evaluatedIn: "screen", indicators: ["Describes the steps"] },
    ],
    evaluation: { criteria: ["Evidence for each must-have"], redFlags: ["Cannot confirm the radiography certificate"] },
    screening: {
      questions: [
        { key: "recent", question: "Tell me about your most recent dental assisting work.", kind: "skills", competencyKey: "chairside", modelAnswer: "Specific procedures" },
        { key: "nervous", question: "Tell me about a nervous patient and what you did.", kind: "behavioral", competencyKey: "patients" },
        { key: "available", question: "Which days and hours are you available?", kind: "availability" },
        { key: "pay", question: "What hourly range are you looking for?", kind: "compensation" },
      ],
      maxMinutes: 15,
    },
    interviews: {
      plan: [{ key: "owner", title: "Conversation with the dentist", purpose: "Fit and questions", durationMinutes: 30, format: "video", interviewerUserIds: ["u-1"], interviewerRoles: ["owner"], competencyKeys: ["patients"], suggestedQuestions: [] }],
      scorecard: { scale: { min: 1, max: 4, labels: { "1": "Concern", "4": "Strong" } } },
    },
    communication: { tone: "warm", companyBlurb: "A family practice in Irvine.", signature: "The team at Harbor Dental", disclosureText: "This message was sent by the hiring team at Harbor Dental with help from an AI recruiting assistant. Reply HUMAN at any time to reach a person.", humanAlternativeText: "Reply HUMAN at any time and a person from our team will follow up." },
    approvals: {},
    compliance: {},
    sourcing: { summary: "Careers page and Google.", channels: ["careers_page", "google_jobs"] },
    preferences: { decisionMakerUserId: "u-1", decisionMakerName: "Dr Chen", dealBreakersInTheirWords: [] },
    provenance: {},
  });
  over(p);
  return p;
}
