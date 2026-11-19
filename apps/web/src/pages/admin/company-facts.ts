import type { AdminAiCredit, AdminCompany, AdminCompanyStatus, CustomerAccessAnswer, CustomerAccessChange, CustomerAccessRequest, RoleStatus, TrialStanding, TrialTerm } from "@ros/contracts";
import type { Tone } from "@ros/ui";
import { ApiError } from "../../api/client";
import { verticalWords, websiteHref } from "../../company-setup";
import { placeWords } from "../../jobs";
import { trialDate } from "../../trial";
import { exactWhen, money } from "./admin-words";

/**
 * The Companies page and one company's drawer, the parts that need no browser, kept out of the pages so they can be
 * tested. Every status word, plan name, usage line and count comes from the API; these only lay them out. The API
 * also says which access decisions a company takes now (`accessDecisions`); nothing here works that out.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* The list: filters, search, the address                                                                         */
/* ------------------------------------------------------------------------------------------------------------ */

/** The filters over the list, each its own `?show=` (none for All). */
export type CompanyFilter = "all" | "waiting" | "declined";
export const COMPANY_FILTERS: ReadonlyArray<{ id: CompanyFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "waiting", label: "Waiting" },
  { id: "declined", label: "Declined" },
];

export function companyFilterFrom(value: string | null): CompanyFilter {
  return COMPANY_FILTERS.find((f) => f.id === value)?.id ?? "all";
}

/** Whether a company belongs under a filter: everyone under All, and each of the other two by its status. */
export function companyInFilter(c: Pick<AdminCompany, "status">, filter: CompanyFilter): boolean {
  return filter === "all" || c.status === filter;
}

/** Whether a company matches what was typed: its name, kind of business, careers address or website, or the person who asked or owns it. */
export function companyMatches(c: Pick<AdminCompany, "name" | "vertical" | "slug" | "website" | "accessRequest" | "owner">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const person = c.accessRequest?.person ?? c.owner;
  return [c.name, verticalWords(c.vertical), c.slug, c.website ?? "", person?.name ?? "", person?.email ?? ""].some((v) => v.toLowerCase().includes(q));
}

/** The address after a change to the list or its drawer, with everything else in it kept. */
export function companiesSearch(search: URLSearchParams, patch: { open?: string | null; show?: CompanyFilter }): string {
  const next = new URLSearchParams(search);
  if (patch.open === null) next.delete("open");
  else if (patch.open !== undefined) next.set("open", patch.open);
  if (patch.show !== undefined) {
    if (patch.show === "all") next.delete("show");
    else next.set("show", patch.show);
  }
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}

/** The colour of a company's status dot. The word beside it is the API's `statusLabel`. */
export function companyStatusTone(status: AdminCompanyStatus): Tone {
  return status === "active" ? "good" : status === "waiting" ? "caution" : "neutral";
}

/** The colour of a job's status dot. The word beside it is the API's `statusLabel`. */
export function jobStatusTone(status: RoleStatus): Tone {
  return status === "open" ? "good" : status === "paused" ? "caution" : "neutral";
}

/** "2 of 5 open", or "None" for a company with no job yet. */
export function jobsWords(jobs: AdminCompany["jobs"]): string {
  return jobs.total ? `${jobs.open} of ${jobs.total} open` : "None";
}

/* ------------------------------------------------------------------------------------------------------------ */
/* A request, and a company's details                                                                             */
/* ------------------------------------------------------------------------------------------------------------ */

const DAY = 86_400_000;

/** How long a company has waited for an answer: "Waiting since today", "Waiting 1 day", "Waiting 3 days". */
export function waitingWords(createdAt: string, now: number = Date.now()): string {
  const days = Math.floor((now - Date.parse(createdAt)) / DAY);
  return days < 1 ? "Waiting since today" : `Waiting ${days} ${days === 1 ? "day" : "days"}`;
}

/** One fact in a line of them: words, and the address they may link to (only a typed website has one, and only when `websiteHref` lets it). */
export type LineFact = { text: string; href?: string };

/** A company's places in words: "Austin, TX; Dallas, TX". */
export function placesWords(locations: AdminCompany["locations"]): string {
  return locations.map(placeWords).filter(Boolean).join("; ");
}

