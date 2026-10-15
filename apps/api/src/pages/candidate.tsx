import { Hono } from "hono";
import type { Vars } from "../middleware/session";
import { applyPages } from "./apply-form";
import { recordPages } from "./application-record";
import { careerPages } from "./careers-pages";
import { chatPages } from "./chat-pages";
import { profilePages } from "./profile-pages";
import { reviewPages } from "./review-page";

/**
 * The public, server-rendered candidate pages, mounted by app.ts. Wave S7 (S7-0) split them into one file per part, so
 * each part can change on its own; the code moved as it was, and every address and name stays the same:
 * - careers-pages.tsx: the careers page, the logo, the job page, the privacy page;
 * - apply-form.tsx: the apply form, the direct upload, sending the application, the receipt;
 * - application-record.tsx: "Lost your link?", the status page (the application record) and its forms;
 * - conversation-frame.tsx, chat-pages.tsx: the screening chat on the web;
 * - review-page.tsx: "Check your answers" (Review & send) and sending them;
 * - profile-pages.tsx: confirming a repeat submission's answers, and what the candidate's record learned;
 * - candidate-shared.tsx: what they all share; journey.tsx: the steps header across applying.
 * The names other files import from here are re-exported below. Owned by no slice: a change here goes through the
 * integrator.
 */
export const candidatePages = new Hono<Vars>();
candidatePages.route("/", careerPages);
candidatePages.route("/", applyPages);
candidatePages.route("/", recordPages);
candidatePages.route("/", chatPages);
candidatePages.route("/", reviewPages);
candidatePages.route("/", profilePages);

export { CONVERSATION_COOKIE, maskEmail } from "./candidate-shared";
export { NO_SCRIPT_MAX_RESUME_BYTES, RECEIPT_COOKIE, applyFormProblem } from "./apply-form";
export { PROGRESS_STEP_LABEL, STATUS_CSS, chatCounts, progressLine, statusDay, type ProgressStep } from "./application-record";
export { SCREEN_BUSY_JS, SCREEN_CSS } from "./conversation-frame";
