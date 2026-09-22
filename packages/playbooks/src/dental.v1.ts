import { Playbook, type Playbook as PlaybookT, type PlaybookInput } from "@ros/contracts";

/**
 * Dental vertical playbook, version 1. Authored as a starting point from ITS recruiting practice;
 * compensation figures are estimates to be reviewed against BLS OEWS and current market data before
 * a customer relies on them (each entry names its source and date). Customers override on the packet.
 */
const dental: PlaybookInput = {
  vertical: "dental",
  version: 1,
  name: "Dental practices and small dental groups",
  summary:
    "General and specialty dental practices with 15 to 150 staff. Licensed clinical roles (hygienists, assistants) are scarce and heavily temped; front-office turnover is high; owners are clinicians with no time to recruit.",
  authoredBy: "Identified Talent Solutions",
  reviewedAt: "2026-09-09",
  generalRedFlags: [
    "Unexplained lapse in a required license (ask, do not assume)",
    "Cannot describe infection-control or HIPAA basics for the role",
    "Availability that does not match the clinic's actual schedule",
  ],
  communicationDefaults: {
    tone: "warm",
    candidateMayBeTold: [
      "The pay range posted for the role",
      "The schedule and days the office is open",
      "The interview steps and typical timeline",
      "Benefits at a summary level (as written in the packet)",
    ],
  },
  roles: [
    {
      key: "rdh",
      title: "Registered Dental Hygienist",
      aliases: ["dental hygienist", "hygienist", "RDH"],
      summary: "Provides preventive care, periodontal therapy, patient education, and radiographs under the supervising dentist.",
      typicalEmploymentTypes: ["full_time", "part_time", "per_diem"],
      eligibility: [
        {
          type: "license",
          question: "Do you hold an active dental hygiene (RDH) license in the state where this office is located?",
          expectationByJurisdiction: { "US-CA": { license: "RDH", board: "Dental Hygiene Board of California" }, "*": { license: "RDH" } },
          rationale: "Required by law to practice dental hygiene.",
        },
        {
          type: "certification",
          question: "Do you hold current CPR/BLS certification?",
          expectationByJurisdiction: { "*": { certification: "BLS" } },
          rationale: "Required for clinical staff; can be obtained before start if the owner allows.",
        },
        {
          type: "schedule_availability",
          question: "Are you available for the days this office is open?",
          expectationByJurisdiction: {},
          rationale: "Coverage is the reason for the hire.",
        },
      ],
      commonQualifications: [
        "Local anesthesia certification (state-dependent)",
        "Nitrous oxide monitoring permit (state-dependent)",
        "Experience with Dentrix, Eaglesoft, or Open Dental",
        "Digital radiography and intraoral scanning",
        "Periodontal charting and non-surgical periodontal therapy",
      ],
      competencies: [
        { key: "clinical_quality", name: "Clinical quality", definition: "Thorough, gentle, standards-based care including perio assessment and radiographs.", weight: 5, indicators: ["Describes a complete periodontal assessment", "Explains infection-control steps without prompting", "Comfortable with digital radiography"] },
        { key: "patient_communication", name: "Patient communication", definition: "Explains findings and home care in plain language and builds trust.", weight: 5, indicators: ["Gives a concrete example of educating a resistant patient", "Handles anxious patients calmly"] },
        { key: "efficiency", name: "Efficiency and time management", definition: "Keeps to the schedule without cutting corners.", weight: 4, indicators: ["Typical appointment lengths", "How they handle running behind"] },
        { key: "teamwork", name: "Teamwork with dentist and assistants", definition: "Communicates findings to the dentist, supports treatment planning, respects the team.", weight: 4, indicators: ["Describes handoffs to the doctor", "Examples of helping outside their chair"] },
        { key: "reliability", name: "Reliability", definition: "Shows up, on time, consistently; communicates early about conflicts.", weight: 4, indicators: ["Attendance history discussed candidly", "How they handle a schedule change"] },
        { key: "systems", name: "Practice software and technology", definition: "Charts accurately in the practice management system.", weight: 3, indicators: ["Names the systems used", "Comfort with intraoral scanners"] },
      ],
      screeningQuestions: [
        { key: "license_confirm", question: "Can you confirm your RDH license state and whether it is currently active?", kind: "eligibility", modelAnswer: "States the license and that it is active; can name the license number on request." },
        { key: "perio", question: "Walk me through how you handle a new patient with generalized moderate periodontitis.", kind: "skills", competencyKey: "clinical_quality", modelAnswer: "Full perio charting, radiographs, treatment plan discussion with the dentist, scaling and root planing by quadrant, re-evaluation." },
        { key: "anxious", question: "Tell me about a time a patient was anxious or resistant. What did you do?", kind: "behavioral", competencyKey: "patient_communication", modelAnswer: "Specific example; slowed down; explained; checked in; outcome." },
        { key: "schedule", question: "What appointment length are you used to for an adult prophy, and how do you handle running behind?", kind: "skills", competencyKey: "efficiency", modelAnswer: "45 to 60 minutes typical; communicates with front desk; prioritizes." },
        { key: "software", question: "Which practice management systems have you used?", kind: "skills", competencyKey: "systems", modelAnswer: "Names one or more; describes charting." },
        { key: "availability", question: "Which days and hours are you available, and when could you start?", kind: "availability", modelAnswer: "Matches the office schedule; start date within the target window." },
        { key: "pay", question: "What hourly range are you looking for?", kind: "compensation", modelAnswer: "A range; the system compares to the packet." },
        { key: "why", question: "What are you looking for in your next office?", kind: "motivation", modelAnswer: "Specific, consistent with the role." },
      ],
      interviewPlan: [
        { key: "owner", title: "Conversation with the dentist or office manager", purpose: "Fit, expectations, and the candidate's questions.", durationMinutes: 30, format: "video", competencyKeys: ["patient_communication", "reliability", "teamwork"], suggestedQuestions: ["What does a great day in your chair look like?", "How do you like to communicate findings to the doctor?", "What would make you leave an office?"] },
        { key: "working", title: "Working interview or clinical skills conversation", purpose: "Observe clinical approach, charting, and patient interaction (paid working interview where the practice does this).", durationMinutes: 90, format: "onsite", competencyKeys: ["clinical_quality", "efficiency", "systems"], suggestedQuestions: ["Chart this case", "How would you sequence this schedule?"] },
      ],
      redFlags: ["Cannot confirm license status", "Unfamiliar with basic infection-control steps", "Expects appointment lengths far outside the practice's model without discussion"],
      candidateObjections: [
        { objection: "Temp agencies pay more per hour.", response: "Explain total compensation and stability: consistent schedule, benefits, PTO, continuing education, and a team that knows your name. Ask what matters most to them." },
        { objection: "I don't want to work Saturdays.", response: "Be honest about the schedule. If Saturdays are required, say so early. If they rotate, explain the rotation." },
      ],
      compensation: [
        { metro: "Los Angeles-Long Beach-Anaheim, CA", basis: "hourly", p25: 50, p50: 57, p75: 64, source: "BLS OEWS May 2024 for the MSA, adjusted by ITS market observation Sep 2026; review before quoting", asOf: "2026-09" },
        { metro: "San Diego-Carlsbad, CA", basis: "hourly", p25: 50, p50: 56, p75: 63, source: "BLS OEWS May 2024 for the MSA, adjusted by ITS market observation Sep 2026; review before quoting", asOf: "2026-09" },
        { metro: "Phoenix-Mesa-Chandler, AZ", basis: "hourly", p25: 42, p50: 48, p75: 55, source: "BLS OEWS May 2024 for the MSA, adjusted by ITS market observation Sep 2026; review before quoting", asOf: "2026-09" },
        { metro: "US national", basis: "hourly", p25: 38, p50: 46, p75: 54, source: "BLS OEWS May 2024 national (29-1292), adjusted; review before quoting", asOf: "2026-09" },
      ],
      benchmarks: { applicantsPerHire: 12, screensPerHire: 6, interviewsPerHire: 3, medianDaysToFill: 35 },
      channels: ["indeed", "careers_page", "google_jobs", "associations", "schools", "referrals"],
    },
    {
      key: "da",
      title: "Dental Assistant",
      aliases: ["dental assistant", "RDA", "registered dental assistant", "DA", "EFDA"],
      summary: "Chairside assisting, sterilization, radiographs, patient preparation, and, where licensed, expanded functions.",
      typicalEmploymentTypes: ["full_time", "part_time"],
      eligibility: [
        {
          type: "license",
          question: "If this role requires a Registered Dental Assistant (RDA) license in your state, do you hold it? (Answer 'not required' if the owner did not require it.)",
          expectationByJurisdiction: { "US-CA": { license: "RDA", board: "Dental Board of California", optional: true }, "*": { license: "DA", optional: true } },
          rationale: "Some duties require licensure in some states; the owner decides whether the license is required at hire.",
        },
        {
          type: "certification",
          question: "Do you hold a current radiation safety / x-ray certification and CPR/BLS?",
          expectationByJurisdiction: { "*": { certification: "x-ray, BLS" } },
          rationale: "Required to take radiographs in most states.",
        },
        {
          type: "schedule_availability",
          question: "Are you available for the days this office is open?",
          expectationByJurisdiction: {},
          rationale: "Coverage is the reason for the hire.",
        },
      ],
      commonQualifications: ["Four-handed dentistry", "Sterilization and OSHA compliance", "Digital radiography", "Impressions and provisional crowns", "Dentrix / Eaglesoft / Open Dental"],
      competencies: [
        { key: "chairside", name: "Chairside skill", definition: "Anticipates the dentist, keeps the field clear, handles instruments and materials correctly.", weight: 5, indicators: ["Describes four-handed technique", "Knows common procedures' setups"] },
        { key: "sterilization", name: "Sterilization and safety", definition: "Follows infection-control protocols exactly.", weight: 5, indicators: ["Explains the sterilization cycle", "Knows OSHA basics"] },
        { key: "patient_care", name: "Patient care and communication", definition: "Puts patients at ease and explains next steps.", weight: 4, indicators: ["Example with a nervous patient"] },
        { key: "reliability", name: "Reliability", definition: "On time, consistent, communicates early.", weight: 4, indicators: ["Attendance history"] },
        { key: "systems", name: "Practice software", definition: "Charts and schedules accurately.", weight: 3, indicators: ["Names systems used"] },
      ],
      screeningQuestions: [
        { key: "certs", question: "Which certifications do you hold (x-ray, coronal polishing, RDA, BLS)?", kind: "eligibility" },
        { key: "procedures", question: "Which procedures are you most comfortable assisting with, and which would you want more training on?", kind: "skills", competencyKey: "chairside" },
        { key: "steri", question: "Describe your sterilization routine between patients.", kind: "skills", competencyKey: "sterilization" },
        { key: "nervous", question: "Tell me about a patient who was nervous. What did you do?", kind: "behavioral", competencyKey: "patient_care" },
        { key: "availability", question: "Which days and hours are you available, and when could you start?", kind: "availability" },
        { key: "pay", question: "What hourly range are you looking for?", kind: "compensation" },
      ],
      interviewPlan: [
        { key: "manager", title: "Conversation with the office manager", purpose: "Fit, reliability, schedule.", durationMinutes: 30, format: "video", competencyKeys: ["patient_care", "reliability", "systems"] },
        { key: "working", title: "Working interview with the dentist", purpose: "Chairside skill and sterilization in practice.", durationMinutes: 120, format: "onsite", competencyKeys: ["chairside", "sterilization"] },
      ],
      redFlags: ["Cannot describe the sterilization cycle", "Unclear on radiograph certification"],
      candidateObjections: [{ objection: "The pay is lower than I hoped.", response: "Share the range honestly, and what raises are tied to (RDA license, expanded functions). Ask what number would make it work." }],
      compensation: [
        { metro: "Los Angeles-Long Beach-Anaheim, CA", basis: "hourly", p25: 23, p50: 27, p75: 32, source: "BLS OEWS May 2024 for the MSA (31-9091), adjusted by ITS observation; review before quoting", asOf: "2026-09" },
        { metro: "US national", basis: "hourly", p25: 20, p50: 24, p75: 28, source: "BLS OEWS May 2024 national (31-9091), adjusted; review before quoting", asOf: "2026-09" },
      ],
      benchmarks: { applicantsPerHire: 20, screensPerHire: 8, interviewsPerHire: 3, medianDaysToFill: 28 },
      channels: ["indeed", "careers_page", "google_jobs", "schools", "referrals"],
    },
    {
      key: "front_office",
      title: "Front Office Coordinator",
      aliases: ["front desk", "patient coordinator", "receptionist", "scheduling coordinator", "front office"],
      summary: "Scheduling, insurance verification, patient communication, collections at the desk, and keeping the day running.",
      typicalEmploymentTypes: ["full_time", "part_time"],
      eligibility: [
        { type: "schedule_availability", question: "Are you available for the days and hours this office is open?", expectationByJurisdiction: {}, rationale: "The desk must be covered during clinic hours." },
      ],
      commonQualifications: ["Dental insurance verification and claims basics", "Multi-line phones and scheduling", "Dentrix / Eaglesoft / Open Dental", "Collections at time of service"],
      competencies: [
        { key: "patient_service", name: "Patient service", definition: "Warm, clear, calm under pressure.", weight: 5, indicators: ["Handles an upset patient example"] },
        { key: "scheduling", name: "Scheduling and follow-through", definition: "Keeps the schedule full and accurate; confirms and reactivates.", weight: 5, indicators: ["Describes how they fill a cancellation"] },
        { key: "insurance", name: "Insurance and financial conversations", definition: "Verifies benefits and explains costs plainly.", weight: 4, indicators: ["Explains a copay conversation"] },
        { key: "accuracy", name: "Accuracy", definition: "Gets details right in charts and ledgers.", weight: 4, indicators: ["Example of catching an error"] },
        { key: "reliability", name: "Reliability", definition: "On time, consistent.", weight: 4, indicators: ["Attendance"] },
      ],
      screeningQuestions: [
        { key: "cancel", question: "A patient cancels a two-hour appointment tomorrow morning. What do you do?", kind: "skills", competencyKey: "scheduling" },
        { key: "upset", question: "Tell me about an upset patient and how you handled it.", kind: "behavioral", competencyKey: "patient_service" },
        { key: "insurance", question: "How do you explain to a patient that their insurance covers less than they expected?", kind: "skills", competencyKey: "insurance" },
        { key: "software", question: "Which practice management systems have you used?", kind: "skills" },
        { key: "availability", question: "Which days and hours are you available, and when could you start?", kind: "availability" },
        { key: "pay", question: "What hourly range are you looking for?", kind: "compensation" },
      ],
      interviewPlan: [
        { key: "manager", title: "Conversation with the office manager", purpose: "Fit and scenarios.", durationMinutes: 30, format: "video", competencyKeys: ["patient_service", "scheduling", "insurance"] },
        { key: "onsite", title: "On-site visit and role play", purpose: "Phones, scheduling scenario, meet the team.", durationMinutes: 60, format: "onsite", competencyKeys: ["accuracy", "reliability", "patient_service"] },
      ],
      redFlags: ["Cannot describe how to fill a cancellation", "Uncomfortable discussing money with patients"],
      candidateObjections: [],
      compensation: [
        { metro: "Los Angeles-Long Beach-Anaheim, CA", basis: "hourly", p25: 21, p50: 24, p75: 28, source: "ITS market observation Sep 2026 and BLS OEWS medical secretaries; review before quoting", asOf: "2026-09" },
        { metro: "US national", basis: "hourly", p25: 18, p50: 21, p75: 25, source: "ITS market observation Sep 2026; review before quoting", asOf: "2026-09" },
      ],
      benchmarks: { applicantsPerHire: 35, screensPerHire: 10, interviewsPerHire: 4, medianDaysToFill: 21 },
      channels: ["indeed", "careers_page", "google_jobs", "referrals"],
    },
    {
      key: "office_manager",
      title: "Dental Office Manager",
      aliases: ["practice manager", "office manager", "practice administrator"],
      summary: "Runs the business side of the practice: team, schedule, collections, insurance, compliance, and patient experience.",
      typicalEmploymentTypes: ["full_time"],
      eligibility: [
        { type: "schedule_availability", question: "Are you available for the office's full schedule?", expectationByJurisdiction: {}, rationale: "The manager is present when the office is open." },
      ],
      commonQualifications: ["Dental practice management experience", "Team leadership", "Insurance and AR management", "HIPAA and OSHA compliance", "Practice management software administration"],
      competencies: [
        { key: "leadership", name: "Team leadership", definition: "Hires, trains, holds accountable, keeps morale.", weight: 5, indicators: ["Example of a performance conversation"] },
        { key: "financial", name: "Financial management", definition: "Collections, AR, insurance, and daily numbers.", weight: 5, indicators: ["Knows their AR and collection ratio"] },
        { key: "operations", name: "Operations", definition: "Schedule optimization, supplies, compliance.", weight: 4, indicators: ["Describes a process they fixed"] },
        { key: "patient_experience", name: "Patient experience", definition: "Owns reviews, complaints, and reactivation.", weight: 4, indicators: ["Example handling a bad review"] },
        { key: "judgment", name: "Judgment and calm", definition: "Handles the unexpected without drama.", weight: 4, indicators: ["A hard day example"] },
      ],
      screeningQuestions: [
        { key: "numbers", question: "Which numbers did you watch daily and monthly in your last practice, and where were they?", kind: "skills", competencyKey: "financial" },
        { key: "team", question: "Tell me about a team member you had to coach or let go.", kind: "behavioral", competencyKey: "leadership" },
        { key: "process", question: "Describe a process you changed that improved the practice.", kind: "behavioral", competencyKey: "operations" },
        { key: "availability", question: "When could you start?", kind: "availability" },
        { key: "pay", question: "What compensation are you looking for?", kind: "compensation" },
      ],
      interviewPlan: [
        { key: "owner", title: "Conversation with the owner dentist", purpose: "Fit, values, expectations.", durationMinutes: 45, format: "video", competencyKeys: ["leadership", "judgment"] },
        { key: "case", title: "Practice numbers working session", purpose: "Walk through a month of practice numbers and a schedule.", durationMinutes: 60, format: "working_session", competencyKeys: ["financial", "operations", "patient_experience"] },
      ],
      redFlags: ["Cannot discuss collections or AR concretely", "Blames every past team"],
      candidateObjections: [],
      compensation: [
        { metro: "Los Angeles-Long Beach-Anaheim, CA", basis: "hourly", p25: 30, p50: 36, p75: 43, source: "ITS market observation Sep 2026; review before quoting", asOf: "2026-09" },
        { metro: "US national", basis: "hourly", p25: 26, p50: 31, p75: 38, source: "ITS market observation Sep 2026; review before quoting", asOf: "2026-09" },
      ],
      benchmarks: { applicantsPerHire: 25, screensPerHire: 8, interviewsPerHire: 4, medianDaysToFill: 40 },
      channels: ["indeed", "careers_page", "google_jobs", "referrals", "associations"],
    },
    {
      key: "associate_dentist",
      title: "Associate Dentist",
      aliases: ["dentist", "associate", "DDS", "DMD"],
      summary: "Provides comprehensive general dentistry under the practice's standards; compensation is usually a daily guarantee against a percentage of production.",
      typicalEmploymentTypes: ["full_time", "part_time"],
      eligibility: [
        { type: "license", question: "Do you hold an active dental license (DDS/DMD) in the state where this office is located?", expectationByJurisdiction: { "US-CA": { license: "DDS/DMD", board: "Dental Board of California" }, "*": { license: "DDS/DMD" } }, rationale: "Required by law." },
        { type: "certification", question: "Do you hold a current DEA registration and CPR/BLS?", expectationByJurisdiction: { "*": { certification: "DEA, BLS" } }, rationale: "Required to prescribe and for clinical staff." },
      ],
      commonQualifications: ["Comprehensive restorative dentistry", "Molar endodontics", "Extractions", "Implant restoration", "Case presentation"],
      competencies: [
        { key: "clinical_range", name: "Clinical range and quality", definition: "Comfortable with the procedure mix the practice needs.", weight: 5, indicators: ["Describes procedures done routinely versus referred"] },
        { key: "case_presentation", name: "Case presentation", definition: "Helps patients accept appropriate treatment ethically.", weight: 5, indicators: ["Example of a large case acceptance"] },
        { key: "productivity", name: "Productivity", definition: "Meets the practice's production expectations without overtreatment.", weight: 4, indicators: ["Typical daily production"] },
        { key: "team", name: "Team leadership at the chair", definition: "Works well with hygienists and assistants.", weight: 4, indicators: ["How they set up their team"] },
      ],
      screeningQuestions: [
        { key: "mix", question: "Which procedures do you do routinely, and which do you refer out?", kind: "skills", competencyKey: "clinical_range" },
        { key: "acceptance", question: "Tell me about a treatment plan a patient was hesitant about and how you handled it.", kind: "behavioral", competencyKey: "case_presentation" },
        { key: "production", question: "What was your typical daily production in your last practice, and what supported it?", kind: "skills", competencyKey: "productivity" },
        { key: "availability", question: "Which days are you available and when could you start?", kind: "availability" },
        { key: "pay", question: "What compensation structure are you looking for (daily guarantee, percentage of production)?", kind: "compensation" },
      ],
      interviewPlan: [
        { key: "owner", title: "Conversation with the owner dentist", purpose: "Philosophy of care, expectations, growth.", durationMinutes: 45, format: "video", competencyKeys: ["case_presentation", "team"] },
        { key: "onsite", title: "Office visit and case review", purpose: "Review cases, meet the team, see the operatories.", durationMinutes: 120, format: "onsite", competencyKeys: ["clinical_range", "productivity"] },
      ],
      redFlags: ["Overtreatment signals in case discussion", "Cannot discuss production concretely"],
      candidateObjections: [{ objection: "The guarantee is low.", response: "Explain the production potential with real numbers from the practice and the ramp." }],
      compensation: [
        { metro: "Los Angeles-Long Beach-Anaheim, CA", basis: "salary", p25: 170000, p50: 200000, p75: 240000, source: "ITS market observation Sep 2026 (daily guarantee against 30 to 35% of collections); review before quoting", asOf: "2026-09" },
        { metro: "US national", basis: "salary", p25: 150000, p50: 185000, p75: 225000, source: "ITS market observation Sep 2026; review before quoting", asOf: "2026-09" },
      ],
      benchmarks: { applicantsPerHire: 8, screensPerHire: 4, interviewsPerHire: 3, medianDaysToFill: 60 },
      channels: ["indeed", "careers_page", "google_jobs", "associations", "schools", "referrals"],
    },
  ],
};

export const dentalPlaybook: PlaybookT = Playbook.parse(dental);
