import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { RolePacket as RolePacketSchema, inProcess, type CvNoScore, type EvidenceAssessment, type ResumeExtraction, type RolePacket } from "@ros/contracts";
import { outOfCredit, type RunOutcome } from "@ros/ai";
import { closeOutDayWords, closeOutDueAt, emit, formAnswersOf, sameRequirements, transition } from "@ros/core";
import { applications, assessments, candidates, companies, documents, rolePackets, roles, type Tx } from "@ros/db";
import { assessApplication, extractResume, sendAcknowledgment } from "@ros/agents";
import { twoPhase, type StepContext, type StepResult, type WorkflowDefinition } from "../types";
import { waitForCredit } from "../credit-wait";
import { examineQuarantinedDocument, queueObjectDiscard, recordQuarantineVerdict, type QuarantineExamination } from "../documents";

/** `creditWaitSince`: when the reading started waiting for the company's AI help. */
type State = { applicationId: string; roleId: string; creditWaitSince?: string };

/** Why a person reached New without a CV score; the Candidates list reads it from their newest `application.triaged` entry. */
type Unscored = Extract<CvNoScore, "unreadable" | "not_scored" | "ai_used_up">;

/**
 * From "applied" to "New, read and scored" (`triaged`), with nothing else on the way:
 *
 * receive (the stage, and the one email with the status link) → validate (the CV file is checked, scanned and moved) →
 * extract (the CV's facts, read by AI once) → read (the CV reading: one finding per must-have and skill) → `triaged`.
 *
 * - Someone past the plan's candidates per job stops after `validate`: nothing of theirs is read by AI, and nothing
 *   moves until a change of plan opens them (`unlockApplicants`), which starts an intake that comes this way again.
 * - No answer on the form holds anyone: every answer is given to the reading as evidence, and a "No" is a flag a person reads.
 * - A file with no readable text, an AI answer that cannot be used, or no AI help left: the person still reaches
 *   `triaged`, unscored, with the reason. With no AI help left the run waits, and reads them when it returns.
 * - The CV is read against the job as it is when it is read (`load`, `live`). When a job's must-haves or skills change,
 *   `rereadApplicants` starts a run at `extract` for everyone still in the process, which reads them again against the
 *   new version; someone already read against what the job asks for now is not read again (`toRead`).
 * - Nothing here starts an AI interview: a person on the team does, by shortlisting.
 *
 * The steps that call a provider (`validate` the malware scanner and storage, `extract` and `read` the model) do so in a
 * prepare phase with no transaction open; their transaction only writes what came back.
 */
