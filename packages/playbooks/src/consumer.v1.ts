import { Playbook, type Playbook as PlaybookT, type PlaybookInput } from "@ros/contracts";

/**
 * Consumer, beauty, e-commerce, creative and marketing playbook, version 1: the launch wedge in the founder
 * context (docs/FOUNDER-CONTEXT.md §06). Knowledge-worker roles with observable work history and no licensing.
 * Compensation figures are ITS market observations cross-checked against BLS OEWS occupational medians and must be
 * reviewed before a customer relies on them (each entry names its source and date). Customers override on the packet.
 */
const consumer: PlaybookInput = {
  vertical: "consumer",
  version: 1,
  name: "Consumer brands, e-commerce, creative and marketing teams",
  summary:
    "Founder-led and professionally managed consumer, beauty, retail/e-commerce, creative and marketing companies with 25 to 250 people. Hiring is fragmented across managers and agencies; roles are repeatable knowledge work where evidence lives in results, scope and trajectory rather than credentials.",
  authoredBy: "Identified Talent Solutions",
  reviewedAt: "2026-09-14",
  generalRedFlags: [
    "Titles that outrun scope (ask what they personally owned, budget size, team size)",
    "Results with no numbers, or numbers with no context (ask for the baseline and the period)",
    "Cannot describe a decision they got wrong and what they changed",
    "Availability or work model that does not match what the owner can offer",
  ],
  communicationDefaults: {
    tone: "warm",
    candidateMayBeTold: [
      "The posted pay range and whether there is a bonus or commission component",
      "The work model (onsite, hybrid, remote) and location",
      "The interview steps and typical timeline",
      "Benefits at a summary level (as written in the packet)",
    ],
  },
  roles: [
    {
      key: "performance_marketing_manager",
      title: "Performance Marketing Manager",
      aliases: ["performance marketing manager", "growth marketing manager", "paid media manager", "digital marketing manager", "performance marketer", "growth marketer", "paid social manager", "acquisition marketing manager"],
      summary: "Owns paid acquisition across Meta, Google, TikTok and affiliates: budgets, creative testing, measurement, and the channel mix that hits a CAC or ROAS target.",
      typicalEmploymentTypes: ["full_time"],
      eligibility: [
        { type: "work_authorization", question: "Are you legally authorized to work in the United States for any employer?", expectationByJurisdiction: { "*": { authorized: true } }, rationale: "Required for employment; asked of every candidate." },
        { type: "schedule_availability", question: "Are you available for the posted schedule and work model?", expectationByJurisdiction: {}, rationale: "The owner stated the work model in the packet." },
      ],
      commonQualifications: [
        "Hands-on management of Meta and Google Ads budgets ($50k+ per month)",
        "Creative testing frameworks and landing page iteration",
        "Attribution and measurement (GA4, MTA/MMM basics, incrementality tests)",
        "Shopify or headless commerce analytics; Klaviyo or similar for retention",
        "Affiliate, influencer or marketplace channels for consumer brands",
      ],
      competencies: [
        { key: "paid_acquisition", name: "Paid acquisition craft", definition: "Runs budgets, bids, audiences and creative tests to a target with discipline.", weight: 5, indicators: ["Names channels, monthly spend and the target they owned", "Describes a test they ran and what changed because of it"] },
        { key: "measurement", name: "Measurement and judgment", definition: "Knows what the numbers can and cannot say and decides accordingly.", weight: 5, indicators: ["Explains attribution limits plainly", "Has cut a channel that looked good on paper"] },
        { key: "creative_partnership", name: "Creative partnership", definition: "Works with designers and content to keep creative fresh and on-brand.", weight: 4, indicators: ["Describes the creative testing cadence", "Example of a brief that produced a winner"] },
        { key: "commercial_ownership", name: "Commercial ownership", definition: "Ties spend to margin and inventory, not just top-of-funnel metrics.", weight: 4, indicators: ["Talks about CAC payback or contribution margin", "Adjusted plans when inventory or margin changed"] },
        { key: "communication", name: "Communication with founders", definition: "Reports clearly, flags risk early, and disagrees respectfully.", weight: 3, indicators: ["Example of pushing back on a target", "Weekly reporting they built"] },
      ],
      screeningQuestions: [
        { key: "scope", question: "What channels and monthly budget did you personally manage in your most recent role, and what target were you held to?", kind: "skills", competencyKey: "paid_acquisition", modelAnswer: "Names channels, a budget figure, and a CAC/ROAS or revenue target with the outcome." },
        { key: "test", question: "Tell me about a creative or landing page test you ran: what you tested, what you learned, and what you changed.", kind: "behavioral", competencyKey: "creative_partnership", modelAnswer: "Specific test, clear metric, a decision that followed." },
        { key: "measurement", question: "How do you decide whether a channel is really working when platform-reported numbers and blended numbers disagree?", kind: "skills", competencyKey: "measurement", modelAnswer: "Mentions blended CAC, incrementality or holdouts, and judgment about platform over-attribution." },
        { key: "margin", question: "Give an example of a time you changed spend because of margin, inventory or cash rather than performance.", kind: "behavioral", competencyKey: "commercial_ownership", modelAnswer: "Concrete example tied to business constraints." },
        { key: "work_model", question: "What work model and schedule are you looking for, and when could you start?", kind: "availability", modelAnswer: "Matches the packet's model; start within the target window." },
        { key: "pay", question: "What salary range are you looking for, including any bonus expectations?", kind: "compensation", modelAnswer: "A range; the system compares to the packet." },
        { key: "why", question: "What are you looking for in your next role that you do not have today?", kind: "motivation", modelAnswer: "Specific and consistent with the role and company stage." },
      ],
      interviewPlan: [
        { key: "hiring_manager", title: "Conversation with the hiring manager", purpose: "Scope, results, judgment, and the candidate's questions.", durationMinutes: 45, format: "video", competencyKeys: ["paid_acquisition", "measurement", "communication"], suggestedQuestions: ["Walk me through your last quarter's spend and results.", "What would you do in your first 30 days here?", "Where have you been wrong about a channel?"] },
        { key: "case", title: "Working session: plan the next quarter", purpose: "A short case with the brand's real numbers (sanitized): allocate a budget, choose tests, define what you would measure.", durationMinutes: 60, format: "video", competencyKeys: ["paid_acquisition", "commercial_ownership", "creative_partnership"], suggestedQuestions: ["How would you split this budget and why?", "What would make you change the plan in week two?"] },
        { key: "founder", title: "Conversation with the founder", purpose: "Fit with how the company makes decisions; expectations both ways.", durationMinutes: 30, format: "video", competencyKeys: ["communication", "commercial_ownership"], suggestedQuestions: ["What do you need from a founder to do your best work?", "Tell me about a disagreement with leadership and how it ended."] },
      ],
      redFlags: ["Only agency experience with no direct budget ownership when the role needs in-house ownership", "Cannot name a target they missed", "Attributes every result to the platform's reported ROAS"],
      candidateObjections: [
        { objection: "The budget is smaller than what I managed before.", response: "Be honest about scale and growth plans; emphasize ownership, speed of decisions, and direct access to the founder." },
        { objection: "I want fully remote.", response: "State the real work model early. If hybrid is required, say which days and why." },
      ],
      compensation: [
        { metro: "Los Angeles-Long Beach-Anaheim, CA", basis: "salary", p25: 95000, p50: 115000, p75: 140000, source: "ITS market observation Sep 2026, cross-checked with BLS OEWS SOC 11-2021 (marketing managers); review before quoting", asOf: "2026-09" },
        { metro: "New York-Newark-Jersey City, NY-NJ-PA", basis: "salary", p25: 100000, p50: 125000, p75: 150000, source: "ITS market observation Sep 2026, cross-checked with BLS OEWS SOC 11-2021; review before quoting", asOf: "2026-09" },
        { metro: "US national", basis: "salary", p25: 85000, p50: 105000, p75: 130000, source: "ITS market observation Sep 2026, cross-checked with BLS OEWS SOC 11-2021; review before quoting", asOf: "2026-09" },
      ],
      benchmarks: { applicantsPerHire: 80, screensPerHire: 10, interviewsPerHire: 4, medianDaysToFill: 42 },
      channels: ["linkedin_basic", "careers_page", "google_jobs", "indeed", "referrals", "rediscovery"],
      occupation: { soc: "11-2021", name: "Marketing managers", match: "close" },
    },
    {
      key: "ecommerce_manager",
      title: "E-commerce Manager",
      aliases: ["e-commerce manager", "ecommerce manager", "shopify manager", "dtc manager", "digital commerce manager", "online store manager", "head of ecommerce"],
      summary: "Owns the online store: merchandising, site conversion, promotions, retention email/SMS, and the operational handoffs to fulfillment and customer care.",
      typicalEmploymentTypes: ["full_time"],
      eligibility: [
        { type: "work_authorization", question: "Are you legally authorized to work in the United States for any employer?", expectationByJurisdiction: { "*": { authorized: true } }, rationale: "Required for employment; asked of every candidate." },
        { type: "schedule_availability", question: "Are you available for the posted schedule and work model?", expectationByJurisdiction: {}, rationale: "The owner stated the work model in the packet." },
      ],
      commonQualifications: ["Shopify (Plus) administration and apps", "Conversion rate optimization and site merchandising", "Klaviyo/Attentive retention programs", "Promotion planning and margin awareness", "Working with 3PL and customer care on order issues"],
      competencies: [
        { key: "site_conversion", name: "Site conversion and merchandising", definition: "Improves conversion and average order value with tests, merchandising and promotions.", weight: 5, indicators: ["Cites a conversion or AOV change they drove and how", "Knows the store's funnel numbers"] },
        { key: "retention", name: "Retention programs", definition: "Runs email/SMS flows and campaigns that grow repeat revenue.", weight: 4, indicators: ["Describes flows they built and results", "Segments customers sensibly"] },
        { key: "operations", name: "Operational rigor", definition: "Keeps launches, inventory, promotions and fulfillment handoffs clean.", weight: 4, indicators: ["Example of a launch checklist", "How they handle an out-of-stock or a broken checkout"] },
        { key: "analysis", name: "Analysis", definition: "Reads GA4, Shopify and finance reports and acts on them.", weight: 4, indicators: ["Weekly reporting they own", "A decision changed by data"] },
        { key: "communication", name: "Cross-functional communication", definition: "Coordinates marketing, ops and customer care without drama.", weight: 3, indicators: ["Example of resolving a cross-team problem"] },
      ],
      screeningQuestions: [
        { key: "store", question: "Which store(s) have you run, on what platform, and roughly what annual revenue? What were you personally responsible for?", kind: "skills", competencyKey: "site_conversion", modelAnswer: "Platform, scale, and clear ownership." },
        { key: "conversion", question: "Tell me about the biggest conversion or AOV improvement you drove and how you did it.", kind: "behavioral", competencyKey: "site_conversion", modelAnswer: "Specific change, metric, and result." },
        { key: "retention", question: "What email or SMS flows have you built, and what did they do to repeat revenue?", kind: "skills", competencyKey: "retention", modelAnswer: "Names flows, tools and a result." },
        { key: "launch", question: "Walk me through how you run a product launch or a big promotion from plan to post-mortem.", kind: "skills", competencyKey: "operations", modelAnswer: "Checklist thinking, cross-team coordination, review afterwards." },
        { key: "work_model", question: "What work model and schedule are you looking for, and when could you start?", kind: "availability", modelAnswer: "Matches the packet." },
        { key: "pay", question: "What salary range are you looking for?", kind: "compensation", modelAnswer: "A range." },
        { key: "why", question: "What are you looking for in your next role?", kind: "motivation", modelAnswer: "Specific and consistent." },
      ],
      interviewPlan: [
        { key: "hiring_manager", title: "Conversation with the hiring manager", purpose: "Scope, results, and how they work.", durationMinutes: 45, format: "video", competencyKeys: ["site_conversion", "retention", "communication"], suggestedQuestions: ["What did last quarter look like for your store?", "What would you change on our site in week one?"] },
        { key: "site_review", title: "Working session: site and retention review", purpose: "Review the company's store and a retention flow together; hear how they think.", durationMinutes: 60, format: "video", competencyKeys: ["site_conversion", "analysis", "operations"], suggestedQuestions: ["What are the three things you would test first?", "What would you measure to know it worked?"] },
      ],
      redFlags: ["Cannot describe the store's funnel numbers", "Only agency or platform-vendor experience when the role needs owner-operator instincts"],
      candidateObjections: [{ objection: "I have not used your platform.", response: "Ask what they have used; platform skills transfer quickly, merchandising judgment does not." }],
      compensation: [
        { metro: "Los Angeles-Long Beach-Anaheim, CA", basis: "salary", p25: 80000, p50: 98000, p75: 120000, source: "ITS market observation Sep 2026; review before quoting", asOf: "2026-09" },
        { metro: "New York-Newark-Jersey City, NY-NJ-PA", basis: "salary", p25: 85000, p50: 105000, p75: 130000, source: "ITS market observation Sep 2026; review before quoting", asOf: "2026-09" },
        { metro: "US national", basis: "salary", p25: 72000, p50: 90000, p75: 112000, source: "ITS market observation Sep 2026; review before quoting", asOf: "2026-09" },
      ],
      benchmarks: { applicantsPerHire: 70, screensPerHire: 9, interviewsPerHire: 4, medianDaysToFill: 40 },
      channels: ["linkedin_basic", "careers_page", "google_jobs", "indeed", "referrals", "rediscovery"],
      // No occupation of its own: read as marketing managers, who usually run whole teams, so only a rough guide.
      occupation: { soc: "11-2021", name: "Marketing managers", match: "approximate" },
    },
    {
      key: "social_content_manager",
      title: "Social and Content Marketing Manager",
      aliases: ["social media manager", "content marketing manager", "social content manager", "community manager", "content manager", "social media marketing manager", "brand content manager"],
      summary: "Owns organic social, content calendar, creator and community programs, and the brand voice across channels.",
      typicalEmploymentTypes: ["full_time", "part_time", "contract"],
      eligibility: [
        { type: "work_authorization", question: "Are you legally authorized to work in the United States for any employer?", expectationByJurisdiction: { "*": { authorized: true } }, rationale: "Required for employment; asked of every candidate." },
        { type: "schedule_availability", question: "Are you available for the posted schedule and work model?", expectationByJurisdiction: {}, rationale: "The owner stated the work model in the packet." },
      ],
      commonQualifications: ["Instagram, TikTok and YouTube growth for a brand", "Creator and UGC programs", "Content calendars and light production (Canva, CapCut, Figma)", "Community management and reply tone", "Reporting on reach, engagement and conversion from social"],
      competencies: [
        { key: "content_craft", name: "Content craft", definition: "Makes content people watch and share, in the brand's voice.", weight: 5, indicators: ["Portfolio or accounts they grew", "Describes what made a piece work"] },
        { key: "channel_growth", name: "Channel growth", definition: "Grows followers and engagement that turn into customers.", weight: 4, indicators: ["Numbers with a period and baseline", "Knows what did not work"] },
        { key: "creator_programs", name: "Creator and community programs", definition: "Runs creators, UGC and community with clear briefs and fair terms.", weight: 4, indicators: ["Example brief", "How they pick and pay creators"] },
        { key: "judgment", name: "Brand judgment", definition: "Knows when a trend fits the brand and when to sit it out.", weight: 4, indicators: ["A trend they skipped and why"] },
      ],
      screeningQuestions: [
        { key: "accounts", question: "Which brand accounts have you run, and what did they look like before and after you?", kind: "skills", competencyKey: "channel_growth", modelAnswer: "Named accounts, baseline, result, period." },
        { key: "piece", question: "Tell me about a piece of content you made that outperformed. Why did it work?", kind: "behavioral", competencyKey: "content_craft", modelAnswer: "Specific, insight into audience and format." },
        { key: "creators", question: "How do you find, brief and pay creators?", kind: "skills", competencyKey: "creator_programs", modelAnswer: "A process, a brief structure, fair terms." },
        { key: "work_model", question: "What work model and schedule are you looking for, and when could you start?", kind: "availability", modelAnswer: "Matches the packet." },
        { key: "pay", question: "What salary range are you looking for?", kind: "compensation", modelAnswer: "A range." },
        { key: "why", question: "What are you looking for in your next role?", kind: "motivation", modelAnswer: "Specific and consistent." },
      ],
      interviewPlan: [
        { key: "hiring_manager", title: "Conversation with the hiring manager", purpose: "Portfolio walk-through and how they work.", durationMinutes: 45, format: "video", competencyKeys: ["content_craft", "channel_growth", "judgment"], suggestedQuestions: ["Walk me through three pieces you are proud of.", "What would you post for us this week?"] },
        { key: "brief", title: "Take-home: a one-week content plan", purpose: "A short, paid exercise on the brand's real channels.", durationMinutes: 30, format: "video", competencyKeys: ["content_craft", "creator_programs"], suggestedQuestions: ["Why these formats?", "How would you measure it?"] },
      ],
      redFlags: ["Growth numbers without a period or baseline", "Cannot show any work"],
      candidateObjections: [{ objection: "I want creative freedom.", response: "Describe how decisions get made and where they would own the call." }],
      compensation: [
        { metro: "Los Angeles-Long Beach-Anaheim, CA", basis: "salary", p25: 62000, p50: 75000, p75: 92000, source: "ITS market observation Sep 2026, cross-checked with BLS OEWS SOC 13-1161; review before quoting", asOf: "2026-09" },
        { metro: "US national", basis: "salary", p25: 55000, p50: 68000, p75: 85000, source: "ITS market observation Sep 2026, cross-checked with BLS OEWS SOC 13-1161; review before quoting", asOf: "2026-09" },
      ],
      benchmarks: { applicantsPerHire: 120, screensPerHire: 12, interviewsPerHire: 4, medianDaysToFill: 35 },
      channels: ["linkedin_basic", "careers_page", "google_jobs", "indeed", "referrals", "rediscovery"],
      // No occupation of its own: government figures for marketing specialists are the closest (marketing managers,
      // 11-2021, run whole teams and would overstate the market), so they are told as a rough guide.
      occupation: { soc: "13-1161", name: "Market research analysts and marketing specialists", match: "approximate" },
    },
    {
      key: "customer_success_manager",
      title: "Customer Success Manager",
      aliases: ["customer success manager", "customer success", "client success manager", "account manager", "customer experience manager", "customer care manager"],
      summary: "Owns retention and growth of a book of customers or the customer care function: onboarding, health, renewals and the voice of the customer.",
      typicalEmploymentTypes: ["full_time"],
      eligibility: [
        { type: "work_authorization", question: "Are you legally authorized to work in the United States for any employer?", expectationByJurisdiction: { "*": { authorized: true } }, rationale: "Required for employment; asked of every candidate." },
        { type: "schedule_availability", question: "Are you available for the posted schedule and work model?", expectationByJurisdiction: {}, rationale: "The owner stated the work model in the packet." },
      ],
      commonQualifications: ["Owned renewals or retention targets", "Onboarding and QBR programs", "Helpdesk or CRM tools (Gorgias, Zendesk, HubSpot)", "Escalation handling", "Reporting on churn, NPS and response times"],
      competencies: [
        { key: "retention_ownership", name: "Retention ownership", definition: "Holds a number and moves it.", weight: 5, indicators: ["A retention or renewal target with the result", "What they did when an account was at risk"] },
        { key: "customer_communication", name: "Customer communication", definition: "Clear, calm and specific with customers, including bad news.", weight: 5, indicators: ["A hard conversation and how it ended"] },
        { key: "process", name: "Process building", definition: "Turns repeated problems into playbooks.", weight: 4, indicators: ["A process they created", "Metrics they track"] },
        { key: "cross_functional", name: "Voice of the customer", definition: "Brings customer signal to product, ops and marketing.", weight: 3, indicators: ["A change that came from customer feedback they surfaced"] },
      ],
      screeningQuestions: [
        { key: "book", question: "What did you own in your most recent role: how many customers or tickets, what target, and how did it go?", kind: "skills", competencyKey: "retention_ownership", modelAnswer: "Scale, target, result." },
        { key: "save", question: "Tell me about a customer you saved, or lost, and what you learned.", kind: "behavioral", competencyKey: "customer_communication", modelAnswer: "Specific, honest, a lesson." },
        { key: "process", question: "What is a process you built that made the team better?", kind: "skills", competencyKey: "process", modelAnswer: "Concrete process and effect." },
        { key: "work_model", question: "What work model and schedule are you looking for, and when could you start?", kind: "availability", modelAnswer: "Matches the packet." },
        { key: "pay", question: "What salary range are you looking for?", kind: "compensation", modelAnswer: "A range." },
        { key: "why", question: "What are you looking for in your next role?", kind: "motivation", modelAnswer: "Specific and consistent." },
      ],
      interviewPlan: [
        { key: "hiring_manager", title: "Conversation with the hiring manager", purpose: "Scope, results and style.", durationMinutes: 45, format: "video", competencyKeys: ["retention_ownership", "customer_communication"], suggestedQuestions: ["How do you spot an account at risk early?", "What do you need from us to hit the number?"] },
        { key: "roleplay", title: "Working session: two customer scenarios", purpose: "A renewal conversation and an escalation, live.", durationMinutes: 45, format: "video", competencyKeys: ["customer_communication", "process", "cross_functional"], suggestedQuestions: ["How would you open this conversation?", "What would you change in our process after this?"] },
      ],
      redFlags: ["Blames customers or teammates for churn", "No numbers at all"],
      candidateObjections: [{ objection: "Is this a support job or a success job?", response: "Say plainly what the day looks like and what the number is." }],
      compensation: [
        { metro: "Los Angeles-Long Beach-Anaheim, CA", basis: "salary", p25: 65000, p50: 80000, p75: 98000, source: "ITS market observation Sep 2026; review before quoting", asOf: "2026-09" },
        { metro: "US national", basis: "salary", p25: 58000, p50: 72000, p75: 90000, source: "ITS market observation Sep 2026; review before quoting", asOf: "2026-09" },
      ],
      benchmarks: { applicantsPerHire: 90, screensPerHire: 10, interviewsPerHire: 4, medianDaysToFill: 35 },
      channels: ["linkedin_basic", "careers_page", "google_jobs", "indeed", "referrals", "rediscovery"],
    },
    {
      key: "account_executive",
      title: "Account Executive",
      aliases: ["account executive", "sales representative", "sales rep", "business development representative", "sales executive", "wholesale sales manager", "sales manager"],
      summary: "Owns new revenue: prospecting, pipeline, demos or meetings, and closing, for wholesale, B2B or partnership channels.",
      typicalEmploymentTypes: ["full_time"],
      eligibility: [
        { type: "work_authorization", question: "Are you legally authorized to work in the United States for any employer?", expectationByJurisdiction: { "*": { authorized: true } }, rationale: "Required for employment; asked of every candidate." },
        { type: "schedule_availability", question: "Are you available for the posted schedule and work model, including any travel stated in the posting?", expectationByJurisdiction: {}, rationale: "The owner stated the work model and travel in the packet." },
      ],
      commonQualifications: ["Quota ownership with attainment history", "Outbound prospecting and CRM hygiene (HubSpot, Salesforce)", "Retail buyer, distributor or B2B relationships in the category", "Negotiating terms and pricing", "Trade show and line-review experience for consumer brands"],
      competencies: [
        { key: "pipeline", name: "Pipeline generation", definition: "Builds their own pipeline without waiting for leads.", weight: 5, indicators: ["Outbound numbers and conversion", "How they prioritize accounts"] },
        { key: "closing", name: "Closing and negotiation", definition: "Gets to a decision, holds price, and knows when to walk.", weight: 5, indicators: ["A deal they closed against odds", "A deal they walked from"] },
        { key: "category_knowledge", name: "Category knowledge", definition: "Knows the buyers, channels and terms in the category.", weight: 4, indicators: ["Names accounts and buyers they have worked with"] },
        { key: "rigor", name: "Rigor", definition: "Forecasts honestly and keeps the CRM true.", weight: 3, indicators: ["Forecast accuracy", "Weekly cadence"] },
      ],
      screeningQuestions: [
        { key: "quota", question: "What was your quota in your last two years, and what did you attain?", kind: "skills", competencyKey: "closing", modelAnswer: "Numbers, honestly stated, with context." },
        { key: "deal", question: "Tell me about the hardest deal you closed: how it started, what almost killed it, how you closed it.", kind: "behavioral", competencyKey: "closing", modelAnswer: "Specific and self-aware." },
        { key: "prospecting", question: "How do you build pipeline when nobody is handing you leads?", kind: "skills", competencyKey: "pipeline", modelAnswer: "A repeatable process with numbers." },
        { key: "work_model", question: "What work model and schedule are you looking for, and when could you start?", kind: "availability", modelAnswer: "Matches the packet." },
        { key: "pay", question: "What base and on-target earnings are you looking for?", kind: "compensation", modelAnswer: "A range for base and OTE." },
        { key: "why", question: "What are you looking for in your next role?", kind: "motivation", modelAnswer: "Specific and consistent." },
      ],
      interviewPlan: [
        { key: "hiring_manager", title: "Conversation with the hiring manager", purpose: "Track record, style and fit with the sales motion.", durationMinutes: 45, format: "video", competencyKeys: ["pipeline", "closing", "rigor"], suggestedQuestions: ["Walk me through your pipeline last quarter.", "What would your first 90 days look like?"] },
        { key: "pitch", title: "Working session: pitch and objection handling", purpose: "Sell our product to the interviewer as a buyer; handle two objections.", durationMinutes: 45, format: "video", competencyKeys: ["closing", "category_knowledge"], suggestedQuestions: ["How would you open with this buyer?", "What terms would you protect?"] },
      ],
      redFlags: ["Vague about attainment", "Cannot name a deal they lost and why"],
      candidateObjections: [{ objection: "What is the comp plan really like?", response: "Share the plan structure, typical attainment and the ramp honestly." }],
      compensation: [
        { metro: "Los Angeles-Long Beach-Anaheim, CA", basis: "salary", p25: 65000, p50: 80000, p75: 100000, source: "Base salary only; ITS market observation Sep 2026, cross-checked with BLS OEWS SOC 41-4012; review before quoting", asOf: "2026-09" },
        { metro: "US national", basis: "salary", p25: 58000, p50: 72000, p75: 92000, source: "Base salary only; ITS market observation Sep 2026, cross-checked with BLS OEWS SOC 41-4012; review before quoting", asOf: "2026-09" },
      ],
      benchmarks: { applicantsPerHire: 60, screensPerHire: 10, interviewsPerHire: 4, medianDaysToFill: 45 },
      channels: ["linkedin_basic", "careers_page", "google_jobs", "indeed", "referrals", "rediscovery"],
    },
    {
      key: "operations_manager",
      title: "Operations Manager",
      aliases: ["operations manager", "ops manager", "head of operations", "supply chain manager", "fulfillment manager", "business operations manager"],
      summary: "Owns how the business runs day to day: inventory, fulfillment, vendors, systems, and the processes that keep customers and the team unblocked.",
      typicalEmploymentTypes: ["full_time"],
      eligibility: [
        { type: "work_authorization", question: "Are you legally authorized to work in the United States for any employer?", expectationByJurisdiction: { "*": { authorized: true } }, rationale: "Required for employment; asked of every candidate." },
        { type: "schedule_availability", question: "Are you available for the posted schedule and work model?", expectationByJurisdiction: {}, rationale: "The owner stated the work model in the packet." },
      ],
      commonQualifications: ["Inventory planning and 3PL or warehouse management", "Vendor and freight negotiation", "Systems (ERP, Shopify, inventory tools) and reporting", "Process documentation and team training", "Budget ownership"],
      competencies: [
        { key: "execution", name: "Execution", definition: "Gets things done on time with few surprises.", weight: 5, indicators: ["A launch or move they ran", "How they track work"] },
        { key: "systems_thinking", name: "Systems thinking", definition: "Fixes root causes and builds processes that last.", weight: 5, indicators: ["A recurring problem they eliminated"] },
        { key: "vendor_management", name: "Vendor and cost management", definition: "Negotiates well and holds partners to account.", weight: 4, indicators: ["A cost they reduced", "A vendor they replaced and why"] },
        { key: "communication", name: "Communication", definition: "Keeps the team and founder informed without noise.", weight: 3, indicators: ["Reporting cadence they own"] },
      ],
      screeningQuestions: [
        { key: "scope", question: "What did you own operationally in your last role: volumes, vendors, team, budget?", kind: "skills", competencyKey: "execution", modelAnswer: "Concrete scope with numbers." },
        { key: "fix", question: "Tell me about a recurring problem you eliminated. How did you find the root cause?", kind: "behavioral", competencyKey: "systems_thinking", modelAnswer: "Root cause, fix, durable result." },
        { key: "vendor", question: "Describe a vendor negotiation or replacement you led and the outcome.", kind: "skills", competencyKey: "vendor_management", modelAnswer: "Specific with numbers." },
        { key: "work_model", question: "What work model and schedule are you looking for, and when could you start?", kind: "availability", modelAnswer: "Matches the packet." },
        { key: "pay", question: "What salary range are you looking for?", kind: "compensation", modelAnswer: "A range." },
        { key: "why", question: "What are you looking for in your next role?", kind: "motivation", modelAnswer: "Specific and consistent." },
      ],
      interviewPlan: [
        { key: "hiring_manager", title: "Conversation with the hiring manager", purpose: "Scope, wins, and how they run a week.", durationMinutes: 45, format: "video", competencyKeys: ["execution", "communication"], suggestedQuestions: ["What does your weekly operating rhythm look like?", "What would you audit first here?"] },
        { key: "case", title: "Working session: an operations problem", purpose: "A real (sanitized) issue such as a stockout or a 3PL failure; hear how they diagnose and act.", durationMinutes: 60, format: "onsite", competencyKeys: ["systems_thinking", "vendor_management"], suggestedQuestions: ["What do you do in the first hour?", "What do you change so it never happens again?"] },
      ],
      redFlags: ["Describes firefighting with no prevention", "No numbers on volume or cost"],
      candidateObjections: [{ objection: "How much of this is hands-on?", response: "Be specific about the mix of doing and managing at this stage." }],
      compensation: [
        { metro: "Los Angeles-Long Beach-Anaheim, CA", basis: "salary", p25: 80000, p50: 98000, p75: 120000, source: "ITS market observation Sep 2026, cross-checked with BLS OEWS SOC 11-1021; review before quoting", asOf: "2026-09" },
        { metro: "US national", basis: "salary", p25: 72000, p50: 90000, p75: 112000, source: "ITS market observation Sep 2026, cross-checked with BLS OEWS SOC 11-1021; review before quoting", asOf: "2026-09" },
      ],
      benchmarks: { applicantsPerHire: 70, screensPerHire: 9, interviewsPerHire: 4, medianDaysToFill: 40 },
      channels: ["linkedin_basic", "careers_page", "google_jobs", "indeed", "referrals", "rediscovery"],
    },
  ],
};

export const consumerPlaybook: PlaybookT = Playbook.parse(consumer);
