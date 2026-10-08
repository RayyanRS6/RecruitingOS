/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { formatPayRange, type RolePacket } from "@ros/contracts";
import { payShown as payShownByRule, type Notice } from "@ros/core";
import { jobValidThrough } from "@ros/integrations";
import { EMPLOYMENT_LABEL as EMPLOYMENT, WORK_MODEL_LABEL as WORK_MODEL } from "../services/job-preview";
import { Icon, type CandidateIconName } from "./icons";

/**
 * The plain facts every public job surface states the same way (Wave 0 item 0.8): where, how, what kind of job and
 * the pay, and the one end date search engines and boards are given. The labels are shared with the job builder's
 * preview (services/job-preview.ts), so the preview names things as the page does.
 */

/**
 * Whether a public page shows the pay range: when the owner chose to, and always where a pay transparency law covers the
 * job, because the notice on the same page tells the candidate the range is "shown above". The rule itself is
 * `payShown` in packages/core/src/compliance.ts, shared with the board packages, the screening assistant and the role page.
 */
export function payShown(packet: RolePacket, notices: Notice[]): boolean {
  return payShownByRule(packet.compensation, notices);
}

/** The pay range as a public page writes it, or "" when it is not shown. */
export function publicPay(packet: RolePacket, notices: Notice[]): string {
  return payShown(packet, notices) ? formatPayRange(packet.compensation) : "";
}

const WORK_MODEL_ICON: Record<string, CandidateIconName> = { onsite: "building", hybrid: "hybrid", remote: "home" };

/** One fact as a pill: its icon for the eye, its name for a screen reader ("Pay: $45–$55 an hour"), its words for both. */
function Fact(props: { icon: CandidateIconName; name: string; text: string }) {
  return (
    <li class="fact"><Icon name={props.icon} /><span class="sr-only">{props.name}: </span><span class="fact-text">{props.text}</span></li>
  );
}

/** Where, how, what kind of job, the pay and the schedule, as pills. */
export function JobFacts(props: { packet: RolePacket; pay: string }) {
  const { identity } = props.packet;
  const loc = identity.locations[0];
  const place = loc ? [loc.city, loc.region].filter(Boolean).join(", ") : "";
  return (
    <ul class="facts">
      {place ? <Fact icon="pin" name="Location" text={place} /> : null}
      <Fact icon={WORK_MODEL_ICON[identity.remotePolicy] ?? "building"} name="Workplace" text={WORK_MODEL[identity.remotePolicy] ?? identity.remotePolicy} />
      <Fact icon="briefcase" name="Job type" text={EMPLOYMENT[identity.employmentType] ?? identity.employmentType.replace(/_/g, " ")} />
      {props.pay ? <Fact icon="pay" name="Pay" text={props.pay} /> : null}
      {identity.schedule ? <Fact icon="clock" name="Schedule" text={identity.schedule} /> : null}
    </ul>
  );
}

type RoleDates = { status: string; closedAt: string | null; pausedAt: string | null; acceptingApplications: boolean; applicationsClosedAt: string | null; updatedAt: string };

/**
 * The role's `validThrough`: the closing day once closed; while paused or switched off, the earliest day it stopped
 * taking applications; nothing while it is open and taking applications (no closing date exists yet to give).
 */
export function roleValidThrough(role: RoleDates): string | undefined {
  if (role.status === "closed") return jobValidThrough({ closedAt: role.closedAt ?? role.updatedAt });
  const stops = [role.status === "paused" ? role.pausedAt ?? role.updatedAt : null, role.acceptingApplications ? null : role.applicationsClosedAt ?? role.updatedAt].filter((d): d is string => !!d).sort((a, b) => Date.parse(a) - Date.parse(b));
  return jobValidThrough({ stoppedAt: stops[0] ?? null });
}
