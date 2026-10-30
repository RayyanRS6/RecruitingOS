import { describe, expect, it } from "vitest";
import { mailbox } from "./mailbox";

/** Audit MAIL-V1: a From or Reply-To built from a name is one RFC 5322 mailbox, whatever the company is called. */
describe("mailbox", () => {
  const address = "updates@hire.identifiedtalent.com";

  it("quotes the name, so a comma in it never splits the header", () => {
    expect(mailbox("Acme, Inc.", address)).toBe('"Acme, Inc." <updates@hire.identifiedtalent.com>');
    expect(mailbox("Acme, Inc. hiring team", address)).toBe('"Acme, Inc. hiring team" <updates@hire.identifiedtalent.com>');
    expect(mailbox("Harbor Dental Group hiring team", address)).toBe('"Harbor Dental Group hiring team" <updates@hire.identifiedtalent.com>');
  });

  it("escapes a double quote and a backslash in the name", () => {
    expect(mailbox('The "Smile" Studio', address)).toBe('"The \\"Smile\\" Studio" <updates@hire.identifiedtalent.com>');
    expect(mailbox("Front\\Back Office", address)).toBe('"Front\\\\Back Office" <updates@hire.identifiedtalent.com>');
    // each is escaped once, whichever comes first
    expect(mailbox('A\\"B', address)).toBe('"A\\\\\\"B" <updates@hire.identifiedtalent.com>');
  });

  it("drops line breaks, so a name can never start another header", () => {
    const from = mailbox("Acme\r\nBcc: someone@example.com", address);
    expect(from).toBe('"AcmeBcc: someone@example.com" <updates@hire.identifiedtalent.com>');
    expect(from).not.toMatch(/[\r\n]/);
    expect(mailbox("Acme\nDental\r", address)).toBe('"AcmeDental" <updates@hire.identifiedtalent.com>');
  });

  it("gives the bare address when there is no name", () => {
    expect(mailbox("", address)).toBe(address);
    expect(mailbox("   ", address)).toBe(address);
    expect(mailbox("\r\n", address)).toBe(address);
    expect(mailbox(null, address)).toBe(address);
    expect(mailbox(undefined, address)).toBe(address);
  });
});
