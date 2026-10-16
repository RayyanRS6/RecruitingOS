import { CLOSING_DATE_REASON, CLOSING_GRACE_HOURS, openPayload, sealPayload } from "@ros/core";

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
