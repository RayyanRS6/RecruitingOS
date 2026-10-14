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

/**
 * What the ten quick questions (Wave S2, K2) suggest for a role a hiring guide knows: its common qualifications as
 * must-haves to tick, and its yes/no eligibility questions. Mirrors each playbook role's `title`, `aliases`,
 * `commonQualifications` and `eligibility[].question` (packages/playbooks); tests/web/start-hire-quick.test.ts keeps
 * them equal, so a suggestion is always real playbook knowledge and never a guess.
 */
export type GuideRole = { key: string; title: string; aliases: readonly string[]; mustHaves: readonly string[]; questions: readonly string[] };

const US_WORK = "Are you legally authorized to work in the United States for any employer?";
const POSTED_SCHEDULE = "Are you available for the posted schedule and work model?";

export const GUIDE_ROLES: Readonly<Record<string, readonly GuideRole[]>> = {
  dental: [
    {
      key: "rdh",
      title: "Registered Dental Hygienist",
      aliases: ["dental hygienist", "hygienist", "RDH"],
      mustHaves: ["Local anesthesia certification (state-dependent)", "Nitrous oxide monitoring permit (state-dependent)", "Experience with Dentrix, Eaglesoft, or Open Dental", "Digital radiography and intraoral scanning", "Periodontal charting and non-surgical periodontal therapy"],
      questions: ["Do you hold an active dental hygiene (RDH) license in the state where this office is located?", "Do you hold current CPR/BLS certification?", "Are you available for the days this office is open?"],
    },
    {
      key: "da",
      title: "Dental Assistant",
      aliases: ["dental assistant", "RDA", "registered dental assistant", "DA", "EFDA"],
      mustHaves: ["Four-handed dentistry", "Sterilization and OSHA compliance", "Digital radiography", "Impressions and provisional crowns", "Dentrix / Eaglesoft / Open Dental"],
      questions: ["If this role requires a Registered Dental Assistant (RDA) license in your state, do you hold it? (Answer 'not required' if the owner did not require it.)", "Do you hold a current radiation safety / x-ray certification and CPR/BLS?", "Are you available for the days this office is open?"],
    },
    {
      key: "front_office",
      title: "Front Office Coordinator",
      aliases: ["front desk", "patient coordinator", "receptionist", "scheduling coordinator", "front office"],
      mustHaves: ["Dental insurance verification and claims basics", "Multi-line phones and scheduling", "Dentrix / Eaglesoft / Open Dental", "Collections at time of service"],
      questions: ["Are you available for the days and hours this office is open?"],
    },
    {
      key: "office_manager",
      title: "Dental Office Manager",
      aliases: ["practice manager", "office manager", "practice administrator"],
      mustHaves: ["Dental practice management experience", "Team leadership", "Insurance and AR management", "HIPAA and OSHA compliance", "Practice management software administration"],
      questions: ["Are you available for the office's full schedule?"],
    },
    {
      key: "associate_dentist",
      title: "Associate Dentist",
      aliases: ["dentist", "associate", "DDS", "DMD"],
      mustHaves: ["Comprehensive restorative dentistry", "Molar endodontics", "Extractions", "Implant restoration", "Case presentation"],
      questions: ["Do you hold an active dental license (DDS/DMD) in the state where this office is located?", "Do you hold a current DEA registration and CPR/BLS?"],
    },
  ],
  consumer: [
    {
      key: "performance_marketing_manager",
      title: "Performance Marketing Manager",
      aliases: ["performance marketing manager", "growth marketing manager", "paid media manager", "digital marketing manager", "performance marketer", "growth marketer", "paid social manager", "acquisition marketing manager"],
      mustHaves: ["Hands-on management of Meta and Google Ads budgets ($50k+ per month)", "Creative testing frameworks and landing page iteration", "Attribution and measurement (GA4, MTA/MMM basics, incrementality tests)", "Shopify or headless commerce analytics; Klaviyo or similar for retention", "Affiliate, influencer or marketplace channels for consumer brands"],
      questions: [US_WORK, POSTED_SCHEDULE],
    },
    {
      key: "ecommerce_manager",
      title: "E-commerce Manager",
      aliases: ["e-commerce manager", "ecommerce manager", "shopify manager", "dtc manager", "digital commerce manager", "online store manager", "head of ecommerce"],
      mustHaves: ["Shopify (Plus) administration and apps", "Conversion rate optimization and site merchandising", "Klaviyo/Attentive retention programs", "Promotion planning and margin awareness", "Working with 3PL and customer care on order issues"],
      questions: [US_WORK, POSTED_SCHEDULE],
    },
    {
      key: "social_content_manager",
      title: "Social and Content Marketing Manager",
      aliases: ["social media manager", "content marketing manager", "social content manager", "community manager", "content manager", "social media marketing manager", "brand content manager"],
      mustHaves: ["Instagram, TikTok and YouTube growth for a brand", "Creator and UGC programs", "Content calendars and light production (Canva, CapCut, Figma)", "Community management and reply tone", "Reporting on reach, engagement and conversion from social"],
      questions: [US_WORK, POSTED_SCHEDULE],
    },
    {
      key: "customer_success_manager",
      title: "Customer Success Manager",
      aliases: ["customer success manager", "customer success", "client success manager", "account manager", "customer experience manager", "customer care manager"],
      mustHaves: ["Owned renewals or retention targets", "Onboarding and QBR programs", "Helpdesk or CRM tools (Gorgias, Zendesk, HubSpot)", "Escalation handling", "Reporting on churn, NPS and response times"],
      questions: [US_WORK, POSTED_SCHEDULE],
    },
    {
      key: "account_executive",
      title: "Account Executive",
      aliases: ["account executive", "sales representative", "sales rep", "business development representative", "sales executive", "wholesale sales manager", "sales manager"],
      mustHaves: ["Quota ownership with attainment history", "Outbound prospecting and CRM hygiene (HubSpot, Salesforce)", "Retail buyer, distributor or B2B relationships in the category", "Negotiating terms and pricing", "Trade show and line-review experience for consumer brands"],
      questions: [US_WORK, "Are you available for the posted schedule and work model, including any travel stated in the posting?"],
    },
    {
      key: "operations_manager",
      title: "Operations Manager",
      aliases: ["operations manager", "ops manager", "head of operations", "supply chain manager", "fulfillment manager", "business operations manager"],
      mustHaves: ["Inventory planning and 3PL or warehouse management", "Vendor and freight negotiation", "Systems (ERP, Shopify, inventory tools) and reporting", "Process documentation and team training", "Budget ownership"],
      questions: [US_WORK, POSTED_SCHEDULE],
    },
  ],
};

/** Yes/no questions offered when no guide knows the job: the two every consumer guide role asks. */
export const GENERAL_QUESTIONS: readonly string[] = [US_WORK, POSTED_SCHEDULE];

/**
 * The guide role a typed job title names, the way the server matches it (`matchPlaybookRole`): the longest title or alias
 * the words contain wins. Null when the business type has no guide, or the guide does not know the job.
 */
export function guideRoleFor(vertical: string | null | undefined, title: string): GuideRole | null {
  const guide = GUIDE_OF_VERTICAL[(vertical ?? "").trim().toLowerCase()];
  const roles = guide ? GUIDE_ROLES[guide] ?? [] : [];
  const t = title.toLowerCase();
  let best: { role: GuideRole; score: number } | null = null;
  for (const role of roles) {
    for (const n of [role.title, ...role.aliases].map((x) => x.toLowerCase())) {
      if (t.includes(n) && (!best || n.length > best.score)) best = { role, score: n.length };
    }
  }
  return best?.role ?? null;
}
