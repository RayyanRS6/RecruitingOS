/** The one way a pay range is written for people: "$45–$55 an hour" or "$90,000–$110,000 a year". */
export function formatPayRange(c: { basis: string; min: number; max: number; discloseRange?: boolean }, opts: { onlyIfDisclosed?: boolean } = {}): string {
  if (opts.onlyIfDisclosed && !c.discloseRange) return "";
  const amount = (n: number) => `$${n.toLocaleString("en-US")}`;
  return c.basis === "hourly" ? `${amount(c.min)}–${amount(c.max)} an hour` : `${amount(c.min)}–${amount(c.max)} a year`;
}
