import type { ClosingDateView, RolePacket } from "@ros/contracts";
import { CLOSING_DATE_REASON, CLOSING_GRACE_HOURS, closingDateRequired, closingDateView, openPayload, sealPayload } from "@ros/core";

/**
 * Whether a job takes a new application by its own rule: it is open, and its applications have not been stopped (a
 * closing date that passed, or a person switching them off). A pause or a passed closing date keeps the job page up and
 * closes the form: the page says so, the apply routes answer 404, and nobody already in the process is touched. The one
 * test of it: the job pages, the application itself and the team's Jobs list all ask here. (A form opened before the
 * closing date may still be sent for a while: `lateApplicationAllowed`, below. A company whose trial has ended takes
 * none either: `jobTakesApplications` in pages/candidate-shared.tsx adds that.)
 */
export function acceptingApplications(role: { status: string; acceptingApplications: boolean }): boolean {
  return role.status === "open" && role.acceptingApplications;
}

/** A job's closing date as every page reads it; "required by law" is worked out from the places of the version given. */
export function closingDateFor(role: Parameters<typeof closingDateView>[0]["role"], company: { timezone: string | null } | null, packet: Pick<RolePacket, "identity"> | null, now: Date): ClosingDateView {
  const requiredByLaw = !!packet && closingDateRequired({ jobLocations: packet.identity.locations, remotePolicy: packet.identity.remotePolicy });
  return closingDateView({ role, timeZone: company?.timezone, requiredByLaw, now });
}

/**
 * People part-way through applying when a role's closing date passes may still finish (founder decision Q12, plan
 * D7). The apply form carries a sealed "form opened at" value (`sealFormOpened`, a hidden field the browser cannot read
 * or change); a submission that arrives after applications stopped is still taken when the form was opened before the
 * closing moment, within `CLOSING_GRACE_HOURS` of it, and only when it was the closing date that stopped them: a role
 * a person switched off or paused takes nothing new.
 */
const PURPOSE = "apply-form-opened";
/** How long a sealed value lives: long enough for any grace, short enough that an old page does not keep working. */
const SEAL_TTL_MS = 3 * 86_400_000;

type FormOpened = { v: 1; roleId: string; openedAt: number; exp: number };

/** The hidden field's value for a form shown now. */
export function sealFormOpened(secret: string, roleId: string, now: Date): string {
  return sealPayload<FormOpened>(PURPOSE, { v: 1, roleId, openedAt: now.getTime(), exp: now.getTime() + SEAL_TTL_MS }, secret);
}

/**
 * Whether the sealed form was opened for this job before `moment`, and `now` is still within CLOSING_GRACE_HOURS of it:
 * the grace a person part-way through applying gets when applications stop under them (a closing date, plan D7; a
 * trial that ended, founder decision L-02 B). False for anything else, including a tampered value.
 */
export function formOpenedBefore(input: { sealed: string | null | undefined; roleId: string; secret: string; moment: Date; now: Date }): boolean {
  const opened = openPayload<FormOpened>(PURPOSE, input.sealed, input.secret, input.now.getTime());
  if (opened?.v !== 1 || opened.roleId !== input.roleId) return false;
  const at = input.moment.getTime();
  if (!Number.isFinite(at)) return false;
  return opened.openedAt < at && input.now.getTime() < at + CLOSING_GRACE_HOURS * 3600_000;
}

/** Whether a submission after the closing date is still taken (see above). False for anything else, including a tampered value. */
export function lateApplicationAllowed(input: { role: { id: string; status: string; acceptingApplications: boolean; applicationsClosedAt: string | null; applicationsClosedReason: string | null }; sealed: string | null | undefined; secret: string; now: Date }): boolean {
  const { role } = input;
  if (role.status !== "open" || role.acceptingApplications || role.applicationsClosedReason !== CLOSING_DATE_REASON || !role.applicationsClosedAt) return false;
  return formOpenedBefore({ sealed: input.sealed, roleId: role.id, secret: input.secret, moment: new Date(role.applicationsClosedAt), now: input.now });
}
