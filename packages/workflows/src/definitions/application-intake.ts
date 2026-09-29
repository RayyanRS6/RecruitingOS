import { and, eq } from "drizzle-orm";
import type { EvidenceAssessment, ResumeExtraction } from "@ros/contracts";
import type { RunOutcome } from "@ros/ai";
import { createEscalation, evaluateEligibility, emit, gate, notify, resolvePolicy, transition } from "@ros/core";
import { applications, assessments, candidates, companies, documents, rolePackets, roles, type Tx } from "@ros/db";
import { assessApplication, extractResume, sendAcknowledgment } from "@ros/agents";
import { twoPhase, type WorkflowDefinition } from "../types";
import { processQuarantinedDocument } from "../documents";

type State = { applicationId: string; roleId: string; ineligibleUntil?: string; heldAt?: string; remindersSent?: number };

/**
 * From "application received" to "ready for the owner" (docs/06 `application_intake`).
 * acknowledge → validate (quarantined résumé checked, scanned, moved) → extract → eligibility → (ineligible: hold for a person, remind, escalate an overdue review; never decline) | (eligible → assess)
 *
 * The two steps that call the model (`extract`, `ready`) do so in a prepare phase with no transaction open; their
 * transaction only writes what the model returned.
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
      if (app.stage === "applied") {
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
        });
        await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "received", by: "system", actor: ctx.actor, correlationId: ctx.run.id });
        await emit(ctx.q, { type: "application.acknowledged", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { channel: "email", status: res.status }, correlationId: ctx.run.id });
      }
      return { kind: "next", step: "validate" };
    },

    /** Decision 2: a résumé is only ever read after the worker has inspected and scanned it. A scanner outage retries; a refused file is recorded and the application goes on without it. */
    async validate(ctx) {
      const loaded = await load(ctx.q, ctx.state.applicationId);
      if (!loaded) return { kind: "fail", error: "application not found", retryable: false };
      const { app } = loaded;
      if (!app.resumeDocumentId) return { kind: "next", step: "extract" };
      const result = await processQuarantinedDocument(ctx.q, ctx.services.integrations, { documentId: app.resumeDocumentId, companyId: ctx.companyId, actor: ctx.actor, correlationId: ctx.run.id, now: ctx.now });
      if (result.outcome === "retry") return { kind: "fail", error: `résumé scan unavailable: ${result.error}`, retryable: true };
      return { kind: "next", step: "extract" };
    },

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
      await notify(ctx.q, { companyId: ctx.companyId, kind: "application.ineligible_hold", title: `${name} answered no to an eligibility question`, body: `Held for your decision (${result.failedRules.map((f) => f.reason).join("; ")}). Nothing is sent to them unless you decline. Override if the answer was a mistake.`, action: { label: "Review", href: `/roles/${role.id}/talent?stage=ineligible` } });
      if (g.outcome === "human_only") return { kind: "next", step: "ready" }; // reminders disabled by policy; the hold stays visible in Today
      if (g.outcome === "wait_for_approval") return { kind: "wait", wait: { kind: "human", approvalRequestId: g.approvalRequestId }, resumeStep: "ineligible_review" };
      const hours = Number(g.decision.params.reviewWindowHours ?? 24);
      const until = new Date(ctx.now.getTime() + hours * 3600_000).toISOString();
      return { kind: "wait", wait: { kind: "timer", until, reason: "review timer for a held application (operational; never adverse action)" }, state: { ineligibleUntil: until, heldAt: ctx.now.toISOString(), remindersSent: 0 }, resumeStep: "ineligible_review" };
    },

    /** The review timer fired. Remind the team; after the escalation threshold bring in a recruiter. Nothing declines here. */
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
      await notify(ctx.q, { companyId: ctx.companyId, kind: "application.ineligible_review_due", title: `${name} has waited ${hoursHeld} hours for your decision`, body: "They answered no to an eligibility question. Decline with a reason, or override if the answer was a mistake. Nothing is sent to them until you decide.", action: { label: "Decide", href: `/roles/${role.id}/talent?stage=ineligible` } });
      await emit(ctx.q, { type: "application.hold_reminded", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { hoursHeld, remindersSent }, correlationId: ctx.run.id });
      if (hoursHeld >= escalateAfter) {
        await createEscalation(ctx.q, { companyId: ctx.companyId, roleId: role.id, applicationId: app.id, kind: "review", question: `${name} answered no to an eligibility question for ${role.title} and has waited ${hoursHeld} hours for a decision. Please review it with the customer; only they can decline.`, requestedBy: ctx.actor, workflowRunId: ctx.run.id, now: ctx.now });
        return { kind: "complete", state: { remindersSent } };
      }
      const until = new Date(ctx.now.getTime() + remindEvery * 3600_000).toISOString();
      return { kind: "wait", wait: { kind: "timer", until, reason: "reminder for a held application" }, state: { remindersSent }, resumeStep: "ineligible_review" };
    },

    /** Slice 2: the evidence-based assessment. Information for the owner; the only automatic follow-on is a screen invite under policy. */
    ready: twoPhase<State, { applicationId: string; out: RunOutcome<EvidenceAssessment> } | null>({
      async prepare(ctx) {
        const inputs = await ctx.read(async (q) => {
          const loaded = await load(q, ctx.state.applicationId);
          if (loaded?.app.stage !== "eligible" || loaded.app.latestAssessmentId) return null;
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
        const { app } = loaded;
        if (app.stage !== "eligible") return { kind: "complete" }; // ineligible held for review, or already moved by a human
        if (app.latestAssessmentId) return { kind: "next", step: "after_triage" };
        if (!prepared) return { kind: "fail", error: "the application became eligible after the read phase; assessing again", retryable: true };
        const out = prepared.out;
        if (!out.ok) {
          if (out.reason === "error") return { kind: "fail", error: out.error, retryable: true };
          // Invalid or refused twice: the owner reviews without an assessment; nothing is hidden.
          await emit(ctx.q, { type: "ai.output_invalid", companyId: ctx.companyId, actor: { kind: "agent", id: "triage", runId: out.runId }, subject: { type: "application", id: app.id }, payload: { error: out.error, reason: out.reason }, correlationId: ctx.run.id });
          await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "triaged", by: "system", actor: ctx.actor, reason: "assessment unavailable; manual review", correlationId: ctx.run.id });
          await emit(ctx.q, { type: "application.triaged", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { assessmentId: null, recommendation: "review_manually", reason: "assessment unavailable" }, correlationId: ctx.run.id });
          return { kind: "complete" };
        }
        const [row] = await ctx.q
          .insert(assessments)
          .values({ companyId: ctx.companyId, applicationId: app.id, kind: "triage", packetVersion: app.packetVersion, aiRunId: out.runId, result: out.output, overall: out.output.overall, confidence: out.output.confidence, secondaryScore: out.output.secondaryScore !== undefined ? String(out.output.secondaryScore) : null })
          .returning({ id: assessments.id });
        await ctx.q.update(applications).set({ latestAssessmentId: row.id }).where(eq(applications.id, app.id));
        await emit(ctx.q, { type: "assessment.created", companyId: ctx.companyId, actor: { kind: "agent", id: "triage", runId: out.runId }, subject: { type: "application", id: app.id }, payload: { kind: "triage", assessmentId: row.id, overall: out.output.overall, recommendation: out.output.recommendation, confidence: out.output.confidence }, correlationId: ctx.run.id });
        await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "triaged", by: "system", actor: ctx.actor, correlationId: ctx.run.id });
        await emit(ctx.q, { type: "application.triaged", companyId: ctx.companyId, actor: { kind: "agent", id: "triage", runId: out.runId }, subject: { type: "application", id: app.id }, payload: { assessmentId: row.id, recommendation: out.output.recommendation, overall: out.output.overall }, correlationId: ctx.run.id });
        return { kind: "next", step: "after_triage" };
      },
    }),

    /** Policy `application.invite_screen` (default auto_notify): a "screen" recommendation starts the screen workflow; anything else waits for the owner. */
    async after_triage(ctx) {
      const loaded = await load(ctx.q, ctx.state.applicationId);
      if (!loaded) return { kind: "fail", error: "application not found", retryable: false };
      const { app, candidate, role } = loaded;
      if (app.stage !== "triaged" || !app.latestAssessmentId) return { kind: "complete" };
      const [asmt] = await ctx.q.select().from(assessments).where(eq(assessments.id, app.latestAssessmentId)).limit(1);
      const rec = (asmt?.result as { recommendation?: string } | undefined)?.recommendation;
      const name = `${candidate.firstName} ${candidate.lastName}`;
      if (rec !== "screen") {
        await notify(ctx.q, { companyId: ctx.companyId, kind: "application.needs_review", title: `${name} needs your review`, body: rec === "hold" ? `The assessment found weak evidence for ${role.title}: ${asmt?.result.summary ?? ""}` : `Not enough to assess automatically: ${asmt?.result.summary ?? "no resume text"}`, action: { label: "Review", href: `/roles/${role.id}/talent` } });
        return { kind: "complete" };
      }
      const g = await gate(ctx.q, { companyId: ctx.companyId, roleId: role.id, applicationId: app.id, actionType: "application.invite_screen", subject: { type: "application", id: app.id }, proposal: { assessmentId: asmt.id, recommendation: rec }, rationale: `${name} looks like a fit for ${role.title}: ${asmt.result.summary}`, requestedBy: { kind: "agent", id: "triage", runId: asmt.aiRunId ?? undefined }, workflowRunId: ctx.run.id, expiresInHours: 24 * 7 });
      if (g.outcome === "human_only") {
        await notify(ctx.q, { companyId: ctx.companyId, kind: "application.ready", title: `${name} is ready for a screen`, body: asmt.result.summary, action: { label: "Invite to a screen", href: `/roles/${role.id}/talent` } });
        return { kind: "complete" };
      }
      if (g.outcome === "wait_for_approval") return { kind: "wait", wait: { kind: "human", approvalRequestId: g.approvalRequestId }, resumeStep: "after_triage_decision" };
      await ctx.services.engine.start(ctx.q, { workflowKey: "screen", companyId: ctx.companyId, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId: role.id, invitedBy: "triage" }, idempotencyKey: `screen:${app.id}`, actor: ctx.actor });
      if (g.notify) await notify(ctx.q, { companyId: ctx.companyId, kind: "screen.invited", title: `Inviting ${name} to a screen`, body: `${asmt.result.summary} You can stop this from the candidate's page.`, action: { label: "See candidate", href: `/roles/${role.id}/talent` } });
      return { kind: "complete" };
    },

    async after_triage_decision() {
      // Approval is decided in the approvals route: approving starts the screen; declining leaves the candidate with the owner.
      return { kind: "complete" };
    },
  },
};

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
