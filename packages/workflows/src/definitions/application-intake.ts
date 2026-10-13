import { and, desc, eq } from "drizzle-orm";
import type { EvidenceAssessment, ResumeExtraction } from "@ros/contracts";
import type { RunOutcome } from "@ros/ai";
import { ASSESSMENT_UNAVAILABLE_TEXT, RESUME_UNREADABLE_TEXT, audit, createEscalation, evaluateEligibility, emit, gate, notify, readingConsistency, resolvePolicy, transition } from "@ros/core";
import { applications, assessments, candidates, communications, companies, documents, rolePackets, roles, screens, workflowRuns, type Tx } from "@ros/db";
import { assessApplication, extractResume, sendAcknowledgment, type AcknowledgedConversation } from "@ros/agents";
import { twoPhase, type WorkflowDefinition } from "../types";
import { examineQuarantinedDocument, queueObjectDiscard, recordQuarantineVerdict, type QuarantineExamination } from "../documents";
import { SUGGESTION_WINDOW_HOURS, settleSuggestion, waitForSuggestion, type SuggestionState } from "../suggestions";

type State = { applicationId: string; roleId: string; ineligibleUntil?: string; heldAt?: string; remindersSent?: number } & SuggestionState;

/**
 * A held application waits for its review timer or for a person's decision, whichever comes first: "Keep them in"
 * signals `heldDecisionSignal(applicationId)`, so the reading starts at once instead of when the next reminder is due.
 */
export const HELD_DECISION_EVENT = "eligibility.decided";
export const heldDecisionSignal = (applicationId: string): string => `${applicationId}:${HELD_DECISION_EVENT}`;

/**
 * From "application received" to "ready for the owner" (docs/06 `application_intake`).
 * acknowledge → validate (quarantined résumé checked, scanned, moved) → extract → eligibility → (ineligible: hold for a person, remind, escalate an overdue review; never decline) | (eligible → assess)
 *
 * The steps that call a provider (`validate` the malware scanner and storage, `extract` and `ready` the model) do so in
 * a prepare phase with no transaction open; their transaction only writes what came back.
 */
