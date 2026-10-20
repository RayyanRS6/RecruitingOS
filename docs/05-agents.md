# 05. Agent specifications

Seven agents and one orchestrator. Each agent is a module in `packages/agents` with: a purpose, the workflow it owns, its inputs (always including the role packet version), its tools, its structured outputs (Zod schemas in `packages/contracts`), its model tier, the policy actions it may propose, its failure modes, and its evaluation set. Agents never call each other and never keep state outside the system of record. They run inside workflow steps.

## Shared conventions

- **Actor identity.** Agent actions carry `actor = {kind: 'agent', id: '<agent>', run: <ai_run_id>}` on every event and record.
- **Evidence.** Any claim about a candidate cites a source (`resume`, `application`, `screen`, `interview`, `candidate_statement`, `verified`) and, where possible, the span or quote. Unsupported claims are not allowed by the schema.
- **Uncertainty.** Every assessment carries `confidence` and an `unknowns[]` list. Low confidence routes to a human.
- **Protected characteristics.** Prompts instruct the model to ignore and never infer age, race, sex, national origin, disability, religion, family status, and their proxies (graduation years, zip codes, names, photos). The eval suite tests this.
- **Disclosure.** Any candidate-facing text an agent drafts includes the disclosure the packet's communication policy specifies; the Coordinator enforces it before sending.

## Recruiting Operations Orchestrator

- **Purpose.** Owns the overall workflow for a company: watches the event log, dispatches work, composes the morning brief, runs detectors and the intervention ladder, answers the owner's questions.
- **Owns.** `daily_brief`, `stuck_role_detector`, `owner_conversation`.
- **Inputs.** The last 24 hours of events, open approval requests, pipeline counts by stage, interviews in the window, offers outstanding, upcoming starts, detector results.
- **Tools.** Read-only queries over the system of record; `create_approval_request`; `create_intervention`; `create_escalation`; `dispatch_workflow`.
- **Outputs.** `Brief` (sections: new applicants, top candidates with evidence, needs review, interviews today, decisions needed, offers, candidates at risk, roles stuck, upcoming starts); `OwnerReply` with `proposed_actions[]` each mapped to a policy action type.
- **Model tier.** `judgment` for the brief and owner replies; `fast` for detector summaries.
- **Policy.** It never executes; it proposes. Proposals go through the policy engine like any agent's.
- **Failure modes.** Stale data (guard: compose from a snapshot with a timestamp); over-nudging (guard: ladder thresholds and cooldowns are policies); answering with invented facts (guard: replies must cite record ids the UI can link).
- **Evals.** Brief accuracy against a fixture event stream; reply grounding (every claim resolves to a record).

## Intake Agent

- **Purpose.** Turn an owner's description into a calibrated, complete Role Packet through a conversation that asks what an experienced recruiter would ask.
- **Owns.** `intake_to_packet` workflow.
- **Inputs.** The owner's messages, company profile (vertical, locations, size, benefits, prior roles), the vertical playbook, compensation benchmarks (BLS OEWS and playbook ranges), prior packets for similar titles in the tenant.
- **Tools.** `lookup_playbook_role(title)`, `comp_benchmark(title, metro, basis)`, `similar_past_roles(title)`, `propose_packet(packet)`.
- **Turn schema (`IntakeTurn`).** `{assistant_message, facts_extracted, missing_facts[], next_questions[] (max 3), ready_to_compile: boolean, confidence}`. The agent must ask about: reason for the hire, must-have versus nice-to-have, eligibility (license, authorization, schedule), compensation ceiling and basis, location and schedule, interviewers and decision maker, timeline, what failure looks like, and any deal-breakers in the owner's words. It stops asking when `missing_facts` is empty or the owner says "just draft it," in which case it drafts with explicit assumptions listed.
- **Compile schema.** A full `RolePacket` with `provenance.assumptions[]` and `provenance.sources[]`.
- **Model tier.** `judgment`.
- **Policy.** `role_packet.propose` (auto) → `role_packet.approve` (approval, owner or hiring manager).
- **Failure modes.** Wish-list must-haves (guard: the schema caps must-haves at six and forces a rationale each); protected-class proxies in eligibility (guard: eligibility types are an enum: license, certification, work_authorization, schedule_availability, physical_requirement_bona_fide, location_radius, start_date; free text is rejected); invented compensation (guard: every comp range cites a source or is marked "owner-stated").
- **Evals.** Golden intakes per vertical (dental hygienist, dental front office, HVAC tech, marketing director); question-coverage tests; must-have discipline; comp sourcing; assumption disclosure; refusal to encode illegal criteria ("under 30," "no gaps," "native English speaker").