export const applicationIntake: WorkflowDefinition<State> = {
  key: "application_intake",
  version: 2,
  initialStep: "receive",
  maxAttempts: 4,
  steps: {
    /** A new application is received and gets its one email: thank you, what happens next, and the status link (the on-file wording for someone past the plan's limit). */
    async receive(ctx) {
      const loaded = await load(ctx.q, ctx.state.applicationId);
      if (!loaded) return { kind: "fail", error: "application not found", retryable: false };
      const { app, candidate, role, company, packet } = loaded;
      if (app.stage !== "applied") return { kind: "next", step: "validate" };
      await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "received", by: "system", actor: ctx.actor, correlationId: ctx.run.id });
      // Someone the company had before this application is told it was sent using their address.
      const knownAddress = (await ctx.q.select({ id: applications.id }).from(applications).where(and(eq(applications.candidateId, candidate.id), ne(applications.id, app.id))).limit(1)).length > 0;
      const onFileByDay = app.lockedAt ? closeOutDayWords(closeOutDueAt(app.createdAt), company.timezone) : null;
      const res = await sendAcknowledgment(ctx.q, ctx.services.integrations, { application: app, candidate, role, company, packet, actor: ctx.actor, correlationId: ctx.run.id, appBaseUrl: ctx.services.env.jobsBaseUrl, onFileByDay, knownAddress });
      await emit(ctx.q, { type: "application.acknowledged", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { channel: "email", status: res.status, onFile: !!app.lockedAt }, correlationId: ctx.run.id });
      return { kind: "next", step: "validate" };
    },

    /**
     * A CV is only ever read after the worker has inspected and scanned it. A scanner outage retries; a refused file is
     * recorded and the application goes on without it. The scan, the clean copy and the text extraction happen before the
     * transaction opens; the transaction only records the verdict, and the quarantine copy is removed by a job that
     * exists only once that record has committed.
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
        if (app.resumeDocumentId && examined?.documentId !== app.resumeDocumentId) {
          const [doc] = await ctx.q.select({ status: documents.status }).from(documents).where(eq(documents.id, app.resumeDocumentId)).limit(1);
          if (doc?.status === "quarantined") return { kind: "fail", error: "the file arrived after the read phase; checking it again", retryable: true };
        } else if (app.resumeDocumentId && examined) {
          const { outcome, discard } = await recordQuarantineVerdict(ctx.q, examined, { companyId: ctx.companyId, actor: ctx.actor, correlationId: ctx.run.id, now: ctx.now });
          await queueObjectDiscard(ctx.q, ctx.services.engine, { companyId: ctx.companyId, keys: discard });
          if (outcome.outcome === "retry") return { kind: "fail", error: `file scan unavailable: ${outcome.error}`, retryable: true };
        }
        // Someone past the plan's limit stops here, with the file scanned. The row is held while that is read, so a change
        // of plan either opens it first, and this run goes on, or waits for this run to end and starts a new one: never neither.
        const [lock] = await ctx.q.select({ lockedAt: applications.lockedAt }).from(applications).where(eq(applications.id, app.id)).limit(1).for("update");
        return lock?.lockedAt ? { kind: "complete" } : { kind: "next", step: "extract" };
      },
    }),

    /** The CV's facts (positions, licences, skills), read by the model once and kept on the application. */
    extract: twoPhase<State, { documentId: string; out: RunOutcome<ResumeExtraction> } | null>({
      async prepare(ctx) {
        const doc = await ctx.read(async (q) => {
          const loaded = await load(q, ctx.state.applicationId);
          if (!loaded || loaded.app.extraction || !(await toRead(q, loaded))) return null;
          return readableCv(q, loaded.app);
        });
        if (!doc) return null;
        return { documentId: doc.id, out: await extractResume(ctx.db, ctx.services.ai, { companyId: ctx.companyId, workflowRunId: ctx.run.id, text: doc.text, filename: doc.filename, documentId: doc.id }) };
      },
      async run(ctx, prepared) {
        const loaded = await load(ctx.q, ctx.state.applicationId);
        if (!loaded) return { kind: "fail", error: "application not found", retryable: false };
        const { app } = loaded;
        const stop = await noReading(ctx, loaded);
        if (stop) return stop;
        if (app.extraction) return { kind: "next", step: "read" };
        const doc = await readableCv(ctx.q, app);
        if (!doc) {
          await emit(ctx.q, { type: "resume.extraction_failed", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { reason: "no text could be read from the file" }, correlationId: ctx.run.id });
          return unscored(ctx, app, "unreadable");
        }
        if (prepared?.documentId !== doc.id) return { kind: "fail", error: "the file's text arrived after the read phase; reading it again", retryable: true };
        const out = prepared.out;
        if (outOfCredit(out)) return waitForAiHelp(ctx, app, out.refusedHoldUsd);
        if (!out.ok) {
          if (out.reason === "error") return { kind: "fail", error: out.error, retryable: true };
          // The facts could not be put in order: the reading still has the CV's own text.
          await emit(ctx.q, { type: "resume.extraction_failed", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { reason: out.error, aiRunId: out.runId }, correlationId: ctx.run.id });
          return { kind: "next", step: "read" };
        }
        await ctx.q.update(applications).set({ extraction: out.output }).where(eq(applications.id, app.id));
        await ctx.q.update(documents).set({ extractedByAiRunId: out.runId }).where(eq(documents.id, doc.id));
        await emit(ctx.q, { type: "resume.ingested", companyId: ctx.companyId, actor: { kind: "agent", id: "triage", runId: out.runId }, subject: { type: "application", id: app.id }, payload: { positions: out.output.positions.length, licenses: out.output.licenses.length }, correlationId: ctx.run.id });
        return { kind: "next", step: "read" };
      },
    }),

    /**
     * The CV reading: one finding per must-have and per skill, each with the quote it rests on, from the CV and from every
     * answer on the form. The model writes no number and no verdict: the CV score is worked out from the stored findings
     * (`cvScoreOf`). The reading sees no name, email, phone, address or link, and nothing of earlier applications. It is
     * made against the job as it is now and stored with that version; the form's answers are read with the questions of
     * the version the person applied to, which are the ones they answered.
     */
    read: twoPhase<State, { version: number; out: RunOutcome<EvidenceAssessment> } | null>({
      async prepare(ctx) {
        const inputs = await ctx.read(async (q) => {
          const loaded = await load(q, ctx.state.applicationId);
          if (!loaded || !(await toRead(q, loaded))) return null;
          const { app, candidate, packet, live } = loaded;
          const doc = await readableCv(q, app);
          if (!doc) return null;
          return { version: live.version, input: { applicationId: app.id, packet: { ...live.packet, formQuestions: packet.formQuestions }, extraction: app.extraction, resumeText: doc.text, formAnswers: formAnswersOf(app.answers), identity: { firstName: candidate.firstName, lastName: candidate.lastName, email: candidate.email, phone: candidate.phone, fullName: app.extraction?.fullName ?? null } } };
        });
        if (!inputs) return null;
        return { version: inputs.version, out: await assessApplication(ctx.db, ctx.services.ai, { companyId: ctx.companyId, workflowRunId: ctx.run.id, ...inputs.input }) };
      },
      async run(ctx, prepared) {
        const loaded = await load(ctx.q, ctx.state.applicationId, { holdJob: true });
        if (!loaded) return { kind: "fail", error: "application not found", retryable: false };
        const { app } = loaded;
        const stop = await noReading(ctx, loaded);
        if (stop) return stop;
        if (!(await readableCv(ctx.q, app))) return unscored(ctx, app, "unreadable");
        if (!prepared) return { kind: "fail", error: "the application changed after the read phase; reading it again", retryable: true };
        // The job's must-haves or skills changed while the model was reading: that reading answers a job that is gone.
        if (!(await answersLive(ctx.q, loaded, prepared.version))) return { kind: "fail", error: "the job's requirements changed after the read phase; reading it again", retryable: true };
        const out = prepared.out;
        if (outOfCredit(out)) return waitForAiHelp(ctx, app, out.refusedHoldUsd);
        if (!out.ok) {
          if (out.reason === "error") return { kind: "fail", error: out.error, retryable: true };
          await emit(ctx.q, { type: "ai.output_invalid", companyId: ctx.companyId, actor: { kind: "agent", id: "triage", runId: out.runId }, subject: { type: "application", id: app.id }, payload: { error: out.error, reason: out.reason }, correlationId: ctx.run.id });
          return unscored(ctx, app, "not_scored");
        }
        // `overall` and `confidence` are columns nothing reads any more: a reading carries neither.
        const [row] = await ctx.q.insert(assessments).values({ companyId: ctx.companyId, applicationId: app.id, kind: "triage", packetVersion: prepared.version, aiRunId: out.runId, result: out.output, overall: "", confidence: "" }).returning({ id: assessments.id });
        await ctx.q.update(applications).set({ latestAssessmentId: row.id }).where(eq(applications.id, app.id));
        await emit(ctx.q, { type: "assessment.created", companyId: ctx.companyId, actor: { kind: "agent", id: "triage", runId: out.runId }, subject: { type: "application", id: app.id }, payload: { kind: "triage", assessmentId: row.id }, correlationId: ctx.run.id });
        await toTriaged(ctx, app, { assessmentId: row.id, noScore: null });
        return { kind: "complete" };
      },
    }),
  },
};

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