export const applicationIntake: WorkflowDefinition<State> = {
  key: "application_intake",
  version: 1,
  initialStep: "acknowledge",
  maxAttempts: 4,
  escalationKind: "review",
  steps: {
    async acknowledge(ctx) {
      const loaded = await load(ctx.q, ctx.state.applicationId);
      if (!loaded) return { kind: "fail", error: "application not found", retryable: false };
      const { app, candidate, role, company, packet } = loaded;
      // An application whose conversation was offered in the same visit (plan E1) was moved on by the apply page already;
      // it still gets its acknowledgment, once (the key makes a repeat a no-op).
      const movedByApplyPage = app.stage !== "applied" && ONE_VISIT_STAGES.includes(app.stage) && !(await acknowledged(ctx.q, app.id));
      if (app.stage === "applied" || movedByApplyPage) {
        // The conversation that goes with the application, as it stands when this email goes (plan E1, E8): its link while
        // it is still to do, the link to come by email when the allowance was used up (Q17), or nothing to promise.
        const conversation = movedByApplyPage ? await conversationFor(ctx.q, app.id, ctx.services.env.jobsBaseUrl, packet) : null;
        // Queued in this transaction, sent by the outbox after it commits: a retry of this step never sends twice.
        const res = await sendAcknowledgment(ctx.q, ctx.services.integrations, {
          application: app,
          candidate,
          role,
          company,
          packet,
          // The status link a candidate receives lives on the job-page host (docs/spec/20), like the page they applied on.
          appBaseUrl: ctx.services.env.jobsBaseUrl,
          smsEnabled: ctx.services.env.smsEnabled,
          actor: ctx.actor,
          correlationId: ctx.run.id,
          ...(conversation ? { conversation } : {}),
        });
        if (app.stage === "applied") await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "received", by: "system", actor: ctx.actor, correlationId: ctx.run.id });
        await emit(ctx.q, { type: "application.acknowledged", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { channel: "email", status: res.status }, correlationId: ctx.run.id });
      }
      return { kind: "next", step: "validate" };
    },

    /**
     * Decision 2: a résumé is only ever read after the worker has inspected and scanned it. A scanner outage retries; a
     * refused file is recorded and the application goes on without it. The scan (a call to the malware engine), the
     * clean copy and the text extraction happen before the transaction opens; the transaction only records the verdict,
     * and the quarantine copy is removed by a job that exists only once that record has committed.
     */
    validate: twoPhase<State, QuarantineExamination | null>({
      async prepare(ctx) {
        const documentId = await ctx.read(async (q) => (await load(q, ctx.state.applicationId))?.app.resumeDocumentId ?? null);
        if (!documentId) return null;
        return examineQuarantinedDocument({ db: ctx.db, integrations: ctx.services.integrations, engine: ctx.services.engine }, { documentId, companyId: ctx.companyId, now: ctx.now });
      },
      async run(ctx, examined) {
        const loaded = await load(ctx.q, ctx.state.applicationId);
        if (!loaded) return { kind: "fail", error: "application not found", retryable: false };
        const { app } = loaded;
        if (!app.resumeDocumentId) return { kind: "next", step: "extract" };
        if (examined?.documentId !== app.resumeDocumentId) {
          const [doc] = await ctx.q.select({ status: documents.status }).from(documents).where(eq(documents.id, app.resumeDocumentId)).limit(1);
          if (doc?.status !== "quarantined") return { kind: "next", step: "extract" };
          return { kind: "fail", error: "the résumé arrived after the read phase; checking it again", retryable: true };
        }
        const { outcome, discard } = await recordQuarantineVerdict(ctx.q, examined, { companyId: ctx.companyId, actor: ctx.actor, correlationId: ctx.run.id, now: ctx.now });
        await queueObjectDiscard(ctx.q, ctx.services.engine, { companyId: ctx.companyId, keys: discard });
        if (outcome.outcome === "retry") return { kind: "fail", error: `résumé scan unavailable: ${outcome.error}`, retryable: true };
        return { kind: "next", step: "extract" };
      },
    }),

    extract: twoPhase<State, { documentId: string; out: RunOutcome<ResumeExtraction> } | null>({
      async prepare(ctx) {
        const doc = await ctx.read(async (q) => {
          const loaded = await load(q, ctx.state.applicationId);
          if (!loaded || loaded.app.extraction || !loaded.app.resumeDocumentId) return null;
          const [d] = await q.select().from(documents).where(eq(documents.id, loaded.app.resumeDocumentId)).limit(1);
          return d && d.status === "clean" && d.textExtracted ? d : null;
        });
        if (!doc) return null;
        const out = await extractResume(ctx.db, ctx.services.ai, { companyId: ctx.companyId, workflowRunId: ctx.run.id, text: doc.textExtracted!, filename: doc.filename, documentId: doc.id });
        return { documentId: doc.id, out };
      },
      async run(ctx, prepared) {
        const loaded = await load(ctx.q, ctx.state.applicationId);
        if (!loaded) return { kind: "fail", error: "application not found", retryable: false };
        const { app } = loaded;
        if (app.extraction) return { kind: "next", step: "eligibility" };
        if (!app.resumeDocumentId) return { kind: "next", step: "eligibility" };
        const [doc] = await ctx.q.select().from(documents).where(eq(documents.id, app.resumeDocumentId)).limit(1);
        if (doc && doc.status !== "clean") return { kind: "next", step: "eligibility" }; // refused or still quarantined: nothing to read
        if (!doc?.textExtracted) {
          await emit(ctx.q, { type: "resume.extraction_failed", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { reason: "no text could be read from the resume" }, correlationId: ctx.run.id });
          return { kind: "next", step: "eligibility" };
        }
        if (!prepared || prepared.documentId !== doc.id) return { kind: "fail", error: "the résumé text arrived after the read phase; running the extraction again", retryable: true };
        const out = prepared.out;
        if (!out.ok) {
          if (out.reason === "error") return { kind: "fail", error: out.error, retryable: true };
          await emit(ctx.q, { type: "resume.extraction_failed", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { reason: out.error, aiRunId: out.runId }, correlationId: ctx.run.id });
          return { kind: "next", step: "eligibility" };
        }
        await ctx.q.update(applications).set({ extraction: out.output }).where(eq(applications.id, app.id));
        await ctx.q.update(documents).set({ extractedByAiRunId: out.runId }).where(eq(documents.id, doc.id));
        await emit(ctx.q, { type: "resume.ingested", companyId: ctx.companyId, actor: { kind: "agent", id: "triage", runId: out.runId }, subject: { type: "application", id: app.id }, payload: { positions: out.output.positions.length, licenses: out.output.licenses.length, anomalies: out.output.anomalies.length }, correlationId: ctx.run.id });
        return { kind: "next", step: "eligibility" };
      },
    }),

    async eligibility(ctx) {
      const loaded = await load(ctx.q, ctx.state.applicationId);
      if (!loaded) return { kind: "fail", error: "application not found", retryable: false };
      const { app, packet } = loaded;
      if (app.stage !== "received") return { kind: "next", step: app.stage === "ineligible" ? "ineligible_review" : "ready" };
      const answers = (app.answers.eligibility ?? {}) as Record<string, unknown>;
      const result = evaluateEligibility(packet.requirements.eligibility, answers, ctx.now);
      await ctx.q.update(applications).set({ eligibility: result }).where(eq(applications.id, app.id));
      await emit(ctx.q, { type: "eligibility.evaluated", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { passed: result.passed, failed: result.failedRules.map((f) => f.key), unverifiable: result.unverifiable.map((u) => u.key) }, correlationId: ctx.run.id });
      if (result.passed) {
        await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "eligible", by: "system", actor: ctx.actor, correlationId: ctx.run.id });
        return { kind: "next", step: "ready" };
      }
      await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "ineligible", by: "system", actor: ctx.actor, reason: result.failedRules.map((f) => f.reason).join("; "), correlationId: ctx.run.id });
      await emit(ctx.q, { type: "application.ineligible", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { failedRules: result.failedRules }, correlationId: ctx.run.id });
      // Founder decision (15 Sep 2026, correction 6): a failed eligibility answer places the application on hold for a person.
      // The system notifies, starts a review timer, reminds, and escalates an overdue review. It never declines.
      const g = await gate(ctx.q, {
        companyId: ctx.companyId,
        roleId: ctx.state.roleId,
        applicationId: app.id,
        actionType: "application.hold_ineligible",
        subject: { type: "application", id: app.id },
        proposal: { failedRules: result.failedRules },
        rationale: "Answered no to an eligibility question the owner authored; held for a person to decide.",
        requestedBy: ctx.actor,
        workflowRunId: ctx.run.id,
      });
      const { candidate, role } = loaded;
      const name = `${candidate.firstName} ${candidate.lastName}`;
      await notify(ctx.q, { companyId: ctx.companyId, kind: "application.ineligible_hold", title: `${name} answered no to an eligibility question`, body: `Held for your decision (${result.failedRules.map((f) => f.reason).join("; ")}). Nothing is sent to them, even if you decline, until someone sends the decision message. Override if the answer was a mistake.`, action: { label: "Review", href: `/roles/${role.id}/talent?stage=ineligible&open=${app.id}` } });
      if (g.outcome === "human_only") return { kind: "next", step: "ready" }; // reminders disabled by policy; the hold stays visible in Today
      if (g.outcome === "wait_for_approval") return { kind: "wait", wait: { kind: "human", approvalRequestId: g.approvalRequestId }, resumeStep: "ineligible_review" };
      const hours = Number(g.decision.params.reviewWindowHours ?? 24);
      const until = new Date(ctx.now.getTime() + hours * 3600_000).toISOString();
      return { kind: "wait", wait: { kind: "event", eventTypes: [HELD_DECISION_EVENT], subjectId: app.id, until, reason: "review timer for a held application (operational; never adverse action)" }, state: { ineligibleUntil: until, heldAt: ctx.now.toISOString(), remindersSent: 0 }, resumeStep: "ineligible_review" };
    },

    /**
     * A person decided (the run goes on to the reading), or the review timer fired: remind the team, and after the
     * escalation threshold bring in a recruiter. Nothing declines here.
     */
    async ineligible_review(ctx) {
      const loaded = await load(ctx.q, ctx.state.applicationId);
      if (!loaded) return { kind: "fail", error: "application not found", retryable: false };
      const { app, candidate, role } = loaded;
      if (app.stage !== "ineligible") return { kind: "next", step: "ready" }; // a person decided: override (eligible) or decline (rejected)
      const policy = await resolvePolicy(ctx.q, ctx.companyId, ctx.state.roleId, "application.hold_ineligible");
      const remindEvery = Number(policy.params.remindEveryHours ?? 24);
      const escalateAfter = Number(policy.params.escalateAfterHours ?? 72);
      const heldAt = ctx.state.heldAt ?? app.stageChangedAt;
      const hoursHeld = Math.round((ctx.now.getTime() - Date.parse(heldAt)) / 3600_000);
      const remindersSent = (ctx.state.remindersSent ?? 0) + 1;
      const name = `${candidate.firstName} ${candidate.lastName}`;
      await notify(ctx.q, { companyId: ctx.companyId, kind: "application.ineligible_review_due", title: `${name} has waited ${hoursHeld} hours for your decision`, body: "They answered no to an eligibility question. Decline with a reason, or override if the answer was a mistake. Nothing is sent to them, even if you decline, until someone sends the decision message.", action: { label: "Decide", href: `/roles/${role.id}/talent?stage=ineligible&open=${app.id}` } });
      await emit(ctx.q, { type: "application.hold_reminded", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { hoursHeld, remindersSent }, correlationId: ctx.run.id });
      if (hoursHeld >= escalateAfter) {
        await createEscalation(ctx.q, { companyId: ctx.companyId, roleId: role.id, applicationId: app.id, kind: "review", question: `${name} answered no to an eligibility question for ${role.title} and has waited ${hoursHeld} hours for a decision. Please review it with the customer; only they can decline.`, requestedBy: ctx.actor, workflowRunId: ctx.run.id, now: ctx.now });
        return { kind: "complete", state: { remindersSent } };
      }
      const until = new Date(ctx.now.getTime() + remindEvery * 3600_000).toISOString();
      return { kind: "wait", wait: { kind: "event", eventTypes: [HELD_DECISION_EVENT], subjectId: app.id, until, reason: "reminder for a held application" }, state: { remindersSent }, resumeStep: "ineligible_review" };
    },

    /**
     * Slice 2: the evidence-based assessment. Information for the owner; the only automatic follow-on is a screen invite
     * under policy. When the conversation was offered with the application (plan E1) the résumé is read all the same,
     * beside the conversation: the stage stays where the conversation has it, nothing is announced (the team hears once
     * the conversation is finished or closed, E6), and no second invitation follows.
     */
    ready: twoPhase<State, { applicationId: string; out: RunOutcome<EvidenceAssessment> } | null>({
      async prepare(ctx) {
        const inputs = await ctx.read(async (q) => {
          const loaded = await load(q, ctx.state.applicationId);
          if (!loaded || !(await readyToAssess(q, loaded.app))) return null;
          const { app, packet } = loaded;
          const doc = app.resumeDocumentId ? (await q.select().from(documents).where(eq(documents.id, app.resumeDocumentId)).limit(1))[0] : undefined;
          const prior = await q.select({ stage: applications.stage, roleId: applications.roleId, at: applications.createdAt }).from(applications).where(eq(applications.candidateId, app.candidateId));
          const priorRoles = prior.length > 1 ? await q.select({ id: roles.id, title: roles.title }).from(roles).where(eq(roles.companyId, ctx.companyId)) : [];
          return {
            applicationId: app.id,
            packet,
            extraction: app.extraction,
            resumeText: doc?.textExtracted ?? null,
            applicationAnswers: { eligibility: (app.answers.eligibility ?? {}) as Record<string, unknown>, noResumeSummary: app.answers.noResume?.summary },
            eligibility: app.eligibility,
            priorApplications: prior.filter((p) => p.roleId !== app.roleId).map((p) => ({ roleTitle: priorRoles.find((r) => r.id === p.roleId)?.title ?? "another role", stage: p.stage, at: p.at })),
          };
        });
        if (!inputs) return null;
        const out = await assessApplication(ctx.db, ctx.services.ai, { companyId: ctx.companyId, workflowRunId: ctx.run.id, ...inputs });
        return { applicationId: inputs.applicationId, out };
      },
      async run(ctx, prepared) {
        const loaded = await load(ctx.q, ctx.state.applicationId);
        if (!loaded) return { kind: "fail", error: "application not found", retryable: false };
        const { app, candidate, role } = loaded;
        // The conversation offered with the application is under way or settled: read the résumé beside it, quietly. Only
        // at the stages the reading still serves (`readyToAssess`): someone who withdrew, was decided on or was invited to
        // interview before it ran needs no reading, and that is no failure.
        const beside = READING_BESIDE_STAGES.includes(app.stage) && (await screenOf(ctx.q, app.id)) !== null;
        if (app.stage !== "eligible" && !beside) return { kind: "complete" }; // ineligible held for review, or already moved by a human
        if (await hasTriage(ctx.q, app.id)) return { kind: "next", step: "after_triage" };
        if (!prepared) return { kind: "fail", error: "the application became eligible after the read phase; assessing again", retryable: true };
        const out = prepared.out;
        if (!out.ok) {
          if (out.reason === "error") return { kind: "fail", error: out.error, retryable: true };
          // Invalid or refused twice: the owner reviews without an assessment; nothing is hidden, and the owner is told in so many words.
          await emit(ctx.q, { type: "ai.output_invalid", companyId: ctx.companyId, actor: { kind: "agent", id: "triage", runId: out.runId }, subject: { type: "application", id: app.id }, payload: { error: out.error, reason: out.reason }, correlationId: ctx.run.id });
          // Beside a conversation the stage is the conversation's, and the team hears when it ends (E6).
          if (beside) return { kind: "complete" };
          await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "triaged", by: "system", actor: ctx.actor, reason: "assessment unavailable; manual review", correlationId: ctx.run.id });
          await emit(ctx.q, { type: "application.triaged", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { assessmentId: null, recommendation: "review_manually", reason: "assessment unavailable" }, correlationId: ctx.run.id });
          const name = `${candidate.firstName} ${candidate.lastName}`;
          await notify(ctx.q, { companyId: ctx.companyId, kind: "application.assessment_unavailable", title: `We could not assess ${name} automatically; please review`, body: `${ASSESSMENT_UNAVAILABLE_TEXT} The assistant's answer was not usable after two tries. Nothing is hidden: the application, the résumé and the answers are on ${candidate.firstName}'s page.`, action: { label: "Review", href: `/roles/${role.id}/talent?open=${app.id}` } });
          return { kind: "complete" };
        }
        // The model writes no number (plan 0.9); the column stays for a score worked out in code later.
        const [row] = await ctx.q
          .insert(assessments)
          .values({ companyId: ctx.companyId, applicationId: app.id, kind: "triage", packetVersion: app.packetVersion, aiRunId: out.runId, result: out.output, overall: out.output.overall, confidence: out.output.confidence, secondaryScore: null })
          .returning({ id: assessments.id });
        // A scorecard the conversation already produced stays the latest reading: it has the candidate's own answers.
        const screenFirst = app.latestAssessmentId ? (await ctx.q.select({ kind: assessments.kind }).from(assessments).where(eq(assessments.id, app.latestAssessmentId)).limit(1))[0]?.kind === "screen" : false;
        if (!screenFirst) await ctx.q.update(applications).set({ latestAssessmentId: row.id }).where(eq(applications.id, app.id));
        await emit(ctx.q, { type: "assessment.created", companyId: ctx.companyId, actor: { kind: "agent", id: "triage", runId: out.runId }, subject: { type: "application", id: app.id }, payload: { kind: "triage", assessmentId: row.id, overall: out.output.overall, recommendation: out.output.recommendation, confidence: out.output.confidence }, correlationId: ctx.run.id });
        if (beside) return { kind: "next", step: "after_triage" };
        await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "triaged", by: "system", actor: ctx.actor, correlationId: ctx.run.id });
        await emit(ctx.q, { type: "application.triaged", companyId: ctx.companyId, actor: { kind: "agent", id: "triage", runId: out.runId }, subject: { type: "application", id: app.id }, payload: { assessmentId: row.id, recommendation: out.output.recommendation, overall: out.output.overall }, correlationId: ctx.run.id });
        return { kind: "next", step: "after_triage" };
      },
    }),

    /**
     * Policy `application.invite_screen` (default auto_notify): a "screen" recommendation starts the screen workflow;
     * anything else waits for the owner. The software check comes first (plan A8): a reading that disagrees with its own
     * must-have findings holds the step for a person, with the reason, and the candidate shows as "Needs a closer look".
     * Low confidence alone holds nothing; the page asks the reader to read that one themselves. A suggestion that waits
     * for approval expires after a week (plan A6).
     */
    async after_triage(ctx) {
      const loaded = await load(ctx.q, ctx.state.applicationId);
      if (!loaded) return { kind: "fail", error: "application not found", retryable: false };
      const { app, candidate, role, packet } = loaded;
      if (app.stage !== "triaged" || !app.latestAssessmentId) return { kind: "complete" };
      // They were offered the conversation already (plan E1; sent without it, or closed part-way), or the apply page started
      // its run while the month's conversations were used up (Q17): never invited twice, and the team hears about them
      // when the conversation ends.
      if ((await screenOf(ctx.q, app.id)) || (await screenRunStarted(ctx.q, app.id))) return { kind: "complete" };
      const [asmt] = await ctx.q.select().from(assessments).where(eq(assessments.id, app.latestAssessmentId)).limit(1);
      const rec = (asmt?.result as { recommendation?: string } | undefined)?.recommendation;
      const name = `${candidate.firstName} ${candidate.lastName}`;
      if (rec === "hold") {
        await notify(ctx.q, { companyId: ctx.companyId, kind: "application.needs_review", title: `${name} needs your review`, body: `The assessment found weak evidence for ${role.title}: ${asmt?.result.summary ?? ""}`, action: { label: "Review", href: `/roles/${role.id}/talent?open=${app.id}` } });
        return { kind: "complete" };
      }
      if (rec !== "screen") {
        // Insufficient evidence: say what is missing in plain words (the open questions), and what the owner can do about it.
        const unknowns = asmt?.result.unknowns.map((u) => u.question) ?? [];
        const unreadable = await resumeUnreadable(ctx.q, app);
        const body = [
          unreadable ? RESUME_UNREADABLE_TEXT : "",
          unknowns.length ? `Open questions: ${unknowns.join(" ")}` : `Not enough to assess automatically: ${asmt?.result.summary ?? "no résumé text"}`,
          "Ask about it in a short screen, or review the application yourself.",
        ].filter(Boolean).join(" ");
        await notify(ctx.q, { companyId: ctx.companyId, kind: "application.needs_review", title: `${name} needs a closer look`, body, action: { label: "Take a closer look", href: `/roles/${role.id}/talent?open=${app.id}` } });
        return { kind: "complete" };
      }
      const check = readingConsistency(asmt, packet);
      if (!check.consistent) {
        await audit(ctx.q, { companyId: ctx.companyId, actor: ctx.actor, action: "assessment.flagged", target: { type: "application", id: app.id }, reason: check.reason ?? "the reading disagrees with its must-have findings", details: { assessmentId: asmt.id, held: "application.invite_screen" } });
        await notify(ctx.q, { companyId: ctx.companyId, kind: "application.needs_review", title: `${name} needs a closer look`, body: `${check.reason} No screening invitation was sent.`, action: { label: "Take a closer look", href: `/roles/${role.id}/talent?open=${app.id}` } });
        return { kind: "complete" };
      }
      const g = await gate(ctx.q, { companyId: ctx.companyId, roleId: role.id, applicationId: app.id, actionType: "application.invite_screen", subject: { type: "application", id: app.id }, proposal: { assessmentId: asmt.id, recommendation: rec }, rationale: `${name} looks like a fit for ${role.title}: ${asmt.result.summary}`, requestedBy: { kind: "agent", id: "triage", runId: asmt.aiRunId ?? undefined }, workflowRunId: ctx.run.id, expiresInHours: SUGGESTION_WINDOW_HOURS });
      if (g.outcome === "human_only") {
        await notify(ctx.q, { companyId: ctx.companyId, kind: "application.ready", title: `${name} is ready for a screen`, body: asmt.result.summary, action: { label: "Invite to a screen", href: `/roles/${role.id}/talent?open=${app.id}` } });
        return { kind: "complete" };
      }
      if (g.outcome === "wait_for_approval") return waitForSuggestion(ctx, g.approvalRequestId, "after_triage_decision");
      await ctx.services.engine.start(ctx.q, { workflowKey: "screen", companyId: ctx.companyId, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId: role.id, invitedBy: "triage" }, idempotencyKey: `screen:${app.id}`, actor: ctx.actor });
      // "Stop this screen invitation" on the candidate's page takes it back until they start (plan A7).
      if (g.notify) await notify(ctx.q, { companyId: ctx.companyId, kind: "screen.invited", title: `Inviting ${name} to a screen`, body: `${asmt.result.summary} Until ${candidate.firstName} starts, you can stop the invitation from their page; they get a short, polite note.`, action: { label: "See candidate", href: `/roles/${role.id}/talent?open=${app.id}` } });
      return { kind: "complete" };
    },

    async after_triage_decision(ctx) {
      // Approval is decided in the approvals route: approving starts the screen; declining leaves the candidate with the
      // owner. A suggestion nobody answered within the week lapses here, and nothing is sent.
      return (await settleSuggestion(ctx, "after_triage_decision")) ?? { kind: "complete" };
    },
  },
};

