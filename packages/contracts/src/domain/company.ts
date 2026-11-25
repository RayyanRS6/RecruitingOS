import { z } from "zod";

/**
 * The people on a company's team. `hiring_manager` is shown on screen as "Member": it may build, publish and edit jobs
 * and do everything with candidates; an owner or an admin also manages the company, the team and the plan, and pauses or
 * closes a job. Only an owner makes another owner.
 */
export const MembershipRole = z.enum(["owner", "admin", "hiring_manager"]);
export type MembershipRole = z.infer<typeof MembershipRole>;
export const MEMBERSHIP_ROLE_LABEL: Record<MembershipRole, string> = { owner: "Owner", admin: "Admin", hiring_manager: "Member" };

/**
 * An owner or an admin: beside everything a member does, they manage the company, its team and its plan, pause, resume
 * or close a job, set a closing date and may take over a draft. The one test of it: the permissions (packages/core),
 * a job's actions (`roleActions`), the routes and the pages all ask here, so "owner or admin" is written once.
 */
export function isOwnerOrAdmin(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** A platform administrator runs the admin dashboard; everyone else is `none`. */
export const PlatformRole = z.enum(["none", "platform_admin"]);
export type PlatformRole = z.infer<typeof PlatformRole>;

/**
 * First sign-in asks for approval (SIGNUP_MODE=approval). A request is a company whose owner's membership is `requested`,
 * and `declined` once an administrator declined it or took its access away. Both are memberships that are not `active`,
 * so someone waiting has no company to work in, and that is the wall. Accepting makes the company live: its people can
 * work, its careers page and job pages are public and its emails to candidates go. There is no second check.
 */
export const ACCESS_REQUEST_STATUSES = ["requested", "declined"] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

/** Whether a membership's status means a request for access, waiting or declined, rather than someone on a team. */
export function isAccessRequestStatus(status: string | null | undefined): status is AccessRequestStatus {
  return status === "requested" || status === "declined";
}

/**
 * POST /api/v1/admin/customers/:id/access: an administrator accepts or declines a request. No reason is typed. `from`: where
 * the request stood on the row that was pressed, so the first press wins: a press from a row that no longer says what is
 * true changes nothing, and is told who decided and when. Only a declined company's Accept, the undo, sends `declined`.
 * `remove` takes an accepted company's access away; from then on it is a declined company, and Accept is the undo. An
 * accepted company has no request to stand anywhere, so `remove` needs no `from`; Accept and Decline must send one.
 */
export const CustomerAccessChange = z.object({
  decision: z.enum(["accept", "decline", "remove"]),
  from: z.enum(ACCESS_REQUEST_STATUSES).optional(),
  confirm: z.literal(true, { message: "Confirm the decision." }),
}).strict().refine((change) => change.decision === "remove" || change.from !== undefined, { message: "Say where the request stood on the row.", path: ["from"] });
export type CustomerAccessChange = z.infer<typeof CustomerAccessChange>;

/**
 * What that route answers. `status`: where the company stands now, `active` once it is in. `changed`: false when this
 * press changed nothing (another administrator got there first, or a second press), and `message` says so in plain words.
 * After `remove`: `people`, how many lost access, and `emailed`, whether the email to the owner really left (a screen may
 * say it went only then).
 */
export type CustomerAccessAnswer = { ok: true; companyId: string; decision: CustomerAccessChange["decision"]; status: "active" | "declined"; changed: boolean; message: string; people?: number; emailed?: boolean };

/**
 * `accessRequest` on a row of GET /api/v1/admin/customers, null for an active company: the status, the person who asked,
 * and for a declined one when and by whom. `removed`: declined because an administrator took an accepted company's access
 * away.
 */
export type CustomerAccessRequest = { status: AccessRequestStatus; person: { name: string | null; email: string }; declined: { at: string; by: string | null } | null; removed?: boolean };

/**
 * A person's own request, as `signup.request` on GET /api/v1/auth/config and `accessRequest` on POST /api/v1/companies say
 * it. `emailedAt`: when the copy really left; null means no claim about email may be made on the screen.
 */
export type SignupRequest = { status: AccessRequestStatus; companyName: string; email: string; emailedAt: string | null };

/**
 * The `signup` part of GET /api/v1/auth/config. `mode`: SIGNUP_MODE, `approval` in production and `open` for local work
 * and tests (a company is live when created). `allowed`: whether this person may send the company form now. `contact`: the
 * inbox to ask. `door`, only under `approval`: `direct` for a platform administrator, `request` for anyone else signed in
 * (the form sends a request), `none` signed out. `request`, in any mode: this person's own request, waiting or declined;
 * with one, `allowed` is false.
 */
export type SignupConfig = { mode: "open" | "approval"; allowed: boolean; contact: string; door?: "direct" | "request" | "none"; request?: SignupRequest };

/**
 * What a person typed, for one line of an email (a subject, or one "Label: value" of a body) or a request's details: it
 * can never start a line of its own. Line breaks and other control characters become one space, runs of spaces close up,
 * and a very long value stops at `max` characters. The characters that turn the text after them around, or take no room
 * at all, go: a name of two of them would be no name, and one could reverse the rest of a console row. So does half of a
 * character (a lone surrogate, from a hand-made body or from the cut at `max` going through an emoji): kept in a jsonb
 * value, Postgres would refuse it and the request would fail.
 */
export function oneLine(value: string | null | undefined, max = 200): string {
  const line = (value ?? "").replace(UNSEEN, "").replace(/\p{Cs}/gu, "").replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return line.length > max ? line.slice(0, max).replace(/\p{Cs}$/u, "").trimEnd() : line;
}

/**
 * The bidi controls (U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F) and the zero-width spaces (U+200B, U+2060). Not
 * every format character: U+200C and U+200D belong inside some names and emoji.
 */
const UNSEEN = /[​‎‏‪-‮⁠⁦-⁩]/gu;

/** Blank letters and symbols: they count as letters to Unicode and show nothing. */
const BLANK = new Set(["ᅟ", "ᅠ", "ㅤ", "ﾠ", "⠀"]);

/** How many characters of a typed value a reader can see: letters, digits, punctuation and symbols, by code point. */
export function visibleLength(value: string): number {
  return (value.match(/[\p{L}\p{N}\p{P}\p{S}]/gu) ?? []).filter((ch) => !BLANK.has(ch)).length;
}

/**
 * A name a person typed, for a console row or one line of an email: `oneLine`, with no angle brackets, so
 * "Pat Example <pat@its.example>" cannot pass for an address beside the real one, and null unless at least two
 * characters of it can be seen.
 */
export function typedName(value: string | null | undefined, max = 120): string | null {
  const name = oneLine((value ?? "").replace(/[<>]/g, " "), max);
  return visibleLength(name) >= 2 ? name : null;
}
