import { MEMBERSHIP_ROLE_LABEL, type CompanyView, type LeftCompany, type Location, type MemberChanged, type MembershipRole, type PlanView, type TeamInvitation, type TeamView, type UpdateCompany } from "@ros/contracts";
import { shortDay } from "./dates";
import { placeWords } from "./jobs";
import { trialPlanLine } from "./trial";

/**
 * Settings, one page with four sections (Company, Team, Plan, Email updates): the parts that need no browser, kept out
 * of the page so tests/web/settings.test.ts can check them. What a person may do with the team comes with the team
 * from the API (`TeamView.viewer`, each member's `mayChange`); nothing here works a rule out.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Company                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

export const SIZE_BANDS = ["1-19", "20-49", "50-99", "100-199", "200-499", "500+"] as const;

/** The company's details as the edit form holds them. `locations`: one place a line, as "City, ST". */
export type CompanyForm = { name: string; website: string; timezone: string; sizeBand: string; locations: string; benefits: string };

export function companyFormFrom(c: Pick<CompanyView, "name" | "website" | "timezone" | "sizeBand" | "locations" | "benefitsSummary">): CompanyForm {
  return { name: c.name, website: c.website ?? "", timezone: c.timezone, sizeBand: c.sizeBand, locations: c.locations.map(placeWords).join("\n"), benefits: c.benefitsSummary ?? "" };
}

/** The places typed in the form. A line left as it was keeps the stored place whole; a changed or new line is a city and a state. */
export function parseLocations(text: string, before: readonly Location[]): Location[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line): Location => {
    const kept = before.find((b) => placeWords(b) === line);
    if (kept) return kept;
    const [city, region] = line.split(",").map((part) => part.trim());
    return { city: city ?? "", ...(region ? { region: region.toUpperCase().slice(0, 2) } : {}), country: "US" };
  }).filter((l) => l.city || l.label);
}

/** The first thing wrong with the form, in plain words, or null. */
export function companyFormProblem(f: CompanyForm): string | null {
  if (f.name.trim().length < 2) return "Give the company a name.";
  if (!f.locations.trim()) return "Keep at least one location, as City, ST.";
  return null;
}

/** What a save sends: only the details that changed. Nothing changed gives an empty edit, which is not sent. */
export function companyEdit(c: Pick<CompanyView, "name" | "website" | "timezone" | "sizeBand" | "locations" | "benefitsSummary">, f: CompanyForm): UpdateCompany {
  const before = companyFormFrom(c);
  const edit: UpdateCompany = {};
  if (f.name.trim() !== before.name) edit.name = f.name.trim();
  if (f.website.trim() !== before.website) edit.website = f.website.trim();
  if (f.timezone !== before.timezone) edit.timezone = f.timezone;
  if (f.sizeBand !== before.sizeBand) edit.sizeBand = f.sizeBand as UpdateCompany["sizeBand"];
  if (f.locations.trim() !== before.locations) edit.locations = parseLocations(f.locations, c.locations);
  if (f.benefits.trim() !== before.benefits) edit.benefitsSummary = f.benefits.trim();
  return edit;
}

/** Who candidates can write to, as their pages show it; the ITS inbox answers until the company sets its own. */
export function contactLine(c: Pick<CompanyView, "contactShown">): string {
  const who = c.contactShown.name ? `${c.contactShown.name}, ${c.contactShown.email}` : c.contactShown.email;
  return c.contactShown.kind === "its" ? `${who} (the ITS inbox, until you set your own)` : who;
}

export const LOGO_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** Why a chosen logo file cannot be used, or null. Pictures only, small enough for a job page. */
export function logoProblem(file: { type: string; size: number }): string | null {
  if (!LOGO_TYPES.includes(file.type)) return "Use a PNG, JPG or WebP picture.";
  if (file.size > LOGO_MAX_BYTES) return "That picture is larger than 2 MB. Use a smaller one.";
  if (file.size === 0) return "That file is empty.";
  return null;
}

export const ABOUT_MIN = 40;
export const ABOUT_MAX = 1200;