/** Stages the apply page may leave an application at when it offered the conversation in the same visit (plan E1). */
const ONE_VISIT_STAGES: readonly string[] = ["received", "eligible", "screen_invited", "screening", "screen_complete", "triaged"];

/** Whether the acknowledgment was queued already (its idempotency key). */
async function acknowledged(q: Tx, applicationId: string): Promise<boolean> {
  const [row] = await q.select({ id: communications.id }).from(communications).where(eq(communications.idempotencyKey, `ack:${applicationId}`)).limit(1);
  return !!row;
}

/**
 * The conversation offered with the application, for the acknowledgment: its link while it is still to be done
 * (invited, reminded, started, or paused while the assistant is down); closed once it was sent, sent without, or handed
 * to a person; or, with no screen yet but its run waiting for the month's allowance (Q17), the link to come by email.
 */
async function conversationFor(q: Tx, applicationId: string, jobsBaseUrl: string, packet: { screening: { questions: unknown[]; maxMinutes: number } }): Promise<AcknowledgedConversation | null> {
  const [row] = await q.select({ token: screens.token, status: screens.status, invitedVia: screens.invitedVia }).from(screens).where(eq(screens.applicationId, applicationId)).orderBy(desc(screens.createdAt)).limit(1);
  if (!row) return (await screenRunStarted(q, applicationId)) ? { state: "by_email", minutes: packet.screening.maxMinutes } : null;
  if (row.invitedVia !== "apply") return null;
  if (!["invited", "reminded", "in_progress", "paused"].includes(row.status)) return { state: "closed" };
  return { state: "open", url: `${jobsBaseUrl}/c/screen/${row.token}`, questions: packet.screening.questions.length, minutes: packet.screening.maxMinutes };
}

