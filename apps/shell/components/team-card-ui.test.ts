import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * The Team card under Settings → Team, by rank (audit 01-platform B3, B11, B12; known bugs 8, 43, 44, 56): owners and
 * admins get "Sign out everywhere" for each teammate they may sign out (an admin never for an owner, nobody for
 * themselves, HR never); pending invitations show only to those who manage the team; and "Send again" and "Withdraw"
 * show only on invitations the viewer may give.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/setup",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { TeamCard } = await import("@ros/web/src/pages/TeamCard");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const member = (userId: string, role: string, name: string) => ({ userId, role, status: "active", email: `${userId}@bright.test`, name, calendar: null, availability: null, schedulable: false });
const members = [member("u-owner", "owner", "Dana Owner"), member("u-owner2", "owner", "Olive Owner"), member("u-admin", "admin", "Abe Admin"), member("u-hr", "hr", "Hope HR"), member("u-int", "interviewer", "Ivy Interviewer")];
const invitation = (id: string, role: string, email: string) => ({ id, email, role, name: null, expiresAt: "2026-10-21T00:00:00.000Z", invitedBy: { name: "Dana Owner" }, createdAt: "2026-10-14T00:00:00.000Z" });
const invitations = [invitation("i-admin", "admin", "ann@bright.test"), invitation("i-hm", "hiring_manager", "hal@bright.test")];

function card(myRole: string, myUserId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["members"], members);
  // the list is in the cache whatever the role, so the card itself must decide who sees it
  qc.setQueryData(["invitations"], invitations);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(TeamCard, { myRole, myUserId })));
}
const signOutFor = (html: string) => [...html.matchAll(/aria-label="Sign out everywhere: ([^"]+)"/g)].map((m) => m[1]);

describe("Team card: signing a teammate out", () => {
  it("an owner may sign out every teammate but themselves, another owner included", () => {
    const html = card("owner", "u-owner");
    expect(signOutFor(html)).toEqual(["Olive Owner", "Abe Admin", "Hope HR", "Ivy Interviewer"]);
    expect(text(html)).toContain("Sign out everywhere");
  });

  it("an admin may sign out anyone but an owner and themselves", () => {
    expect(signOutFor(card("admin", "u-admin"))).toEqual(["Hope HR", "Ivy Interviewer"]);
  });

  it("HR and an interviewer get no sign-out button", () => {
    expect(signOutFor(card("hr", "u-hr"))).toEqual([]);
    expect(signOutFor(card("interviewer", "u-int"))).toEqual([]);
  });

  it("says who can sign a teammate out", () => {
    expect(text(card("owner", "u-owner"))).toContain("Owners and admins can sign a teammate out of this company; only an owner signs out an owner.");
  });
});

describe("Team card: fewer words (founder, 23 October 2026)", () => {
  it("names the person on each round Remove button, the only words it has", () => {
    const html = card("owner", "u-owner");
    expect([...html.matchAll(/aria-label="Remove ([^"]+)" title="Remove [^"]+"/g)].map((m) => m[1])).toEqual(["Olive Owner", "Abe Admin", "Hope HR", "Ivy Interviewer"]);
    // an admin never removes an owner, and nobody removes themselves
    expect([...card("admin", "u-admin").matchAll(/aria-label="Remove ([^"]+)"/g)].map((m) => m[1])).toEqual(["Hope HR", "Ivy Interviewer"]);
  });

  it("says what each role may do once, under Who can do what, not again under the invite form", () => {
    const words = text(card("owner", "u-owner"));
    expect(words.match(/Runs hires: approves jobs/g)).toHaveLength(1);
    expect(words).toContain("Hiring manager: Runs hires: approves jobs, decides on candidates.");
  });
});

describe("Team card: leaving the company (founder decision L-10)", () => {
  it("everyone gets 'Leave this company' on their own row only, whatever their role", () => {
    for (const [role, id] of [["owner", "u-owner"], ["admin", "u-admin"], ["hr", "u-hr"], ["interviewer", "u-int"]]) {
      const html = card(role, id);
      expect(html.match(/>Leave this company</g), role).toHaveLength(1);
      // on the row that says "(you)"
      const own = html.slice(html.indexOf("(you)"), html.indexOf("(you)") + 2000);
      expect(own, role).toContain(">Leave this company<");
    }
  });

  it("says who can leave", () => {
    expect(text(card("owner", "u-owner"))).toContain("Anyone can leave the company from their own row, an owner only while another owner remains.");
  });
});

describe("Team card: pending invitations", () => {
  it("an interviewer or a hiring manager never sees them", () => {
    for (const role of ["interviewer", "hiring_manager"]) {
      const words = text(card(role, "u-int"));
      expect(words, role).not.toContain("Invited, not yet in");
      expect(words, role).not.toContain("ann@bright.test");
    }
  });

  it("an owner sees them with Send again and Withdraw on each", () => {
    const html = card("owner", "u-owner");
    expect(text(html)).toContain("Invited, not yet in");
    expect(html.match(/>Withdraw</g)).toHaveLength(2);
    expect(html.match(/>Send again</g)).toHaveLength(2);
  });

  it("HR sees the list but may send again or withdraw only the invitations it may give, never an admin's", () => {
    const html = card("hr", "u-hr");
    const words = text(html);
    expect(words).toContain("ann@bright.test");
    expect(words).toContain("hal@bright.test");
    expect(html.match(/>Withdraw</g)).toHaveLength(1);
    expect(html.match(/>Send again</g)).toHaveLength(1);
    // the one row with buttons is the hiring manager's
    const annRow = html.slice(html.indexOf("ann@bright.test"), html.indexOf("hal@bright.test"));
    expect(annRow).not.toContain("Withdraw");
  });
});

describe("Team card: the Trial plan's people (founder decision L-02 B)", () => {
  const INVITE_OPEN = /<button type="submit" class="btn primary"(?! disabled)[^>]*>Invite<\/button>/;
  const INVITE_WAITS = /<button type="submit" class="btn primary" disabled=""[^>]*>Invite<\/button>/;
  const withSeats = (seats: { used: number; limit: number | null }) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
    qc.setQueryData(["members"], members.slice(0, 2));
    qc.setQueryData(["invitations"], []);
    return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(TeamCard, { myRole: "owner", myUserId: "u-owner", seats })));
  };

  it("says above the invite form how many people are in use, invitations not yet answered included", () => {
    const html = withSeats({ used: 2, limit: 3 });
    const words = text(html);
    expect(words).toContain("Your trial includes 3 people: 2 in use, counting invitations not yet answered.");
    expect(words.indexOf("Your trial includes 3 people")).toBeLessThan(words.indexOf("Invite by email"));
    expect(html).toMatch(INVITE_OPEN);
    expect(words).not.toContain("Choose a plan to add more.");
  });

  it("when every place is in use, Invite waits and says why in the API's words", () => {
    const html = withSeats({ used: 3, limit: 3 });
    expect(text(html)).toContain("Your trial includes 3 people. Choose a plan to add more.");
    expect(html).toMatch(INVITE_WAITS);
  });

  it("on a plan with no limit of people there is no line and nothing waits", () => {
    const html = withSeats({ used: 7, limit: null });
    expect(text(html)).not.toContain("Your trial includes");
    expect(html).toMatch(INVITE_OPEN);
  });
});
