/**
 * The quick starts under "Who are you hiring?" (plan C4): only roles one of our hiring guides knows, so a tap always
 * starts from real playbook knowledge (typical must-haves, screening questions, pay ranges) and never from a guess.
 * A tap fills the box with a first sentence to finish; nothing is sent until the person sends it.
 *
 * Mirrors packages/playbooks (the pages do not ship the playbooks themselves); tests/web/job-builder.test.ts checks
 * that every business type maps to the same guide as VERTICAL_TO_PLAYBOOK and every start matches a role in it.
 */

/** Which hiring guide serves a business type (VERTICAL_TO_PLAYBOOK in packages/playbooks/src/index.ts). */
export const GUIDE_OF_VERTICAL: Readonly<Record<string, string>> = {
  consumer: "consumer",
  beauty: "consumer",
  ecommerce: "consumer",
  retail: "consumer",
  marketing: "consumer",
  creative: "consumer",
  agency: "consumer",
  saas: "consumer",
  tech_services: "consumer",
  professional_services: "consumer",
  dental: "dental",
};

export type QuickStart = { label: string; text: string };

/** Each guide's roles, as a chip and the sentence it starts. */
export const QUICK_STARTS: Readonly<Record<string, readonly QuickStart[]>> = {
  dental: [
    { label: "Dental hygienist", text: "I'm hiring a dental hygienist " },
    { label: "Dental assistant", text: "I'm hiring a dental assistant " },
    { label: "Front desk", text: "I'm hiring for our front desk " },
    { label: "Office manager", text: "I'm hiring an office manager " },
    { label: "Associate dentist", text: "I'm hiring an associate dentist " },
  ],
  consumer: [
    { label: "Performance marketing manager", text: "I'm hiring a performance marketing manager " },
    { label: "E-commerce manager", text: "I'm hiring an e-commerce manager " },
    { label: "Social media manager", text: "I'm hiring a social media manager " },
    { label: "Customer success manager", text: "I'm hiring a customer success manager " },
    { label: "Account executive", text: "I'm hiring an account executive " },
    { label: "Operations manager", text: "I'm hiring an operations manager " },
  ],
};

/** The quick starts for a business type, or none when no guide serves it. */
export function quickStartsFor(vertical: string | null | undefined): readonly QuickStart[] {
  const guide = GUIDE_OF_VERTICAL[(vertical ?? "").trim().toLowerCase()];
  return guide ? QUICK_STARTS[guide] ?? [] : [];
}
