import { Hono } from "hono";
import type { Vars } from "../middleware/session";
import { applyPages } from "./apply-form";
import { recordPages } from "./application-record";
import { careerPages } from "./careers-pages";
import { chatPages } from "./chat-pages";
import { reviewPages } from "./review-page";

/**
 * The public, server-rendered candidate pages, mounted by app.ts, one file per part:
 * - careers-pages.tsx: the careers page, the logo, the job page, the privacy page;
 * - apply-form.tsx: the application form, the direct upload, sending the application, the receipt;
 * - application-record.tsx: "Lost your link?", the status page and its forms;
 * - conversation-frame.tsx, chat-pages.tsx: the AI interview;
 * - review-page.tsx: "Check your answers" and sending them;
 * - candidate-shared.tsx: what they all share.
 * The names other files import from here are re-exported below.
 */
export const candidatePages = new Hono<Vars>();
candidatePages.route("/", careerPages);
candidatePages.route("/", applyPages);
candidatePages.route("/", recordPages);
candidatePages.route("/", chatPages);
candidatePages.route("/", reviewPages);

export { maskEmail } from "./candidate-shared";
export { NO_SCRIPT_MAX_RESUME_BYTES, RECEIPT_COOKIE, applyFormProblem } from "./apply-form";
export { STATUS_CSS, statusDay } from "./application-record";
export { SCREEN_BUSY_JS, SCREEN_CSS } from "./conversation-frame";
