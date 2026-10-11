/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { formatPayRange, type DraftRolePacket, type RolePacket } from "@ros/contracts";
import { payShown as payShownByRule, type Notice } from "@ros/core";
import { jobValidThrough } from "@ros/integrations";
import { EMPLOYMENT_LABEL as EMPLOYMENT, WORK_MODEL_LABEL as WORK_MODEL } from "../services/job-preview";
import { Icon, type CandidateIconName } from "./icons";

/**
 * The plain facts every public job surface states the same way (Wave 0 item 0.8, plan D10): every place, how, what
 * kind of job, the pay, the schedule and the day it was posted, and the one end date search engines and boards are
 * given. The labels are shared with the job builder's preview (services/job-preview.ts), so the preview names things as
 * the page does.
 */

/**
 * Whether a public page shows the pay range: when the owner chose to, and always where a pay transparency law covers the
 * job, because the notice on the same page tells the candidate the range is "shown above". The rule itself is
 * `payShown` in packages/core/src/compliance.ts, shared with the board packages, the screening assistant and the role page.
 */
export function payShown(packet: RolePacket, notices: Notice[]): boolean {
  return payShownByRule(packet.compensation, notices);
}

/** The pay range as a public page writes it, or "" when it is not shown (or, on a draft, not set yet). */
export function publicPay(packet: Pick<DraftRolePacket, "compensation">, notices: Notice[]): string {
  return packet.compensation && payShownByRule(packet.compensation, notices) ? formatPayRange(packet.compensation) : "";
}

const WORK_MODEL_ICON: Record<string, CandidateIconName> = { onsite: "building", hybrid: "hybrid", remote: "home" };

/** Most places a job lists before the rest are counted ("and 3 more places"). */
const MAX_PLACES = 6;

/** "Irvine, CA" for each of the job's places, in the order the role plan lists them, without repeats. */
export function placesOf(identity: Pick<RolePacket["identity"], "locations">): string[] {
  return [...new Set(identity.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).filter(Boolean))];
}

/** "October 1, 2026": the calendar day of a timestamp or a date, as written in the United States. */
export function dayWords(value: string): string {
  return new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
}

/**
 * One fact as a pill: its icon for the eye, its name for a screen reader ("Pay: $45–$55 an hour"), its words for both.
 * A fact whose words already say what it is ("Posted October 1, 2026") has no spoken name.
 */
function Fact(props: { icon: CandidateIconName; name?: string; text: string }) {
  return (
    <li class="fact"><Icon name={props.icon} />{props.name ? <span class="sr-only">{props.name}: </span> : null}<span class="fact-text">{props.text}</span></li>
  );
}

/** Every place, how, what kind of job, the pay, the schedule and the day it was posted, as pills. */
export function JobFacts(props: { packet: Pick<RolePacket, "identity">; pay: string; postedOn?: string | null; small?: boolean; schedule?: boolean }) {
  const { identity } = props.packet;
  const places = placesOf(identity);
  const shown = places.length > MAX_PLACES ? places.slice(0, MAX_PLACES - 1) : places;
  return (
    <ul class={props.small ? "facts small" : "facts"}>
      {shown.map((place) => <Fact icon="pin" name="Location" text={place} />)}
      {places.length > shown.length ? <Fact icon="pin" name="Location" text={`and ${places.length - shown.length} more places`} /> : null}
      <Fact icon={WORK_MODEL_ICON[identity.remotePolicy] ?? "building"} name="Workplace" text={WORK_MODEL[identity.remotePolicy] ?? identity.remotePolicy} />
      <Fact icon="briefcase" name="Job type" text={EMPLOYMENT[identity.employmentType] ?? identity.employmentType.replace(/_/g, " ")} />
      {props.pay ? <Fact icon="pay" name="Pay" text={props.pay} /> : null}
      {identity.schedule && props.schedule !== false ? <Fact icon="clock" name="Schedule" text={identity.schedule} /> : null}
      {props.postedOn ? <Fact icon="calendar" text={`Posted ${dayWords(props.postedOn)}`} /> : null}
    </ul>
  );
}

type RoleDates = { status: string; closedAt: string | null; pausedAt: string | null; acceptingApplications: boolean; applicationsClosedAt: string | null; updatedAt: string; applicationsCloseOn?: string | null };

/**
 * The role's `validThrough`: the closing day once closed; while paused or switched off, the earliest day it stopped
 * taking applications; while open, its closing date when one is set (plan D7), and nothing otherwise.
 */
export function roleValidThrough(role: RoleDates): string | undefined {
  if (role.status === "closed") return jobValidThrough({ closedAt: role.closedAt ?? role.updatedAt });
  const stops = [role.status === "paused" ? role.pausedAt ?? role.updatedAt : null, role.acceptingApplications ? null : role.applicationsClosedAt ?? role.updatedAt].filter((d): d is string => !!d).sort((a, b) => Date.parse(a) - Date.parse(b));
  return jobValidThrough({ stoppedAt: stops[0] ?? null, closesOn: role.applicationsCloseOn ?? null });
}