/**
 * Who is asking, on a request's row: the address their sign-in proved first, then the name they typed, so a name
 * cannot pass for someone else's address; then where the company is and how long it has waited. All of it but the
 * email was typed by a stranger, so it is only ever drawn as text.
 */
export function requestFacts(c: Pick<AdminCompany, "accessRequest" | "locations" | "createdAt">, now: number = Date.now()): LineFact[] {
  const person = c.accessRequest?.person;
  const place = placesWords(c.locations);
  return [person?.email, person?.name, place, c.accessRequest?.status === "requested" ? waitingWords(c.createdAt, now) : null].filter((v): v is string => !!v).map((text) => ({ text }));
}

/** When a request was declined and by whom: "Nov 6, 2026, 3:10 PM by Ada Admin". */
export function declinedWhen(declined: CustomerAccessRequest["declined"]): string {
  return declined ? `${exactWhen(declined.at)}${declined.by ? ` by ${declined.by}` : ""}` : "";
}

/**
 * A company's details as label and value rows: who asked (a request) or who owns it (an accepted company), the kind
 * of business and its size, where it is, its website (a link only when it is really one), when it signed up and its
 * careers page while it is live. A row with nothing to say is left out.
 */
export function companyDetails(c: Pick<AdminCompany, "accessRequest" | "owner" | "vertical" | "sizeBand" | "locations" | "website" | "createdAt" | "careersUrl">): Array<{ label: string; facts: LineFact[] }> {
  const person = c.accessRequest?.person ?? c.owner;
  const website = c.website?.trim();
  const rows: Array<{ label: string; facts: LineFact[] }> = [
    { label: c.accessRequest ? "Asked by" : "Owner", facts: [person?.email, person?.name].filter((v): v is string => !!v).map((text) => ({ text })) },
    { label: "Business", facts: [{ text: verticalWords(c.vertical) }, { text: `${c.sizeBand} employees` }] },
    { label: "Where", facts: placesWords(c.locations) ? [{ text: placesWords(c.locations) }] : [] },
    { label: "Website", facts: [website ? { text: website, href: websiteHref(website) ?? undefined } : { text: "None given" }] },
    { label: "Signed up", facts: [{ text: exactWhen(c.createdAt) }] },
    { label: "Careers page", facts: c.careersUrl ? [{ text: c.careersUrl, href: websiteHref(c.careersUrl) ?? undefined }] : [] },
  ];
  return rows.filter((r) => r.facts.length);
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Accept, Decline, Take away access                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

export type AccessDecision = CustomerAccessChange["decision"];

const DECISION_WORDS: Record<AccessDecision, { button: string; ask: (company: string) => string; yes: (company: string) => string; no: (company: string) => string }> = {
  accept: { button: "Accept", ask: (c) => `Accept ${c}?`, yes: (c) => `Yes, accept ${c}`, no: (c) => `No, do not accept ${c}` },
  decline: { button: "Decline", ask: (c) => `Decline ${c}?`, yes: (c) => `Yes, decline ${c}`, no: (c) => `No, do not decline ${c}` },
  remove: { button: "Take away access", ask: (c) => `Take away access from ${c}?`, yes: (c) => `Yes, take away access from ${c}`, no: (c) => `No, keep access for ${c}` },
};

/** A decision's button: its words ("Accept", "Take away access") and its name for a screen reader, which says which company. */
export function accessButton(decision: AccessDecision, company: string): { label: string; name: string } {
  const words = DECISION_WORDS[decision];
  return { label: words.button, name: decision === "remove" ? `${words.button} from ${company}` : `${words.button} ${company}` };
}

/** The second press: the question ("Accept Harbor Dental?") and the names of its Yes and No. */
export function accessQuestion(decision: AccessDecision, company: string): { ask: string; yes: string; no: string } {
  const words = DECISION_WORDS[decision];
  return { ask: words.ask(company), yes: words.yes(company), no: words.no(company) };
}

/**
 * What a press sends: the decision, and for Accept and Decline where the request stood on the row that was pressed
 * (`from`), so a press on a row someone else has just decided changes nothing and is told who decided (the first press
 * wins). An accepted company has no request to stand anywhere, so taking its access away sends none.
 */
export function accessPress(company: Pick<AdminCompany, "accessRequest">, decision: AccessDecision): CustomerAccessChange {
  return decision === "remove" ? { decision, confirm: true } : { decision, from: company.accessRequest?.status ?? "requested", confirm: true };
}

/**
 * What a press that was refused says. A 409 means someone else got there first, said as plainly as the API says it;
 * anything else is an error, in the API's words when it has any. Never a claim about what the person was told.
 */
export function accessPressRefused(e: unknown): { title: string; tone?: "critical" } {
  if (!(e instanceof ApiError)) return { title: "Could not record that. Try again.", tone: "critical" };
  return e.status === 409 ? { title: e.message } : { title: e.message, tone: "critical" };
}

/** What is said once a decision was recorded: the API's words; after Take away access also how many people lost it, and that the owner was emailed only when the email really left. */
export function accessToast(answer: Pick<CustomerAccessAnswer, "message" | "people" | "emailed">): { title: string; detail?: string } {
  const people = answer.people ? `${answer.people === 1 ? "1 person" : `${answer.people} people`} can no longer work in it.` : "";
  return { title: answer.message, detail: [people, answer.emailed ? "We emailed the owner." : ""].filter(Boolean).join(" ") || undefined };
}

/** What each decision does, folded under "How this works" beside the buttons. */
export function accessExplained(c: Pick<AdminCompany, "status" | "accessRequest" | "planName">): string {
  if (c.status === "active") return "Its people can no longer work in it, its careers page and job pages go offline and nothing more is emailed to its candidates. Nothing is deleted. Accept brings everyone back.";
  if (c.accessRequest?.removed) return "Accept brings back everyone who lost access, on the same plan, and puts its careers page and job pages back.";
  const accept = `Accept lets them in on the ${c.planName} plan: they can start hiring at once, and their careers page and job pages are public.`;
  return c.status === "waiting" ? `${accept} Decline keeps them out, and you can still accept later.` : accept;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The plan                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------ */

/** "$1.20 of $10 AI credit", or "$4.00 of $20 AI credit this month, resets December 5": dollars, which only an administrator reads. */
export function aiCreditDollars(a: Pick<AdminAiCredit, "monthly" | "spentUsd" | "limitUsd" | "resetsAt">): string {
  const limit = Number.isInteger(a.limitUsd) ? `$${a.limitUsd.toLocaleString("en-US")}` : money(a.limitUsd);
  const resets = a.resetsAt ? `, resets ${new Date(a.resetsAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })}` : "";
  return `${money(a.spentUsd)} of ${limit} AI credit${a.monthly ? ` this month${resets}` : ""}`;
}

/** The chip when a company's AI credit is at 80% or used up. */
export function aiCreditChip(level: AdminAiCredit["level"]): string | null {
  return level === "used_up" ? "AI credit used up" : level === "warning" ? "80% of AI credit used" : null;
}

/** "2 of 3 people", for a plan whose usage lines do not already say it. Invitations not yet answered count too. */
export function seatsWords(seats: AdminCompany["seats"]): string {
  return `${seats.used}${seats.limit !== null ? ` of ${seats.limit}` : ""} people`;
}

/**
 * What is used of the plan, one line each: the usage lines in the API's words, the people when no line says them, and
 * how many applicants the plan keeps locked (a count, never who).
 */
export function planUsage(c: Pick<AdminCompany, "usage" | "seats" | "lockedApplicants">): string[] {
  const lines = c.usage.map((u) => u.words);
  if (!c.usage.some((u) => u.key === "seats")) lines.push(seatsWords(c.seats));
  if (c.lockedApplicants > 0) lines.push(`${c.lockedApplicants} ${c.lockedApplicants === 1 ? "applicant" : "applicants"} locked`);
  return lines;
}

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;

/**
 * What a plan includes, in one line, in dollars: "1 job ever · 5 candidates a job · $10 AI credit in all · 2 seats". A
 * key the plan does not name is left out, and so is a limit that says nothing there: no limit of jobs ever or of
 * candidates a job, the jobs at a time beside one job ever, and unlimited AI interviews on a plan the AI credit meters.
 */
export function planLimitsLine(limits: Record<string, number | null>): string {
  const count = (key: string, one: string, many: string) => (key in limits ? `${limits[key] === null ? "unlimited" : limits[key]} ${limits[key] === 1 ? one : many}` : null);
  const total = limits.ai_credit_total_cents;
  const monthly = limits.ai_credit_monthly_cents;
  const jobsEver = limits.jobs_total;
  const metered = typeof total === "number" || typeof monthly === "number";
  return [
    typeof jobsEver === "number" ? `${jobsEver} ${jobsEver === 1 ? "job" : "jobs"} ever` : count("active_roles", "active job", "active jobs"),
    typeof limits.candidates_per_job === "number" ? `${limits.candidates_per_job} candidates a job` : null,
    metered && limits.text_screens === null ? null : count("text_screens", "AI interview a month", "AI interviews a month"),
    typeof total === "number" ? `${dollars(total)} AI credit in all` : typeof monthly === "number" ? `${dollars(monthly)} AI credit a month` : null,
    count("seats", "seat", "seats"),
  ].filter(Boolean).join(" · ");
}

/** What a plan costs: "$49 a month", "$0 a month". */
export function planPriceLine(prices: Record<string, number> | undefined): string | null {
  return typeof prices?.monthlyUsd === "number" ? `$${prices.monthlyUsd.toLocaleString("en-US")} a month` : null;
}

/**
 * What is said after a plan change: `endedTrial` when the change took the company off the Trial plan, `opened` how many
 * locked applicants the new plan opened, `aiMonthStarted` when the move started a monthly AI credit's first month, the
 * one thing a change of plan does start again.
 */
export function planChangedToast(company: string, plan: string, endedTrial = false, opened = 0, aiMonthStarted = false): { title: string; detail: string } {
  const people = opened ? ` ${opened === 1 ? "1 locked applicant opens" : `${opened} locked applicants open`} now.` : "";
  const limits = `The new limits apply at once. ${aiMonthStarted ? "AI help starts a new month today; other allowances keep their dates." : "This month's usage stays; the reset date does not move."}${people}`;
  return { title: `${company} is on ${plan} now.`, detail: endedTrial ? `The trial has ended; new applications are open again. ${limits}` : limits };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The trial                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------ */

/** Each extension of a trial, oldest first: "Extended by 14 days on Oct 20 by Ada Admin, to Nov 13: the kick-off moved." */
export function extensionLines(term: TrialTerm | null | undefined, timeZone?: string | null): Array<{ key: string; text: string }> {
  return (term?.extensions ?? []).map((e) => ({ key: `${e.at}|${e.to}`, text: `Extended by ${e.days} ${e.days === 1 ? "day" : "days"} on ${trialDate(e.at, timeZone, { short: true })}${e.by.name ? ` by ${e.by.name}` : ""}, to ${trialDate(e.to, timeZone, { short: true })}: ${e.reason}` }));
}

/** The longest one extension may be (the API refuses more, TrialExtensionRequest). */
export const TRIAL_EXTENSION_MAX_DAYS = 90;

/** Where an extension by `days` would take the trial: from the later of its end and now, as the API counts it. */
export function trialExtendedTo(trial: Pick<TrialStanding, "endsAt">, days: number, now: number = Date.now()): string {
  const end = trial.endsAt ? Date.parse(trial.endsAt) : now;
  return new Date(Math.max(Number.isFinite(end) ? end : now, now) + days * DAY).toISOString();
}

/** A number of days the API takes: a whole number from 1 to 90. */
export function extensionDaysOk(days: number): boolean {
  return Number.isInteger(days) && days >= 1 && days <= TRIAL_EXTENSION_MAX_DAYS;
}

/** The question before an extension: "Extend Bright Dental's trial by 14 days, to November 13?" */
export function trialExtensionQuestion(company: string, days: number, to: string, timeZone?: string | null): string {
  return `Extend ${company}'s trial by ${days} ${days === 1 ? "day" : "days"}, to ${trialDate(to, timeZone)}?`;
}

/** What is said once it is extended. */
export function trialExtendedToast(to: string, timeZone?: string | null): string {
  return `Trial extended to ${trialDate(to, timeZone)}.`;
}
