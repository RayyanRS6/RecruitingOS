/**
 * Sample questions for tests: AI interview questions and application-form questions as jobs of two kinds of business
 * word them, grouped by job. Synthetic; nothing in the product reads them.
 */
export type SampleJobQuestions = { key: string; screeningQuestions: Array<{ key: string; question: string; kind: string }>; formQuestions: Array<{ question: string }> };

export const SAMPLE_QUESTIONS: Array<{ vertical: string; roles: SampleJobQuestions[] }> = [
  {
    vertical: "consumer",
    roles: [
      {
        key: "performance_marketing_manager",
        screeningQuestions: [
          { key: "scope", question: "What channels and monthly budget did you personally manage in your most recent role, and what target were you held to?", kind: "skills" },
          { key: "test", question: "Tell me about a creative or landing page test you ran: what you tested, what you learned, and what you changed.", kind: "behavioral" },
          { key: "measurement", question: "How do you decide whether a channel is really working when platform-reported numbers and blended numbers disagree?", kind: "skills" },
          { key: "margin", question: "Give an example of a time you changed spend because of margin, inventory or cash rather than performance.", kind: "behavioral" },
          { key: "work_model", question: "What work model and schedule are you looking for, and when could you start?", kind: "availability" },
          { key: "pay", question: "What salary range are you looking for, including any bonus expectations?", kind: "compensation" },
          { key: "why", question: "What are you looking for in your next role that you do not have today?", kind: "motivation" },
        ],
        formQuestions: [
          { question: "Are you legally authorized to work in the United States for any employer?" },
          { question: "Are you available for the posted schedule and work model?" },
        ],
      },
      {
        key: "ecommerce_manager",
        screeningQuestions: [
          { key: "store", question: "Which store(s) have you run, on what platform, and roughly what annual revenue? What were you personally responsible for?", kind: "skills" },
          { key: "conversion", question: "Tell me about the biggest conversion or AOV improvement you drove and how you did it.", kind: "behavioral" },
          { key: "retention", question: "What email or SMS flows have you built, and what did they do to repeat revenue?", kind: "skills" },
          { key: "launch", question: "Walk me through how you run a product launch or a big promotion from plan to post-mortem.", kind: "skills" },
          { key: "work_model", question: "What work model and schedule are you looking for, and when could you start?", kind: "availability" },
          { key: "pay", question: "What salary range are you looking for?", kind: "compensation" },
          { key: "why", question: "What are you looking for in your next role?", kind: "motivation" },
        ],
        formQuestions: [
          { question: "Are you legally authorized to work in the United States for any employer?" },
          { question: "Are you available for the posted schedule and work model?" },
        ],
      },
      {
        key: "social_content_manager",
        screeningQuestions: [
          { key: "accounts", question: "Which brand accounts have you run, and what did they look like before and after you?", kind: "skills" },
          { key: "piece", question: "Tell me about a piece of content you made that outperformed. Why did it work?", kind: "behavioral" },
          { key: "creators", question: "How do you find, brief and pay creators?", kind: "skills" },
          { key: "work_model", question: "What work model and schedule are you looking for, and when could you start?", kind: "availability" },
          { key: "pay", question: "What salary range are you looking for?", kind: "compensation" },
          { key: "why", question: "What are you looking for in your next role?", kind: "motivation" },
        ],
        formQuestions: [
          { question: "Are you legally authorized to work in the United States for any employer?" },
          { question: "Are you available for the posted schedule and work model?" },
        ],
      },
      {
        key: "customer_success_manager",
        screeningQuestions: [
          { key: "book", question: "What did you own in your most recent role: how many customers or tickets, what target, and how did it go?", kind: "skills" },
          { key: "save", question: "Tell me about a customer you saved, or lost, and what you learned.", kind: "behavioral" },
          { key: "process", question: "What is a process you built that made the team better?", kind: "skills" },
          { key: "work_model", question: "What work model and schedule are you looking for, and when could you start?", kind: "availability" },
          { key: "pay", question: "What salary range are you looking for?", kind: "compensation" },
          { key: "why", question: "What are you looking for in your next role?", kind: "motivation" },
        ],
        formQuestions: [
          { question: "Are you legally authorized to work in the United States for any employer?" },
          { question: "Are you available for the posted schedule and work model?" },
        ],
      },
      {
        key: "account_executive",
        screeningQuestions: [
          { key: "quota", question: "What was your quota in your last two years, and what did you attain?", kind: "skills" },
          { key: "deal", question: "Tell me about the hardest deal you closed: how it started, what almost killed it, how you closed it.", kind: "behavioral" },
          { key: "prospecting", question: "How do you build pipeline when nobody is handing you leads?", kind: "skills" },
          { key: "work_model", question: "What work model and schedule are you looking for, and when could you start?", kind: "availability" },
          { key: "pay", question: "What base and on-target earnings are you looking for?", kind: "compensation" },
          { key: "why", question: "What are you looking for in your next role?", kind: "motivation" },
        ],
        formQuestions: [
          { question: "Are you legally authorized to work in the United States for any employer?" },
          { question: "Are you available for the posted schedule and work model, including any travel stated in the posting?" },
        ],
      },
      {
        key: "operations_manager",
        screeningQuestions: [
          { key: "scope", question: "What did you own operationally in your last role: volumes, vendors, team, budget?", kind: "skills" },
          { key: "fix", question: "Tell me about a recurring problem you eliminated. How did you find the root cause?", kind: "behavioral" },
          { key: "vendor", question: "Describe a vendor negotiation or replacement you led and the outcome.", kind: "skills" },
          { key: "work_model", question: "What work model and schedule are you looking for, and when could you start?", kind: "availability" },
          { key: "pay", question: "What salary range are you looking for?", kind: "compensation" },
          { key: "why", question: "What are you looking for in your next role?", kind: "motivation" },
        ],
        formQuestions: [
          { question: "Are you legally authorized to work in the United States for any employer?" },
          { question: "Are you available for the posted schedule and work model?" },
        ],
      },
    ],
  },
  {
    vertical: "dental",
    roles: [
      {
        key: "rdh",
        screeningQuestions: [
          { key: "license_confirm", question: "Is your RDH license active in the state this office is in?", kind: "eligibility" },
          { key: "perio", question: "Walk me through how you handle a new patient with generalized moderate periodontitis.", kind: "skills" },
          { key: "anxious", question: "Tell me about a time a patient was anxious or resistant. What did you do?", kind: "behavioral" },
          { key: "schedule", question: "What appointment length are you used to for an adult prophy, and how do you handle running behind?", kind: "skills" },
          { key: "software", question: "Which practice management systems have you used?", kind: "skills" },
          { key: "availability", question: "Which days and hours are you available, and when could you start?", kind: "availability" },
          { key: "pay", question: "What hourly range are you looking for?", kind: "compensation" },
          { key: "why", question: "What are you looking for in your next office?", kind: "motivation" },
        ],
        formQuestions: [
          { question: "Do you hold an active dental hygiene (RDH) license in the state where this office is located?" },
          { question: "Do you hold current CPR/BLS certification?" },
          { question: "Are you available for the days this office is open?" },
        ],
      },
      {
        key: "da",
        screeningQuestions: [
          { key: "certs", question: "Which certifications do you hold (x-ray, coronal polishing, RDA, BLS)?", kind: "eligibility" },
          { key: "procedures", question: "Which procedures are you most comfortable assisting with, and which would you want more training on?", kind: "skills" },
          { key: "steri", question: "Describe your sterilization routine between patients.", kind: "skills" },
          { key: "nervous", question: "Tell me about a patient who was nervous. What did you do?", kind: "behavioral" },
          { key: "availability", question: "Which days and hours are you available, and when could you start?", kind: "availability" },
          { key: "pay", question: "What hourly range are you looking for?", kind: "compensation" },
        ],
        formQuestions: [
          { question: "Do you hold an active Registered Dental Assistant (RDA) license in the state where this office is located?" },
          { question: "Do you hold a current radiation safety / x-ray certification and CPR/BLS?" },
          { question: "Are you available for the days this office is open?" },
        ],
      },
      {
        key: "front_office",
        screeningQuestions: [
          { key: "cancel", question: "A patient cancels a two-hour appointment tomorrow morning. What do you do?", kind: "skills" },
          { key: "upset", question: "Tell me about an upset patient and how you handled it.", kind: "behavioral" },
          { key: "insurance", question: "How do you explain to a patient that their insurance covers less than they expected?", kind: "skills" },
          { key: "software", question: "Which practice management systems have you used?", kind: "skills" },
          { key: "availability", question: "Which days and hours are you available, and when could you start?", kind: "availability" },
          { key: "pay", question: "What hourly range are you looking for?", kind: "compensation" },
        ],
        formQuestions: [
          { question: "Are you available for the days and hours this office is open?" },
        ],
      },
      {
        key: "office_manager",
        screeningQuestions: [
          { key: "numbers", question: "Which numbers did you watch daily and monthly in your last practice, and where were they?", kind: "skills" },
          { key: "team", question: "Tell me about a team member you had to coach or let go.", kind: "behavioral" },
          { key: "process", question: "Describe a process you changed that improved the practice.", kind: "behavioral" },
          { key: "availability", question: "When could you start?", kind: "availability" },
          { key: "pay", question: "What compensation are you looking for?", kind: "compensation" },
        ],
        formQuestions: [
          { question: "Are you available for the office's full schedule?" },
        ],
      },
      {
        key: "associate_dentist",
        screeningQuestions: [
          { key: "mix", question: "Which procedures do you do routinely, and which do you refer out?", kind: "skills" },
          { key: "acceptance", question: "Tell me about a treatment plan a patient was hesitant about and how you handled it.", kind: "behavioral" },
          { key: "production", question: "What was your typical daily production in your last practice, and what supported it?", kind: "skills" },
          { key: "availability", question: "Which days are you available and when could you start?", kind: "availability" },
          { key: "pay", question: "What compensation structure are you looking for (daily guarantee, percentage of production)?", kind: "compensation" },
        ],
        formQuestions: [
          { question: "Do you hold an active dental license (DDS/DMD) in the state where this office is located?" },
          { question: "Do you hold a current DEA registration and CPR/BLS?" },
        ],
      },
    ],
  },
];