/** Any screen the application has had, newest first. */
async function screenOf(q: Tx, applicationId: string): Promise<{ id: string; status: string } | null> {
  const [row] = await q.select({ id: screens.id, status: screens.status }).from(screens).where(eq(screens.applicationId, applicationId)).orderBy(desc(screens.createdAt)).limit(1);
  return row ?? null;
}

/** A `screen` run already started for this application (the key every first invitation uses). */
async function screenRunStarted(q: Tx, applicationId: string): Promise<boolean> {
  const [row] = await q.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.idempotencyKey, `screen:${applicationId}`)).limit(1);
  return !!row;
}

async function hasTriage(q: Tx, applicationId: string): Promise<boolean> {
  const [row] = await q.select({ id: assessments.id }).from(assessments).where(and(eq(assessments.applicationId, applicationId), eq(assessments.kind, "triage"))).limit(1);
  return !!row;
}

/**
 * Whether the résumé reading is still to be written: an eligible application without one, or (plan E1) one whose
 * conversation was offered with the application, whatever the conversation has done to its stage since.
 */
async function readyToAssess(q: Tx, app: { id: string; stage: string }): Promise<boolean> {
  if (await hasTriage(q, app.id)) return false;
  if (app.stage === "eligible") return true;
  return READING_BESIDE_STAGES.includes(app.stage) && (await screenOf(q, app.id)) !== null;
}

/** Where the conversation offered with the application can have taken an application before its résumé is read (plan E1). */
const READING_BESIDE_STAGES: readonly string[] = ["screen_invited", "screening", "screen_complete", "triaged", "interview_recommended"];

/** A clean résumé file with nothing to read (a scan without a text layer): the assessment used the written answers only. */
async function resumeUnreadable(q: Tx, app: { resumeDocumentId: string | null; extraction: unknown }): Promise<boolean> {
  if (!app.resumeDocumentId || app.extraction) return false;
  const [doc] = await q.select({ status: documents.status, text: documents.textExtracted }).from(documents).where(eq(documents.id, app.resumeDocumentId)).limit(1);
  return !!doc && doc.status === "clean" && !doc.text;
}

async function load(q: Tx, applicationId: string) {
  const [app] = await q.select().from(applications).where(eq(applications.id, applicationId)).limit(1);
  if (!app) return null;
  const [candidate] = await q.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await q.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await q.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const [pv] = await q.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  if (!candidate || !role || !company || !pv) return null;
  return { app, candidate, role, company, packet: pv.packet };
}