/** Whether a reading made against `version` of the job answers what the job asks for now: the same must-haves and skills, worded and weighted the same. */
async function answersLive(q: Tx, loaded: Loaded, version: number): Promise<boolean> {
  if (version === loaded.live.version) return true;
  const [read] = await q.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, loaded.app.roleId), eq(rolePackets.version, version))).limit(1);
  return !!read && sameRequirements(read.packet, loaded.live.packet);
}

/**
 * Whether this application is still to be read: the person is in the process, their job is not closed, and they have no
 * reading yet, or their newest one was made against other must-haves or skills than the job asks for now.
 */
async function toRead(q: Tx, loaded: Loaded): Promise<boolean> {
  const { app, role } = loaded;
  if (!inProcess(app.stage) || role.status === "closed") return false;
  const [newest] = await q.select({ packetVersion: assessments.packetVersion }).from(assessments).where(and(eq(assessments.applicationId, app.id), eq(assessments.kind, "triage"))).orderBy(desc(assessments.createdAt), desc(assessments.id)).limit(1);
  return !newest || !(await answersLive(q, loaded, newest.packetVersion));
}

/**
 * How the run ends when nothing is to be read (`toRead`), or null to go on. Someone who left the process is not read and
 * no AI help is spent on them; someone whose job closed, or who has their reading, is seen by the team as they are.
 */
