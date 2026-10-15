import { APPLY_FORM_MINUTES, formatPayRange, oneVisitMinutes, type JobPreview, type JobPreviewFact } from "@ros/contracts";
import type { IconName, Tone } from "@ros/ui";
import type { AutoActionsOnOpen, BoardChoiceView, ClosingDateResponse, ClosingDateView, LegalCheck, LegalCheckItem, NewVersionResponse, PostingView, PostingsResponse, PublishingState, RolePacket, ShareTarget, ShareView, WhoPosts } from "./api/client";
import { boardNames } from "./role-words";

/**
 * Approving and publishing a role (plan Wave D), the pure parts the pages share: the screen right after approval (D2),
 * the board ticks and who posts (D3, D6), which changes to a live job need approval (D4), the legal check (D5), the
 * closing date (D7), sharing (D8) and what starts on its own once the job is live (D9). No React and no API calls, so
 * every sentence can be checked without a browser (tests/web/publishing.test.ts). Nothing is called done until it was
 * checked: a careers page or a board listing ticks only once its address was checked, Google only once someone saw it.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* The job page preview (D1)                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/** The authenticated preview of one version of the job page, opened in a new tab: never public, never indexed. */
export function previewHref(roleId: string, version: number): string {
  return `/api/v1/roles/${encodeURIComponent(roleId)}/preview?version=${version}`;
}

/**
 * The full job page behind an in-app preview's data address (`/roles/:id/preview?version=N`,
 * `/intake/sessions/:id/preview`): the same address with `/page`, drawn by the public pages' own components.
 */