/** Why the text about the company cannot be approved as it is, or null. */
export function aboutProblem(text: string): string | null {
  const t = text.trim();
  if (t.length < ABOUT_MIN) return `Write a few sentences about the company (at least ${ABOUT_MIN} characters).`;
  if (t.length > ABOUT_MAX) return `Keep it under ${ABOUT_MAX} characters.`;
  return null;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Team                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** The roles the person looking may give, in the words on screen (Owner, Admin, Member). */
export function roleOptions(viewer: Pick<TeamView["viewer"], "grantableRoles">): Array<{ value: MembershipRole; label: string }> {
  return viewer.grantableRoles.map((value) => ({ value, label: MEMBERSHIP_ROLE_LABEL[value] }));
}

/** The role a new invitation starts on: Member when it may be given, else the first role that may. */
export function defaultInviteRole(viewer: Pick<TeamView["viewer"], "grantableRoles">): MembershipRole | null {
  return viewer.grantableRoles.includes("hiring_manager") ? "hiring_manager" : viewer.grantableRoles[0] ?? null;
}

const EMAIL_STATE: Record<NonNullable<TeamInvitation["emailState"]>, string> = { on_its_way: "Email on its way", sent: "Email sent", failed: "Email did not arrive" };

/** One open invitation's line: its role, until when its link works, and what became of its email. */
export function invitationFacts(inv: Pick<TeamInvitation, "roleLabel" | "expiresAt" | "emailState">, now: Date = new Date()): string[] {
  return [inv.roleLabel, `Link works until ${shortDay(inv.expiresAt, now)}`, ...(inv.emailState ? [EMAIL_STATE[inv.emailState]] : [])];
}

/** What is said after an invitation is made or sent again: whether its email is on its way, or the link is theirs to send. */
export function inviteToast(answer: { emailed: boolean; invitation: Pick<TeamInvitation, "email"> }): { title: string; detail: string } {
  return answer.emailed
    ? { title: "Invited.", detail: `The email to ${answer.invitation.email} is on its way.` }
    : { title: "Invited.", detail: "No email went out. Copy the link and send it yourself." };
}

const AS_A: Record<MembershipRole, string> = { owner: "an owner", admin: "an admin", hiring_manager: "a member" };

/** The question asked before someone's role changes: "Make Sam Lee an admin?" */
export function roleChangeQuestion(name: string, role: MembershipRole): string {
  return `Make ${name} ${AS_A[role]}?`;
}

/** What is said once someone's role was changed, or they were removed. */
export function memberChangedWords(change: Pick<MemberChanged, "role" | "status">, name: string): string {
  return change.status === "removed" ? `${name} is no longer on the team.` : `${name} is now ${AS_A[change.role]}.`;
}

/** Where someone goes after leaving the company: the other company they work in, or the sign-in page when there is none. */
export function afterLeaving(left: Pick<LeftCompany, "movedTo" | "signedOut">): string {
  return left.signedOut || !left.movedTo ? "/login" : "/";
}

/**
 * Making someone an owner or an admin asks for a recent sign-in; the person confirms it is them and comes back to
 * Settings with the outcome in the address (?reauth=). What the page says then, or null for any other address.
 */
export function reauthLine(outcome: string | null | undefined): { tone: "info" | "critical"; text: string } | null {
  if (outcome === "ok") return { tone: "info", text: "Thanks, that is confirmed. For the next few minutes you can make someone an admin or an owner." };
  if (outcome === "mismatch") return { tone: "critical", text: "That sign-in was a different account. Confirm with the account you are signed in as." };
  if (outcome === "failed") return { tone: "critical", text: "The confirmation did not complete. Try again." };
  return null;
}

/** What the team section says when a change was refused for an older sign-in. */
export const CONFIRM_FIRST_LINE = "Making someone an admin or an owner needs a recent sign-in. Confirm it's you, then try again.";

/* ------------------------------------------------------------------------------------------------------------ */
/* Plan                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The Plan section's lines: the plan's name, where a trial stands, and one usage line (each limit in the server's
 * words). The day an open upgrade request was sent stands in place of the Upgrade button (components/Upgrade.tsx).
 */
export function planLines(plan: Pick<PlanView, "name" | "usage" | "trial">, timeZone?: string | null): { name: string; trial: string | null; usage: string } {
  return { name: plan.name, trial: trialPlanLine(plan.trial, timeZone), usage: plan.usage.map((u) => u.words).join(" · ") };
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Email updates                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------ */

/** What is said once the one switch was changed. */
export function emailSwitchWords(on: boolean): { title: string; detail: string } {
  return on
    ? { title: "Emails on.", detail: "Updates are emailed to you as they happen." }
    : { title: "Emails off.", detail: "You still see every update in the app." };
}
