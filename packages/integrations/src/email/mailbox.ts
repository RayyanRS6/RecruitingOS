/**
 * One mailbox for a From or Reply-To header (RFC 5322, section 3.4): `"name" <address>`. The display name is always
 * quoted, so a comma, a full stop or a colon in a company's name ("Acme, Inc.") cannot turn the header into a list of
 * addresses or have the provider refuse it (audit MAIL-V1). A backslash or a double quote in the name is escaped, and
 * line breaks are dropped, so a name can never start a header of its own. With no name, the bare address. For a person's
 * words in a subject or a line of a body, the same rule is `oneLine` in @ros/contracts.
 */
export function mailbox(name: string | null | undefined, address: string): string {
  const display = (name ?? "").replace(/[\r\n]/g, "").trim();
  return display ? `"${display.replace(/[\\"]/g, "\\$&")}" <${address}>` : address;
}