export function previewPageHref(dataPath: string): string {
  return dataPath.replace(/\/preview(\?|$)/, "/preview/page$1");
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The screen right after approval (D2)                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** How often the screen asks again while publishing is under way; false once there is nothing left to wait for. */
export function pollInterval(state: PublishingState | undefined): number | false {
  if (!state || state.pollAfterSeconds == null) return false;
  return Math.max(2, state.pollAfterSeconds) * 1000;
}

/** A status chip: the word carries the meaning; `done` is a tick, given only once something was checked. */
export type StatusChip = { label: string; tone: Tone; done: boolean; working: boolean };

const WAITS_FOR_CHECK: StatusChip = { label: "Waits for the ITS check", tone: "caution", done: false, working: false };
const GETTING_READY: StatusChip = { label: "Getting it ready", tone: "neutral", done: false, working: true };
const CHECKING: StatusChip = { label: "Checking it is up", tone: "neutral", done: false, working: true };
const UP: StatusChip = { label: "Up and checked", tone: "good", done: true, working: false };
const PAUSED: StatusChip = { label: "Paused", tone: "caution", done: false, working: false };
const CLOSED: StatusChip = { label: "Closed", tone: "neutral", done: false, working: false };

/** The careers page (the job page itself): "Checking it is up" until the worker's check finds it, then a tick. */
export function careersStatus(p: Pick<PostingView, "status"> | undefined, publishing: Pick<PublishingState, "state">): StatusChip {
  if (publishing.state === "waiting_for_company_check") return WAITS_FOR_CHECK;
  if (!p || p.status === "draft" || p.status === "approved") return GETTING_READY;
  switch (p.status) {
    case "live_verified": return UP;
    case "failed": return { label: "The check did not pass", tone: "critical", done: false, working: false };
    case "paused": return PAUSED;
    case "closed": return CLOSED;
    default: return CHECKING;
  }
}

/**
 * The Google listing: sent through the job page's own data, and marked found only once someone sees it in Google. The
 * pages live on ITS's domain with no Search Console of the company's own, so no time is promised (14 Sep decision).
 */
export function googleStatus(p: Pick<PostingView, "status"> | undefined, publishing: Pick<PublishingState, "state">): StatusChip {
  if (publishing.state === "waiting_for_company_check") return WAITS_FOR_CHECK;
  if (!p || p.status === "draft" || p.status === "approved") return GETTING_READY;
  switch (p.status) {
    case "live_verified": return { label: "Found in Google", tone: "good", done: true, working: false };
    case "failed": return { label: "Not sent yet", tone: "critical", done: false, working: false };
    case "paused": return PAUSED;
    case "closed": return CLOSED;
    default: return { label: "Sent to Google", tone: "neutral", done: false, working: false };
  }
}

/** A board listing: who has it (ITS or the team), then "Checking it is up", then a tick once the address was checked. */
export function boardStatus(p: Pick<PostingView, "status" | "postedBy" | "task" | "showsOldVersion" | "closureRequired" | "closureConfirmedAt"> | undefined, publishing: Pick<PublishingState, "state">): StatusChip {
  if (publishing.state === "waiting_for_company_check") return WAITS_FOR_CHECK;
  if (!p || p.status === "draft" || p.status === "approved") return GETTING_READY;
  switch (p.status) {
    case "live_verified": return p.showsOldVersion ? { label: "Shows the earlier version", tone: "caution", done: false, working: false } : UP;
    case "posted_manually": return CHECKING;
    case "failed": return { label: "The check did not pass", tone: "critical", done: false, working: false };
    case "paused": return PAUSED;
    case "closed": return p.closureRequired && !p.closureConfirmedAt ? { label: "Still up: to be taken down", tone: "critical", done: false, working: false } : CLOSED;
    default: break;
  }
  // ready to post: nothing is on the board yet
  if (p.postedBy !== "its") return { label: "Waiting for you to post it", tone: "caution", done: false, working: false };
  // ITS closed its task as not possible: never "done", and the Share tab has its words and "Ask ITS again".
  if (p.task && p.task.status === "resolved" && p.task.notDone) return { label: "ITS could not post it", tone: "caution", done: false, working: false };
  if (p.task && (p.task.status === "claimed" || p.task.status === "in_progress")) return { label: p.task.recruiterName ? `${p.task.recruiterName} at ITS is posting it` : "ITS is posting it", tone: "neutral", done: false, working: true };
  return { label: "Waiting for ITS", tone: "neutral", done: false, working: false };
}

/** Who posts a board, in one line. */
export function whoPostsLine(postedBy: PostingView["postedBy"] | WhoPosts, board: string): string {
  return postedBy === "its" ? `ITS is posting this on ${board} from your company's own account.` : `You post this on ${board} from your own account. The Share tab has the words to paste and the steps.`;
}

/** One place the job is going, as the screen right after approval lists it. */
export type Destination = { key: string; icon: IconName; name: string; detail: string; status: StatusChip; url?: string | null; copy?: { text: string; what: string } | null };

/**
 * Where the job is going (D2): the careers page with its address, Google, the email address for applications only
 * while it works, then each chosen board with who posts it. Boards chosen but not prepared yet show "Getting it ready".
 */
export function destinationsOf(d: Pick<PostingsResponse, "postings" | "publishing" | "urls" | "emailIn" | "boards" | "closingDate">): Destination[] {
  const find = (channel: string) => d.postings.find((p) => p.channel === channel);
  const careers = find("careers_page");
  const google = find("google_jobs");
  const out: Destination[] = [
    { key: "careers_page", icon: "building", name: "Your careers page", detail: d.closingDate.applyBy ? `${d.urls.job} · ${d.closingDate.applyBy}` : d.urls.job, status: careersStatus(careers, d.publishing), url: d.urls.job, copy: { text: d.urls.job, what: "the job page address" } },
    { key: "google_jobs", icon: "search", name: "Google", detail: "Marked found once someone sees it in a Google search. Google lists jobs on its own schedule.", status: googleStatus(google, d.publishing) },
  ];
  if (d.emailIn.shown && d.emailIn.address) {
    out.push({ key: "email_in", icon: "mail", name: "Applications by email", detail: d.emailIn.address, status: { label: "Working", tone: "good", done: true, working: false }, copy: { text: d.emailIn.address, what: "the email address" } });
  }
  const chosen = d.boards.filter((b) => b.chosen);
  for (const b of chosen) {
    const p = find(b.channel);
    if (p && p.status === "closed" && !p.stillUp) continue;
    out.push({ key: b.channel, icon: "briefcase", name: b.name, detail: whoPostsLine(p?.postedBy ?? null, b.name), status: boardStatus(p, d.publishing), url: p?.externalUrl ?? null });
  }
  return out;
}

/** What saving the board ticks did (D6): the boards now chosen, what happens to the ones added and taken off. */
export function boardTicksToast(input: { before: readonly string[]; after: readonly string[]; roleStatus: string; whoPosts: WhoPosts }): { title: string; detail?: string } {
  const added = input.after.filter((c) => !input.before.includes(c));
  const removed = input.before.filter((c) => !input.after.includes(c));
  const title = input.after.length ? `Boards saved: ${boardNames([...input.after])}.` : "No job boards for this job.";
  if (input.roleStatus !== "open" && input.roleStatus !== "paused") return { title, detail: "Nothing is posted until the job is approved; the ticked boards are prepared then." };
  const its = input.whoPosts === "its";
  const parts: string[] = [];
  if (added.length) parts.push(input.roleStatus === "paused" ? `${boardNames(added)} ${added.length === 1 ? "is" : "are"} prepared when you resume the job.` : its ? `ITS posts the job on ${boardNames(added)} from your company's account.` : `${boardNames(added)} ${added.length === 1 ? "is" : "are"} being prepared for you to post.`);
  if (removed.length) parts.push(`${boardNames(removed)} closed${its ? "; ITS takes the listing down if it was up." : "; take the listing down from your own account if it was up."}`);
  return { title, detail: parts.join(" ") || undefined };
}

/** The line under the list when no board was ticked for the job, or null. */
export function noBoardsLine(boards: readonly BoardChoiceView[]): string | null {
  if (boards.some((b) => b.chosen)) return null;
  return "No job boards were chosen for this job. You can add LinkedIn or Indeed from the Share tab at any time.";
}

/** The note when interview rounds have nobody on them yet, or null. */
export function interviewersNote(i: { rounds: number; roundsWithoutInterviewers: number }): string | null {
  if (!i.rounds || !i.roundsWithoutInterviewers) return null;
  const when = "Choose who interviews now, so the first good applicants can be offered times straight away.";
  if (i.roundsWithoutInterviewers === i.rounds) return `Nobody is set to interview yet. ${when}`;
  return `${i.roundsWithoutInterviewers} of the ${i.rounds} interview rounds have nobody set to interview yet. ${when}`;
}

/** The boards an approved edit left showing the earlier version, and who brings them up to date. */
export function outdatedBoardsLine(channels: readonly string[], whoPosts: WhoPosts): string | null {
  if (!channels.length) return null;
  const one = channels.length === 1;
  const names = boardNames([...channels]);
  return whoPosts === "its"
    ? `${names} still ${one ? "shows" : "show"} the earlier version. ITS has a task to update ${one ? "it" : "them"} from your company's account.`
    : `${names} still ${one ? "shows" : "show"} the earlier version. Update ${one ? "it" : "them"} from your own account, then confirm on the Share tab.`;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* What starts on its own (D9) and the legal check (D5) on the approval card                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/** One plain line: what happens without anyone pressing anything once the job is live. */
export function autoActionsLine(a: Pick<AutoActionsOnOpen, "lines"> | null | undefined): string | null {
  if (!a?.lines.length) return null;
  return `Once it is live: ${a.lines.map((l) => l.text).join(" ")}`;
}

/** The legal check as the card shows it: what is missing (approving waits for these), then what is in order. */
export function legalLines(check: LegalCheck | null | undefined): { missing: LegalCheckItem[]; inOrder: LegalCheckItem[] } {
  if (!check) return { missing: [], inOrder: [] };
  const missing = check.items.filter((i) => i.blocking && !i.met);
  return { missing, inOrder: check.items.filter((i) => !missing.includes(i)) };
}

/** Whether the reason approval is held is the legal check (the card then lists the items instead of repeating it). */
export function isLegalReason(reason: string | null | undefined): boolean {
  return !!reason && reason.startsWith("Before this job can go live, the law where it is asks for");
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Live edits (D4, founder decision Q10)                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** What an edit to a live job changes that needs the same approval as a new role. */
export type MaterialChange = "pay" | "title" | "location" | "eligibility";
export const MATERIAL_WORDS: Record<MaterialChange, string> = { pay: "the pay", title: "the job title", location: "where the job is", eligibility: "the questions on the application form" };

/** Deep equality that ignores key order and missing keys, like the server's. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]));
  return v;
}
export function samePacketPart(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));
}

/**
 * The same rule as the server (apps/api services/packet-versions.ts `materialChanges`): the pay (range, basis, ceiling,
 * bonus, benefits, whether the range is shown), the title, the places or the work model, and the eligibility questions.
 * The page says so before saving; the server decides.
 */
export function materialChangesOf(before: RolePacket, after: RolePacket): MaterialChange[] {
  const out: MaterialChange[] = [];
  const a = before.compensation as RolePacket["compensation"] & { currency?: string; bonus?: string };
  const b = after.compensation as RolePacket["compensation"] & { currency?: string; bonus?: string };
  if (a.basis !== b.basis || (a.currency ?? null) !== (b.currency ?? null) || a.min !== b.min || a.max !== b.max || a.ceiling !== b.ceiling || (a.mid ?? null) !== (b.mid ?? null) || (a.bonus ?? "") !== (b.bonus ?? "") || (a.benefitsSummary ?? "") !== (b.benefitsSummary ?? "") || a.discloseRange !== b.discloseRange) out.push("pay");
  if (before.identity.title.trim() !== after.identity.title.trim()) out.push("title");
  if (!samePacketPart(before.identity.locations, after.identity.locations) || before.identity.remotePolicy !== after.identity.remotePolicy) out.push("location");
  if (!samePacketPart(before.requirements.eligibility, after.requirements.eligibility)) out.push("eligibility");
  return out;
}

/** "the pay and the job title". */
export function wordsList(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items.join("");
}

/** What confirming an approver's edit to a live job will do, before anything is saved. */
export function liveEditWords(material: readonly MaterialChange[]): { heading: string; body: string; confirm: string } {
  if (material.length) {
    return {
      heading: "This change needs approval",
      body: `It changes ${wordsList(material.map((m) => MATERIAL_WORDS[m]))}, so it needs the same approval as a new role before it goes live. Until then the job keeps running as it is.`,
      confirm: "Save and ask for approval",
    };
  }
  return {
    heading: "This change goes live when you confirm",
    body: "It changes only the wording, so the job page shows it as soon as you confirm. Have a look first.",
    confirm: "Make it live",
  };
}

/** What a saved version became, in two short lines (the boards still showing the earlier version included). */
export function savedVersionToast(r: NewVersionResponse, whoPosts: WhoPosts): { title: string; detail?: string } {
  const guard = r.guardChanges?.length ? r.guardChanges.join(" ") : "";
  const join = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" ") || undefined;
  // a paused job shows the version only when it resumes
  if (r.outcome === "approved_current" && r.paused) return { title: `Version ${r.version} is current.`, detail: join("It shows when you resume the job.", guard) };
  if (r.outcome === "approved_current") return { title: `Version ${r.version} is live.`, detail: join(outdatedBoardsLine(r.boardsShowingOldVersion ?? [], whoPosts) ?? "The job page shows it now.", guard) };
  if (r.outcome === "proposed_pending_approval") {
    if (r.needsApproval) return { title: `Saved as version ${r.version}. It waits for approval.`, detail: join(r.needsApproval.words, r.needsApproval.youMayConfirm ? "As the company's only owner, you confirm it yourself on the approval card at the top of the role page." : "The job keeps running as it is until then.", guard) };
    return { title: `Saved as version ${r.version}. It takes effect once an approver says yes.`, detail: join(guard) };
  }
  if (r.outcome === "proposed") return { title: `Saved as version ${r.version} with the draft.`, detail: join(guard) };
  return { title: `Saved as version ${r.version}.`, detail: join(guard) };
}

const WORK_MODEL_LABEL: Record<string, string> = { onsite: "On site", hybrid: "Hybrid", remote: "Remote" };
const EMPLOYMENT_LABEL: Record<string, string> = { full_time: "Full time", part_time: "Part time", contract: "Contract", temporary: "Temporary", per_diem: "Per diem", internship: "Internship" };

/**
 * The job page with an approver's unsaved changes (D1, before a live edit): the saved version's preview, built by the
 * server, with the changed words laid over it by the job page's own rules. Only wording goes live at once; anything
 * that changes the notices (the pay or the place) waits for approval, where the saved version is previewed by the server.
 */
export function previewOfEdit(base: JobPreview, packet: RolePacket): JobPreview {
  const places = packet.identity.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).filter(Boolean);
  const facts: JobPreviewFact[] = [];
  if (places[0]) facts.push({ key: "location", label: "Location", text: places[0] });
  facts.push({ key: "workplace", label: "Workplace", text: WORK_MODEL_LABEL[packet.identity.remotePolicy] ?? packet.identity.remotePolicy });
  facts.push({ key: "job_type", label: "Job type", text: EMPLOYMENT_LABEL[packet.identity.employmentType] ?? packet.identity.employmentType.replace(/_/g, " ") });
  if (base.pay.shown) facts.push({ key: "pay", label: "Pay", text: formatPayRange(packet.compensation) });
  if (packet.identity.schedule) facts.push({ key: "schedule", label: "Schedule", text: packet.identity.schedule });
  // The steps as the server words them (apps/api services/job-preview.ts `applySteps`), with the times and the number of
  // questions worked out again from the edited packet: applying in one visit counts the conversation in its time (plan E8).
  const oneVisit = /including a short written conversation/.test(base.job.steps[0] ?? "");
  const first = oneVisit ? base.job.steps[0].replace(/about \d+ minutes/, `about ${oneVisitMinutes(packet)} minutes`) : base.job.steps[0] ?? `Send a short form, about ${APPLY_FORM_MINUTES} minutes. We confirm by email.`;
  const screen = (base.job.steps[1] ?? "").replace(/\d+ questions/, `${packet.screening.questions.length} questions`).replace(/about \d+ minutes/, `about ${packet.screening.maxMinutes} minutes`);
  const last = base.job.steps[base.job.steps.length - 1] ?? "A decision, and a real answer either way.";
  return {
    ...base,
    notPublicYet: true,
    banner: "Your changes, not saved yet: this is how the job page would look. Nothing changes until you confirm.",
    job: {
      ...base.job,
      title: packet.identity.title,
      facts,
      locations: places,
      description: packet.description.publicJobDescription,
      // The lists' words as the job page shows them (plan D10); the benefits are the role's own, else as saved.
      mustHaves: packet.requirements.mustHaves.map((m) => m.text),
      niceToHaves: packet.requirements.niceToHaves.map((m) => m.text),
      benefits: packet.compensation.benefitsSummary?.trim() || base.job.benefits,
      steps: [first, ...(screen ? [screen] : []), ...packet.interviews.plan.map((r) => `${r.title} (${r.durationMinutes} minutes)`), last],
    },
    pay: base.pay.shown ? { ...base.pay, text: formatPayRange(packet.compensation) } : base.pay,
    apply: {
      ...base.apply,
      questions: packet.requirements.eligibility.map((rule) => {
        const days = (rule as unknown as { expectation?: { days?: unknown } }).expectation?.days;
        return { key: rule.key, question: rule.question, help: rule.rationale, answer: rule.type === "schedule_availability" && Array.isArray(days) && days.length > 0 ? ("days" as const) : ("yes_no" as const) };
      }),
    },
  };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The closing date (D7, founder decision Q12)                                                                    */
/* ------------------------------------------------------------------------------------------------------------ */

/** "Friday, October 30, 2026": the date itself, never shifted by the browser's zone. */
export function dayWords(day: string, withYear = true): string {
  return new Date(`${day.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
}

/** "Pacific Time": the company's zone in words; the zone's id when the browser cannot name it. */
export function zoneWords(timeZone: string): string {
  for (const style of ["longGeneric", "long"] as const) {
    try {
      const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: style }).formatToParts(new Date(Date.UTC(2026, 0, 15))).find((p) => p.type === "timeZoneName")?.value;
      if (name) return name;
    } catch {
      // an older browser without this style: try the next one
    }
  }
  return timeZone;
}

/** Today's date in a time zone, as YYYY-MM-DD (the earliest a closing date may be). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** A calendar day `days` after `day` (both YYYY-MM-DD). */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The closing date in one sentence, for the role page, the Posting tab and the editor. */
export function closingDateLine(c: ClosingDateView): string {
  if (c.applicationsClosedByDate) return `The closing date${c.closesOn ? `, ${dayWords(c.closesOn)},` : ""} has passed, so new applications stopped. Nobody was turned away, and everyone who applied is where they were.`;
  if (c.closesOn) return `${c.applyBy ?? `Apply by ${dayWords(c.closesOn)}`}. New applications stop at the end of that day (${zoneWords(c.timeZone)}); anyone part-way through can still finish.`;
  if (c.requiredByLaw && c.defaultIfMissing) return `The law in Colorado asks the job ad to say when applications close. Without a date of your own it will be ${dayWords(c.defaultIfMissing)}, and you can change it at any time.`;
  return "No closing date: the job takes applications until you stop them.";
}

/** Why a closing date cannot be saved, or null. */
export function closingDateProblem(value: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Choose a date.";
  if (value < today) return "Choose today or a later date. A date in the past would stop applications at once.";
  return null;
}

/** What saving the date did, in two short lines. */
export function closingDateToast(r: Pick<ClosingDateResponse, "reopened" | "closingDate">): { title: string; detail?: string } {
  const on = r.closingDate.closesOn;
  if (r.reopened && on) return { title: `Taking applications again until ${dayWords(on, false)}.`, detail: "The job page shows the apply button again. Emails that arrived meanwhile were added." };
  if (on) return { title: `Applications close at the end of ${dayWords(on, false)}.`, detail: "The job page and the careers page show the date." };
  return { title: "Closing date taken off.", detail: "The job takes applications until you stop them." };
}

/** Whether a brief card's button sets a closing date (it posts the date itself, nothing else). */
export function isClosingDateAction(a: { method: string; path: string }): boolean {
  return a.method === "POST" && /\/roles\/[^/]+\/closing-date$/.test(a.path);
}

/**
 * Whether the law asks the job ad for a closing date, before the role exists (the job builder): Colorado, or a remote
 * job someone in Colorado could do. The same rule as the server's `closingDateRequired`, which has the last word.
 */
export function closingDateRequiredFor(input: { locations?: ReadonlyArray<{ region?: string | null }> | null; remotePolicy?: string | null; locationText?: string | null }): boolean {
  if (input.remotePolicy === "remote") return true;
  if ((input.locations ?? []).some((l) => (l.region ?? "").trim().toUpperCase() === "CO")) return true;
  return /\b(CO|Colorado)\b/.test(input.locationText ?? "");
}

/**
 * The job builder keeps a chosen closing date on the draft in this browser until the role exists (the date belongs to
 * the role, which "Ask for approval" creates); it is set on the role then, and forgotten here.
 */
export function draftClosingDateKey(sessionId: string): string {
  return `ros:draft-closes-on:${sessionId}`;
}
export function readDraftClosingDate(storage: Pick<Storage, "getItem"> | null | undefined, sessionId: string): string {
  try {
    const v = storage?.getItem(draftClosingDateKey(sessionId)) ?? "";
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "";
  } catch {
    return "";
  }
}
export function writeDraftClosingDate(storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined, sessionId: string, value: string): void {
  try {
    if (value) storage?.setItem(draftClosingDateKey(sessionId), value);
    else storage?.removeItem(draftClosingDateKey(sessionId));
  } catch {
    // a browser that keeps nothing (private windows, blocked storage): the date lasts until the page is reloaded
  }
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Sharing (D8): plain links only, no script from any network ever loads on our pages                             */
/* ------------------------------------------------------------------------------------------------------------ */

/** The share buttons, in the order they are shown. */
export const SHARE_BUTTONS: ReadonlyArray<{ key: ShareTarget["key"]; label: string; icon: IconName }> = [
  { key: "email", label: "Email", icon: "mail" },
  { key: "text", label: "Text message", icon: "message" },
  { key: "whatsapp", label: "WhatsApp", icon: "message" },
  { key: "linkedin", label: "LinkedIn", icon: "share" },
  { key: "facebook", label: "Facebook", icon: "share" },
  { key: "x", label: "X", icon: "share" },
];

/** The ready-made places that get their own tracked link to copy: a referral, a school, a community group. */
export const SHARE_PLACES_TO_COPY = ["referral", "school", "community"] as const;

/** Whether a share button opens the person's own app (email, texts) rather than a network's page in a new tab. */
export function opensOwnApp(key: ShareTarget["key"]): boolean {
  return key === "email" || key === "text";
}

/** The share text with a place's own link in place of the job page's address (the server's text ends with it). */
export function shareTextFor(share: Pick<ShareView, "text" | "jobUrl">, linkUrl: string): string {
  if (share.text.endsWith(share.jobUrl)) return `${share.text.slice(0, -share.jobUrl.length)}${linkUrl}`;
  return `${share.text} ${linkUrl}`;
}

/** The subject of a shared email: "Bright Dental is hiring: Dental hygienist". */
export function shareSubject(companyName: string | null | undefined, roleTitle: string): string {
  return companyName ? `${companyName} is hiring: ${roleTitle}` : `We are hiring: ${roleTitle}`;
}

/**
 * Each share button's address for a link, built exactly as the server builds them (apps/api services/job-urls.ts
 * `shareTargets`), so a place that already has its link is a plain link with no request at all.
 */
export function shareTargetsFor(input: { url: string; text: string; subject: string }): ShareTarget[] {
  const enc = encodeURIComponent;
  const withoutUrl = input.text.endsWith(input.url) ? input.text.slice(0, -input.url.length).trim() : input.text;
  return [
    { key: "email", label: "Email", url: `mailto:?subject=${enc(input.subject)}&body=${enc(input.text)}` },
    { key: "text", label: "Text message", url: `sms:?&body=${enc(input.text)}` },
    { key: "whatsapp", label: "WhatsApp", url: `https://wa.me/?text=${enc(input.text)}` },
    { key: "linkedin", label: "LinkedIn", url: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(input.url)}` },
    { key: "facebook", label: "Facebook", url: `https://www.facebook.com/sharer/sharer.php?u=${enc(input.url)}` },
    { key: "x", label: "X", url: `https://x.com/intent/post?text=${enc(withoutUrl)}&url=${enc(input.url)}` },
  ];
}

/** "3 visits". */
export function visitsWords(n: number): string {
  return `${n} ${n === 1 ? "visit" : "visits"}`;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* ITS posting tasks (D3)                                                                                         */
/* ------------------------------------------------------------------------------------------------------------ */

const POSTING_TASK_TITLE: Record<string, string> = { post_job: "Post a job", update_job: "Update a job listing", take_down_job: "Take a job listing down" };

export function isPostingTaskKind(kind: string): boolean {
  return kind in POSTING_TASK_TITLE;
}

/** A request's kind in the queue, in words: the posting tasks by name, the rest as before. */
export function queueKindLabel(kind: string): string {
  return POSTING_TASK_TITLE[kind] ?? kind.replace(/_/g, " ");
}

/** Before accepting a posting task: what accepting opens, and that it opens nothing about candidates. */
export const POSTING_TASK_BEFORE_ACCEPT = "Accept the task to open the job ad, the board's own apply link and the steps. A posting task never opens the customer's candidates: there is no access to grant, and every opening is recorded for the customer.";

/* ------------------------------------------------------------------------------------------------------------ */
/* Setup: the logo and the company's "about" text (Q13)                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

export const LOGO_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** Why a chosen logo file cannot be used, or null. Pictures only, small enough for a job page. */
export function logoProblem(file: { type: string; size: number }): string | null {
  if (!LOGO_TYPES.includes(file.type)) return "Use a PNG, JPG or WebP picture.";
  if (file.size > LOGO_MAX_BYTES) return "That picture is larger than 2 MB. Use a smaller one.";
  if (file.size === 0) return "That file is empty.";
  return null;
}

export const ABOUT_MIN = 40;
export const ABOUT_MAX = 1200;

/** Why the "about" text cannot be approved as it is, or null. */
export function aboutProblem(text: string): string | null {
  const t = text.trim();
  if (t.length < ABOUT_MIN) return "Write a few sentences about the company (at least 40 characters).";
  if (t.length > ABOUT_MAX) return `Keep it under ${ABOUT_MAX} characters; candidates read it on a phone.`;
  return null;
}

/** The drafted text from the assistant's answer, whichever shape it comes in. */
export function aboutDraftOf(r: unknown): string {
  const o = (r ?? {}) as { text?: unknown; draft?: { text?: unknown } | string; about?: { text?: unknown } };
  if (typeof o.text === "string") return o.text;
  if (typeof o.draft === "string") return o.draft;
  if (o.draft && typeof o.draft.text === "string") return o.draft.text;
  if (o.about && typeof o.about.text === "string") return o.about.text;
  return "";
}

/** The wording check on the assistant's draft (a phrase that can stand in for a protected trait), or null. */
export function aboutCheckOf(r: unknown): { text: string; reason: string; alternative: string } | null {
  const c = ((r ?? {}) as { draft?: { check?: { text?: unknown; reason?: unknown; alternative?: unknown } | null } | string }).draft;
  const check = c && typeof c === "object" ? c.check : null;
  if (!check || typeof check.text !== "string" || typeof check.reason !== "string") return null;
  return { text: check.text, reason: check.reason, alternative: typeof check.alternative === "string" ? check.alternative : "" };
}

/** The new logo address from the upload's answer, whichever shape it comes in. */
export function logoUrlOf(r: unknown): string | null {
  const o = (r ?? {}) as { logoUrl?: unknown; settings?: { logoUrl?: unknown } };
  if (typeof o.logoUrl === "string" && o.logoUrl) return o.logoUrl;
  if (typeof o.settings?.logoUrl === "string" && o.settings.logoUrl) return o.settings.logoUrl;
  return null;
}
