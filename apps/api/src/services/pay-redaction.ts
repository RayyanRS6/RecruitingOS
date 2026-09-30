import type { RolePacket } from "@ros/contracts";

/**
 * What a person without compensation.read (an interviewer) may know of a packet's pay: how it is paid, in what currency
 * and whether the range is shown to candidates. Nothing else: not the range, not the ceiling, not the bonus or the
 * benefits, and not the sources, whose details carry the figures ("45–55 hourly", the benchmark percentiles). One
 * helper for every route that returns a packet, so a new field in the pay section is hidden by default.
 */
export type RedactedCompensation = Pick<RolePacket["compensation"], "basis" | "currency" | "discloseRange">;

export function redactedCompensation(comp: RolePacket["compensation"]): RedactedCompensation {
  return { basis: comp.basis, currency: comp.currency, discloseRange: comp.discloseRange };
}

/** The packet with its pay section cut down to `redactedCompensation`. */
export function withoutPay<T extends { packet: RolePacket }>(row: T): Omit<T, "packet"> & { packet: Omit<RolePacket, "compensation"> & { compensation: RedactedCompensation } } {
  return { ...row, packet: { ...row.packet, compensation: redactedCompensation(row.packet.compensation) } };
}

/**
 * The role page's shape for the same viewer: the pages read the range, the ceiling and the sources as numbers and a
 * list, so they are present but empty (zero and none), never the real figures.
 */
export function withEmptyPay<T extends { packet: RolePacket }>(row: T): T {
  return { ...row, packet: { ...row.packet, compensation: { ...redactedCompensation(row.packet.compensation), min: 0, max: 0, ceiling: 0, sources: [], ownerStated: false } as RolePacket["compensation"] } };
}