## Triage Agent

- **Purpose.** For every application, extract what the evidence supports, apply the owner's eligibility rules, and produce an evidence-based assessment against the packet.
- **Owns.** `application_triage` workflow.
- **Inputs.** Resume text (or PDF), application answers, packet version, any prior applications by the same candidate in the tenant, duplicate and fraud signals.
- **Tools.** `extract_resume(document)` (fast tier, `ResumeExtraction` schema), `evaluate_eligibility(rules, facts)` (deterministic code, not the model), `assess_fit(packet, facts)`, `detect_anomalies(facts)`.
- **Output (`EvidenceAssessment`).** `{overall: strong|potential|weak|unknown, confidence, strengths[{claim, evidence:{source, quote|ref}}], concerns[{claim, evidence}], unknowns[{question, why_it_matters}], competency_findings[{competency, finding, evidence}], eligibility: {passed, failed_rules[], unverifiable[]}, anomalies[{kind, detail}], recommendation: screen|hold|review_manually, rationale}`. The model writes no number (plan 0.9: `secondary_score` is no longer requested; the column stays empty). Code then checks every quote (`applyEvidenceRules` in `packages/agents/src/triage.ts`): a quote not in the source is dropped or stripped, a must-have "no" stands only on a verified quote, a claim with nothing quoted is marked "no quote", and the confidence steps down one level when any of that happens.
- **Model tier.** `fast` for extraction, `standard` for assessment.
- **Policy.** `application.triage` (auto, as information); `application.reject_ineligible` (auto_notify with a daily review window, only on owner-authored eligibility rules); `application.invite_screen` (fixed at auto since 20 October 2026, R20-4: every applicant's AI interview goes by itself); `application.reject_on_assessment` (human_only, always).
- **Failure modes.** Penalizing gaps, career changes, or non-traditional paths (guard: prompt and evals); overweighting keywords (guard: competency findings must cite evidence); hallucinated experience (guard: quotes must appear in the source text, verified in code); AI-generated resumes (guard: anomaly detection flags, never rejects).
- **Evals.** The edge-case suite in doc 11: non-traditional path, employment gap, overqualified, skills without degree, career changer, international experience, ambiguous resume, AI-generated resume, contradictory information, "should not be auto-rejected."

## Screening Agent

- **Purpose.** Conduct a structured, disclosed, short screening conversation by text (SMS or web) and later voice, and produce a scorecard with quoted evidence.
- **Owns.** `screen` workflow (invite → conduct → assess).
- **Inputs.** Packet screening questions and model answers, the application's assessment (to focus follow-ups on unknowns), candidate consent and channel preferences.
- **Tools.** `send_message`, `receive_message` (via the Coordinator's channel adapters), `record_answer`, `offer_human_alternative`, `finalize_screen`.
- **Turn schema (`ScreenTurn`).** `{message_to_candidate, question_key|null, answer_recorded|null, follow_up_reason|null, done, human_requested}`. Rules: disclose AI at the first message; one question at a time; at most two follow-ups per question; never ask about protected characteristics; compensation is asked as "what range are you looking for"; offer "reply HUMAN" in the first and last messages.
- **Output (`ScreenAssessment`).** Per-question findings with quotes, competency ratings with evidence, compensation expectation, availability, eligibility confirmations, overall recommendation (strong_interview, interview, hold, decline_recommended), confidence, unknowns.
- **Model tier.** `standard`.
- **Policy.** `screen.conduct` (auto, given consent); `screen.assess` (auto as information); advancing or declining are separate human or policy-gated actions.
- **Failure modes.** Candidate distress or confusion (guard: sentiment check each turn; hand to human on request or on two consecutive confusions); candidate asks about pay or process (guard: answers only from the packet's "what candidates may be told"); message loops (guard: max turns); channel failures (guard: fall back to email link to web chat).
- **Evals.** Scripted candidate personas; disclosure presence; question coverage; refusal to answer outside policy; hand-off on HUMAN.

## Coordinator

- **Purpose.** All candidate and interviewer communication, scheduling, reminders, follow-up, and candidate Q&A.
- **Owns.** `acknowledge_application`, `schedule_interview`, `send_reminders`, `follow_up`, `candidate_question`, `disposition_message`.
- **Inputs.** Packet communication policy, candidate consent and preferences, calendar availability, interview plan, templates.
- **Tools.** Email and SMS adapters, calendar adapters, template renderer, `propose_slots`, `book_slot`, `reschedule`.
- **Outputs.** `MessageDraft` (channel, body, disclosure, template key), `SlotProposal`, `BookingResult`.
- **Model tier.** `fast` for templated messages; `standard` for free-form replies to candidate questions.
- **Policy.** `message.send_templated` (auto); `message.send_freeform` (auto_notify); `interview.schedule` (auto); `interview.reschedule` (auto_notify); `disposition.send` (auto_notify after a human decision).
- **Failure modes.** Sending without consent (guard: the adapter refuses if consent is missing for the channel); double booking (guard: re-check busy before booking; idempotent booking keys); bounces (guard: retry on the other channel, then flag); answering outside policy (guard: allowed-topics list from the packet; otherwise "I'll have someone from the team answer that" and create a task).
- **Evals.** Consent gates; disclosure on every message; slot proposal correctness across time zones; bounce handling.

## Interview Intelligence

- **Purpose.** Prepare interviewers, capture what happened, draft scorecards with evidence for humans to confirm, and facilitate the debrief.
- **Owns.** `interview_cycle` (brief → capture → draft scorecards → debrief).
- **Inputs.** Packet interview plan and scorecard template, the application's assessments and screen, the interviewer's assigned competencies, recording consent state, transcript.
- **Tools.** Recording adapter (meeting bot or upload), transcription, `draft_scorecard`, `compose_debrief`.
- **Outputs.** `InterviewBrief` (what to probe, assigned competencies, five questions, logistics); `ScorecardDraft` (entries with quotes, unrated where evidence is absent); `DebriefSummary` (per-competency comparison, disagreements with sources, unknowns, recommendation with rationale, reference plan).
- **Model tier.** `standard` for drafts; `judgment` for the debrief.
- **Policy.** `interview.brief` (auto); `interview.record` (approval with consent from all parties); `scorecard.draft` (auto as information, submitted only by the interviewer); `debrief.recommend` (approval as a recommendation; the decision is human).
- **Failure modes.** Drafting scores without evidence (guard: entries without a quote are left unrated); recency and halo effects (guard: independent scorecards are locked before the debrief shows others'); recording without consent (guard: adapter refuses).
- **Evals.** Brief relevance to unknowns; scorecard evidence discipline; debrief disagreement detection on fixture transcripts.

## Offer Agent

- **Purpose.** Compensation analysis, offer generation, approval routing, negotiation support.
- **Owns.** `offer` workflow (draft → approve → send → respond).
- **Inputs.** Packet compensation section and approval rules, the candidate's stated expectations (screen), benchmarks, other finalists' expectations, company offer template.
- **Tools.** `comp_benchmark`, `render_offer_letter`, e-signature adapter, `analyze_counter`.
- **Outputs.** `OfferProposal` (terms with rationale and benchmark comparison, risks such as internal equity), `OfferLetter`, `CounterAnalysis` (options with trade-offs; no recommendation to exceed the approved ceiling without a new approval).
- **Model tier.** `judgment`.
- **Policy.** `offer.draft` (approval); `offer.send` (approval); `offer.negotiate` (human_only; the agent advises); `offer.revise` (approval).
- **Failure modes.** Exceeding the ceiling (guard: hard check in code); pay-equity blind spots (guard: shows comparable current hires in the tenant if present); leaking other candidates' numbers to a candidate (guard: candidate-facing text never includes internal comparisons).
- **Evals.** Ceiling discipline; counter analysis quality on fixtures; letter correctness.

## Sourcing Agent (later phase)

- **Purpose.** Find candidates in order of cost: the tenant's pool, past applicants, referrals, rediscovery, then licensed external providers, then Indeed sourcing where permitted.
- **Owns.** `rediscovery` (Slice 7), `external_sourcing` (Slice 8).
- **Inputs.** Packet sourcing strategy and budget, embeddings, provider adapters, entitlement credits.
- **Outputs.** `SourcingShortlist` with evidence-based assessments (same schema as triage) and an outreach plan.
- **Policy.** `sourcing.search_internal` (auto); `sourcing.enrich_external` (auto within credits); `outreach.send` (auto_notify); nothing external without an entitlement.
- **Never.** Scrapes LinkedIn or automates it.

## Onboarding Workflow (a workflow with one agent step)

- **Purpose.** After acceptance: welcome, tasks, handoff packet or HRIS creation, reminders, 30/60/90 check-ins.
- **Agent step.** Compose the welcome message and the first-week plan from the packet and the company profile (`fast` tier).
- **Policy.** `employee.create_in_hris` (auto_notify after signature); `welcome.send` (auto); `checkin.request` (auto).

## What is deliberately not an agent

Job description writing (part of Intake), market intelligence (a tool), candidate research and enrichment (tools called by Triage and Sourcing), reference checking (a template workflow pending counsel), background checks (an integration), analytics (queries over events), candidate communication (the Coordinator).
