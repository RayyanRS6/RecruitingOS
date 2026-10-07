/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { formatPayRange, type RolePacket } from "@ros/contracts";
import { payShown as payShownByRule, type Notice } from "@ros/core";
import { jobValidThrough } from "@ros/integrations";

/**
 * The plain facts every public job surface states the same way (Wave 0 item 0.8): where, how, what kind of job and
 * the pay, and the one end date search engines and boards are given.
 */

const WORK_MODEL: Record<string, string> = { onsite: "On site", hybrid: "Hybrid", remote: "Remote" };
const EMPLOYMENT: Record<string, string> = { full_time: "Full time", part_time: "Part time", contract: "Contract", temporary: "Temporary", per_diem: "Per diem", internship: "Internship" };

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

/** Where, how, what kind of job, the pay and the schedule, as chips. */
export function JobFacts(props: { packet: RolePacket; pay: string }) {
  const { identity } = props.packet;
  const loc = identity.locations[0];
  const place = loc ? [loc.city, loc.region].filter(Boolean).join(", ") : "";
  return (
    <div class="chips">
      {place ? <span class="chip">{place}</span> : null}
      <span class="chip">{WORK_MODEL[identity.remotePolicy] ?? identity.remotePolicy}</span>
      <span class="chip">{EMPLOYMENT[identity.employmentType] ?? identity.employmentType.replace(/_/g, " ")}</span>
      {props.pay ? <span class="chip">{props.pay}</span> : null}
      {identity.schedule ? <span class="chip">{identity.schedule}</span> : null}
    </div>
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