async function noReading(ctx: StepContext<State>, loaded: Loaded): Promise<StepResult<State> | null> {
  if (await toRead(ctx.q, loaded)) return null;
  if (!inProcess(loaded.app.stage)) return { kind: "complete" };
  await toTriaged(ctx, loaded.app, { assessmentId: null, noScore: loaded.role.status === "closed" ? "not_scored" : null });
  return { kind: "complete" };
}

/** The CV file once it can be read: checked, clean and with text. Null for no file, a refused one, or one with no text. */
async function readableCv(q: Tx, app: { resumeDocumentId: string | null }): Promise<{ id: string; filename: string; text: string } | null> {
  if (!app.resumeDocumentId) return null;
  const [doc] = await q.select().from(documents).where(eq(documents.id, app.resumeDocumentId)).limit(1);
  return doc?.status === "clean" && doc.textExtracted?.trim() ? { id: doc.id, filename: doc.filename, text: doc.textExtracted } : null;
}

/** The person reaches New (`triaged`), once, with their reading or the reason there is none. */
async function toTriaged(ctx: StepContext<State>, app: { id: string; stage: string }, payload: { assessmentId: string | null; noScore: Unscored | null }): Promise<void> {
  if (app.stage !== "applied" && app.stage !== "received") return;
  await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "triaged", by: "system", actor: ctx.actor, correlationId: ctx.run.id });
  await emit(ctx.q, { type: "application.triaged", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload, correlationId: ctx.run.id });
}

/** The person reaches New without a CV score, and the run is over: a person reads the application themselves. */
async function unscored(ctx: StepContext<State>, app: { id: string; stage: string }, noScore: Unscored): Promise<StepResult<State>> {
  await toTriaged(ctx, app, { assessmentId: null, noScore });
  return { kind: "complete" };
}

/**
 * No AI help left: not a failure, and nobody waits on money. The person reaches New unscored, saying why, and the run
 * waits; it comes back through `extract` after a change of plan or when a monthly allowance starts again. Refused only
 * for money held by calls still running, nothing is used up: they stay "being read" and the run looks again in minutes.
 */
async function waitForAiHelp(ctx: StepContext<State>, app: { id: string; stage: string }, refusedHoldUsd: number): Promise<StepResult<State>> {
  const { roomSoon, wait } = await waitForCredit(ctx, "extract", refusedHoldUsd, { creditWaitSince: ctx.state.creditWaitSince ?? ctx.now.toISOString() });
  if (!roomSoon) await toTriaged(ctx, app, { assessmentId: null, noScore: "ai_used_up" });
  return wait;
}

/**
 * Everything a step reads about one application. `packet`: the job version the person applied to, whose form they
 * answered. `live`: the version the job runs on now, which a CV is read against, so an edit made since they applied
 * counts. `holdJob`: the job's row is held to the end of the transaction, so the live version read here is still the
 * live one when the step's reading is stored: an edit of the job waits for it, and then finds it.
 */
async function load(q: Tx, applicationId: string, opts: { holdJob?: boolean } = {}) {
  const [app] = await q.select().from(applications).where(eq(applications.id, applicationId)).limit(1);
  if (!app) return null;
  const [candidate] = await q.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const job = q.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [role] = opts.holdJob ? await job.for("share") : await job;
  const [company] = await q.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  if (!candidate || !role || !company) return null;
  const versions = await q.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), inArray(rolePackets.version, [app.packetVersion, role.currentPacketVersion ?? app.packetVersion])));
  const applied = versions.find((v) => v.version === app.packetVersion);
  if (!applied) return null;
  const live = versions.find((v) => v.version === role.currentPacketVersion) ?? applied;
  return { app, candidate, role, company, packet: asRead(applied.packet), live: { version: live.version, packet: asRead(live.packet) } };
}

/** A stored job version as the job record reads it (an older one gets its form's one list of questions and its skills' importance from the parser); as stored if it cannot be parsed. */
function asRead(stored: RolePacket): RolePacket {
  const parsed = RolePacketSchema.safeParse(stored);
  return parsed.success ? parsed.data : stored;
}
