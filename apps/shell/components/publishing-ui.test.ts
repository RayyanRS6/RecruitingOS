import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "@ros/ui";

/**
 * Approving and publishing (plan Wave D) as the shell first draws it, from answers shaped like the API's: the calm
 * confirmation after approval with where the job is going (nothing ticked before it was checked), the approval card
 * with the preview, the boards, the legal check and what starts on its own, the Posting tab when ITS posts, and the
 * empty applicant list that offers to share the job.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/roles/r1",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({ id: "r1" }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));
// The pages as the browser shows them once they are its own: Candidates reads the job's status from the rail's jobs
// list, which the first draw leaves out on both sides (first-draw.test.ts).
vi.mock("@ros/web/src/components/use-is-client", () => ({ useIsClient: () => true }));

(globalThis as { React?: typeof React }).React = React;
const { AfterApproval, StatusPill } = await import("@ros/web/src/pages/AfterApproval");
const { PacketApprovalCard } = await import("@ros/web/src/pages/RolePlan");
const { PostingTab, acceptingMode, postingNeedsTeam } = await import("@ros/web/src/pages/RolePosting");
const { People } = await import("@ros/web/src/pages/People");
const { RecruiterQueue } = await import("@ros/web/src/pages/RecruiterQueue");
const { Setup } = await import("@ros/web/src/pages/Setup");
const { NoResumeAnswers } = await import("@ros/web/src/pages/candidate-panel/sections");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));

const closingDate = { closesOn: "2026-10-30", closesAt: "2026-10-31T07:00:00.000Z", applyBy: "Apply by Friday, October 30, 2026", timeZone: "America/Los_Angeles", requiredByLaw: false, defaultIfMissing: null, passed: false, applicationsClosedByDate: false };
const boards = [
  { channel: "linkedin_basic", name: "LinkedIn", chosen: false, available: true, reason: null, inRolePlan: false },
  { channel: "indeed", name: "Indeed", chosen: true, available: true, reason: null, inRolePlan: true },
  { channel: "ziprecruiter", name: "ZipRecruiter", chosen: false, available: false, reason: "ZipRecruiter needs your company's own paid ZipRecruiter plan. Say you have one in Setup to offer it.", inRolePlan: false },
];
const posting = (over: Record<string, unknown>) => ({
  id: "p", channel: "indeed", status: "ready_to_post", externalUrl: null, intakeToken: null, instructions: null, steps: ["Sign in to Indeed.", "Paste the package."], error: null, publishedAt: null, publicUrlRecordedAt: null, verifiedAt: null, verifiedBy: null,
  verificationNote: null, verificationError: null, verificationAttempts: 0, pausedAt: null, closedAt: null, closureRequired: false, closureConfirmedAt: null, closureConfirmedBy: null, boardVersion: null,
  name: "Indeed", stateLabel: "Ready to post", isBoard: true, link: { id: "l1", url: "https://jobs.test/a/abc", source: "indeed", sourceLabel: "Indeed", sourceDetail: null, label: "Indeed", postingId: "p", visits: 0, lastVisitedAt: null, createdAt: "", disabledAt: null, landing: "apply" },
  package: { text: "Dental hygienist at Bright Dental", fields: {} }, stillUp: false, chosen: true, postedBy: "its", task: { id: "t1", kind: "post_job", status: "open", label: "Post the job on Indeed", recruiterName: null, createdAt: "", resolvedAt: null, notDone: false, note: null }, showsOldVersion: false, ...over,
});
const postings = {
  role: { id: "r1", title: "Dental hygienist", status: "open", acceptingApplications: true, applicationsClosedAt: null, applicationsClosedReason: null, volumeAlertPerDay: 50, applicationsCloseOn: "2026-10-30", openedAt: "2026-10-08T10:00:00.000Z", currentPacketVersion: 1 },
  urls: { careers: "https://jobs.test/c/bright", job: "https://jobs.test/c/bright/jobs/r1", apply: "https://jobs.test/c/bright/jobs/r1/apply" },
  emailIn: { address: "r1@in.test", connected: false, shown: false, status: "failed", error: null },
  postings: [posting({ id: "c", channel: "careers_page", name: "Careers page", isBoard: false, postedBy: null, task: null, link: null, package: null, status: "posted_manually" }), posting({ id: "g", channel: "google_jobs", name: "Google for Jobs", isBoard: false, postedBy: null, task: null, link: null, package: null, status: "submitted_integration" }), posting({})],
  links: [],
  boardsStillUp: [],
  publishing: { state: "ready", pollAfterSeconds: 10, message: "Everything is prepared. Each channel shows where it stands; nothing is called live until its address has been checked.", checksPending: 1 },
  whoPosts: "its",
  boards,
  closingDate,
  share: { jobUrl: "https://jobs.test/c/bright/jobs/r1", text: "Bright Dental is hiring: Dental hygienist in Irvine, CA. Know someone who would be great at it? Here is the job: https://jobs.test/c/bright/jobs/r1", places: ["referral", "school", "community", "email", "text", "whatsapp", "linkedin", "facebook", "x"].map((place) => ({ place, label: place === "referral" ? "Referral from your team" : place === "school" ? "A school or training program" : place === "community" ? "A community group" : `Shared ${place}`, link: place === "whatsapp" ? { id: "w", url: "https://jobs.test/a/wa", visits: 2 } : null })) },
  interviewers: { rounds: 2, roundsWithoutInterviewers: 2 },
};

function client(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], { user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role: "owner" }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "fake" } });
  qc.setQueryData(["company"], { settings: { verifiedAt: "2026-10-01T00:00:00.000Z" } });
  qc.setQueryData(["postings", "r1"], postings);
  qc.setQueryData(["volume", "r1"], { from: "", to: "", timeZone: "America/Los_Angeles", days: [], totals: { total: 0, bySource: {} }, sources: [], threshold: 50, yesterday: { day: "", total: 0 }, today: { day: "", total: 0 }, acceptingApplications: true, applicationsClosedAt: null, applicationsClosedReason: null });
  return qc;
}

describe("the confirmation dialog", () => {
  it("is a named modal dialog with a decorative tick, the title, the line under it, the body and the buttons at the foot", () => {
    // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
    const out = renderToStaticMarkup(createElement(Dialog, { open: true, onClose: () => undefined, title: "Your job is approved", sub: "Getting it ready.", mark: "check", markTone: "good", footer: createElement("button", { type: "button" }, "Go to your role"), children: "body" }));
    expect(out).toContain('role="dialog" aria-modal="true" aria-label="Your job is approved" tabindex="-1"');
    expect(out).toContain('<span class="dialog-mark good" aria-hidden="true">');
    expect(out).toContain("<h2>Your job is approved</h2>");
    expect(out).toContain('<p class="dialog-sub">Getting it ready.</p>');
    expect(out).toMatch(/<div class="dialog-body">body<\/div><div class="dialog-foot"><button type="button">Go to your role<\/button><\/div>/);
    // a Close button a screen reader names, and the backdrop closes it too
    expect(out.match(/aria-label="Close"/g)).toHaveLength(2);
  });

  it("draws nothing while closed, and no foot without buttons", () => {
    // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
    expect(renderToStaticMarkup(createElement(Dialog, { open: false, onClose: () => undefined, title: "x", children: "body" }))).toBe("");
    // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
    expect(renderToStaticMarkup(createElement(Dialog, { open: true, onClose: () => undefined, title: "x", children: "body" }))).not.toContain("dialog-foot");
  });
});

describe("the status chips", () => {
  it("tick only what was checked; a spinner while something is under way; otherwise a dot", () => {
    const done = renderToStaticMarkup(createElement(StatusPill, { s: { label: "Up and checked", tone: "good", done: true, working: false } }));
    expect(done).toContain('class="pill sm good"');
    expect(done).not.toContain("spinner");
    expect(renderToStaticMarkup(createElement(StatusPill, { s: { label: "Checking it is up", tone: "neutral", done: false, working: true } }))).toContain('<span class="spinner" aria-hidden="true"></span>Checking it is up');
    expect(renderToStaticMarkup(createElement(StatusPill, { s: { label: "Waiting for ITS", tone: "neutral", done: false, working: false } }))).toContain('<span class="dot" aria-hidden="true"></span>Waiting for ITS');
  });
});

describe("the screen right after approval (D2)", () => {
  const html = render(client(), createElement(AfterApproval, { open: true, onClose: () => undefined, roleId: "r1", roleTitle: "Dental hygienist", companyName: "Bright Dental", editWhileOpen: false, canManage: true, canShare: true, canEditPacket: true, onOpenTab: () => undefined }));
  const words = text(html);

  it("says the job is approved and lists where it is going, nothing ticked before it was checked", () => {
    expect(html).toContain('aria-label="Your job is approved"');
    expect(words).toContain("Your careers page https://jobs.test/c/bright/jobs/r1 · Apply by Friday, October 30, 2026");
    expect(words).toContain("Checking it is up");
    expect(words).toContain("Sent to Google");
    expect(words).toContain("ITS is posting this on Indeed from your company's own account.");
    expect(words).toContain("Waiting for ITS");
    expect(words).not.toContain("Up and checked");
    // applications by email are left out while they do not work
    expect(words).not.toContain("Applications by email");
  });

  it("notes that nobody is set to interview, and offers 'Share it now' and 'Go to your role'", () => {
    expect(words).toContain("Nobody is set to interview yet.");
    expect(words).toContain("Choose interviewers");
    expect(html).toMatch(/<div class="dialog-foot"><button[^>]*>.*Share it now<\/button><button type="button" class="btn primary"[^>]*>Go to your role<\/button><\/div>/);
  });
});

describe("the approval card (D1, D5, D6, D9)", () => {
  const role = {
    id: "r1", title: "Dental hygienist", status: "pending_approval", openedAt: null, counts: { total: 0 }, needsYou: 0, daysOpen: null, currentPacketVersion: null,
    currentPacket: { version: 1, status: "proposed", packet: { provenance: { assumptions: [] } } }, proposedPacket: null, packetVersions: [], postings: [], boardsStillUp: [], acceptingApplications: true, applicationsClosedAt: null, applicationsClosedReason: null, volumeAlertPerDay: null, pendingApprovals: [],
    packetApproval: {
      pending: {
        id: "ap1", version: 1, rationale: "Dana drafted the role.", requestedBy: { kind: "user", id: "u1", name: "Dana" }, requiredRoles: ["owner"], requiredUserIds: [], decisionMaker: null, createdAt: "2026-10-08T10:00:00.000Z", expiresAt: null, editWhileOpen: false, flags: [],
        legalCheck: {
          jurisdictions: ["US-CO"], remote: false,
          items: [
            { key: "pay_range", label: "Pay range on the job ad", met: true, blocking: true, jurisdictions: ["US-CO"], pendingCounsel: [], detail: "The pay range is on the job ad.", fix: null },
            { key: "benefits", label: "A short description of the benefits", met: false, blocking: true, jurisdictions: ["US-CO"], pendingCounsel: [], detail: "The law in Colorado asks for a short description of the benefits on the job ad.", fix: "Describe the benefits in Setup (used for every job), or in this role's pay section." },
          ],
          missing: [],
        },
        viewer: { mayDecide: false, maySendBack: true, reason: "Before this job can go live, the law where it is asks for: a short description of the benefits. Describe the benefits in Setup." },
      },
      latest: null,
    },
    decisionMaker: null,
    autoActionsOnOpen: { lines: [{ actionType: "message.send_templated", level: "auto", text: "Every applicant gets an email confirming their application, sent on its own in the approved wording." }, { actionType: "application.invite_screen", level: "approval", text: "Invitations to the screening conversation wait for your approval." }], changeHref: "/setup#setup-rules" },
    boards, whoPosts: "its", closingDate: { ...closingDate, closesOn: null, applyBy: null, requiredByLaw: true, defaultIfMissing: "2026-11-07" }, boardsShowingOldVersion: [],
  };
  const html = render(client(), createElement(PacketApprovalCard, { role: role as never, onEdit: () => undefined, canEdit: true, canManage: true, canSeePay: true, showingProposed: false, onShowProposed: () => undefined, onApproved: () => undefined }));
  const words = text(html);

  it("opens the job page preview of the version waiting in a new tab", () => {
    expect(html).toContain('href="/api/v1/roles/r1/preview?version=1" target="_blank" rel="noopener noreferrer"');
    expect(words).toContain("Preview the job page (opens in a new tab)");
  });

  it("says where the job goes and who posts it, what the law still asks for, and what starts on its own", () => {
    expect(words).toContain("Once approved it goes to your careers page, Google and Indeed. ITS posts it on the job boards from your company's own accounts.");
    expect(words).toContain("Before this job can go live");
    expect(words).toContain("A short description of the benefits.");
    expect(html).toContain('href="/setup#setup-company"');
    expect(words).toContain("Pay range on the job ad: The pay range is on the job ad.");
    expect(words).toContain("Once it is live: Every applicant gets an email confirming their application, sent on its own in the approved wording. Invitations to the screening conversation wait for your approval.");
    expect(html).toContain('href="/setup#setup-rules"');
    // the legal sentence is not said twice, and Approve is not offered while it waits
    expect(words).not.toContain("the law where it is asks for: a short description");
    expect(words).not.toContain("Approve and publish");
    // what is already in order is folded away
    expect(html).toContain("<summary");
    expect(words).toContain("What the law asks of this job ad is in order (1)");
  });

  it("marks the must-haves and nice-to-haves as on the job page (D10)", () => {
    const withLists = { ...role, currentPacket: { ...role.currentPacket, packet: { provenance: { assumptions: [] }, requirements: { mustHaves: [{ key: "m1", text: "Active RDH license", rationale: "Required by the state", evidencedBy: ["resume"] }], niceToHaves: [{ key: "n1", text: "Dentrix", rationale: "We use it", evidencedBy: ["resume"] }], eligibility: [] } } } };
    const out = text(render(client(), createElement(PacketApprovalCard, { role: withLists as never, onEdit: () => undefined, canEdit: true, canManage: true, canSeePay: true, showingProposed: false, onShowProposed: () => undefined, onApproved: () => undefined })));
    expect(out).toContain("Candidates see this The job page lists what you are looking for: Active RDH license. Nice to have: Dentrix.");
    expect(out).not.toContain("Required by the state");
  });
});

describe("the Share tab (once Posting) when ITS posts (D3, D6, D7, D8)", () => {
  const html = render(client(), createElement(PostingTab, { roleId: "r1", roleStatus: "open", canManage: true, canShare: true, roleTitle: "Dental hygienist", companyName: "Bright Dental" }));
  const words = text(html);

  it("leads with the job's public link, with Copy and Open, before anything about the boards (Wave S1)", () => {
    const link = html.indexOf('<div class="share-link">');
    expect(link).toBeGreaterThan(-1);
    expect(link).toBeLessThan(html.indexOf("Where it is posted"));
    expect(html.slice(link)).toMatch(/^<div class="share-link">.*<code title="https:\/\/jobs\.test\/c\/bright\/jobs\/r1">https:\/\/jobs\.test\/c\/bright\/jobs\/r1<\/code>.*Copy<\/button><a class="btn secondary sm" href="https:\/\/jobs\.test\/c\/bright\/jobs\/r1" target="_blank" rel="noopener noreferrer">.*Open<span class="sr-only"> the job page \(opens in a new tab\)<\/span><\/a><\/div>/);
    // the message, the ready-made places, each board's card, the tracked links and the counts by source are one click away
    expect(words).toContain("The message that goes with it");
    expect(words).toContain("Links for a referral, a school or a group");
    expect(words).toContain("Each board and page, step by step (3)");
    expect(words).toContain("Your own tracked links (0)");
    expect(words).toContain("Applications by source, last 14 days");
    // nothing waits on the team here (ITS posts), so the boards' cards start folded
    expect(html).toContain('<details class="more"><summary>Each board and page, step by step (3)</summary>');
  });

  it("opens the boards' cards when one holds a step for the team, and offers the link to someone who cannot share", () => {
    const qc = client();
    const self = posting({ postedBy: "self", task: null });
    qc.setQueryData(["postings", "r1"], { ...postings, whoPosts: "self", postings: [postings.postings[0], postings.postings[1], self] });
    const open = render(qc, createElement(PostingTab, { roleId: "r1", roleStatus: "open", canManage: true, canShare: true, roleTitle: "Dental hygienist", companyName: "Bright Dental" }));
    expect(open).toContain('<details class="more" open=""><summary>Each board and page, step by step (3)</summary>');
    const readOnly = render(client(), createElement(PostingTab, { roleId: "r1", roleStatus: "open", canManage: false, canShare: false, roleTitle: "Dental hygienist", companyName: "Bright Dental" }));
    expect(text(readOnly)).toContain("Your job link");
    expect(readOnly).toContain('<code title="https://jobs.test/c/bright/jobs/r1">');
  });

  it("says ITS is posting, with the task, and keeps the address field folded away", () => {
    expect(words).toContain("Posted by ITS from your company's own account");
    expect(words).toContain("ITS is posting this on Indeed from your company's own account");
    expect(words).toContain("Post the job on Indeed: waiting for ITS");
    expect(words).toContain("Posted it yourself? Record the address");
    expect(words).not.toContain("Post the package from your own Indeed account");
  });

  it("has the share block, the board ticks and the closing date, each where Today's cards link to", () => {
    // focusable from code only: following Today's link scrolls there and puts the keyboard there too
    expect(html).toContain('<section id="share" class="setup-section" tabindex="-1">');
    expect(html).toContain('<section id="closing-date" class="setup-section" tabindex="-1">');
    expect(html).toContain('<fieldset class="share-buttons" aria-label="Share the job">');
    // a place that has its link is a plain link to the network's own share page, in a new tab
    expect(html).toContain('href="https://wa.me/?text=');
    expect(html).toMatch(/href="https:\/\/wa\.me\/\?text=[^"]+" target="_blank" rel="noopener noreferrer"/);
    expect(words).toContain("in your role plan");
    expect(words).toContain("ZipRecruiter needs your company's own paid ZipRecruiter plan");
    expect(words).toContain("Apply by Friday, October 30, 2026. New applications stop at the end of that day");
  });

  it("a task ITS closed as not possible is never called done: its words, and 'Ask ITS again'", () => {
    const qc = client();
    const couldNot = posting({ task: { id: "t1", kind: "post_job", status: "resolved", label: "Post the job on Indeed", recruiterName: "Pat Poster", createdAt: "", resolvedAt: "2026-10-08T12:00:00.000Z", notDone: true, note: "Your Indeed account has no job slots left." } });
    qc.setQueryData(["postings", "r1"], { ...postings, postings: [postings.postings[0], postings.postings[1], couldNot] });
    const out = text(render(qc, createElement(PostingTab, { roleId: "r1", roleStatus: "open", canManage: true, canShare: false, roleTitle: "Dental hygienist", companyName: "Bright Dental" })));
    expect(out).toContain("Post the job on Indeed: ITS could not do it");
    expect(out).not.toContain("Post the job on Indeed: done");
    expect(out).toContain("Nothing is on Indeed yet: ITS could not post it.");
    expect(out).toContain("Pat Poster wrote: \"Your Indeed account has no job slots left.\"");
    expect(out).toContain("Ask ITS again");
  });
});

describe("the LinkedIn post on the Share tab (Wave S2, K3)", () => {
  const roleDetail = {
    id: "r1", title: "Dental hygienist", status: "open",
    currentPacket: {
      version: 1, status: "approved", payShown: true,
      packet: {
        identity: { title: "Dental hygienist", locations: [{ city: "Irvine", region: "CA" }], employmentType: "full_time", remotePolicy: "onsite" },
        compensation: { basis: "hourly", min: 45, max: 55, ceiling: 58, discloseRange: true, sources: [], ownerStated: true },
        requirements: { mustHaves: [{ key: "m1", text: "Active CA RDH license", rationale: "Required by the state", evidencedBy: ["resume"] }, { key: "m2", text: "2+ years in a dental office", rationale: "Pace", evidencedBy: ["resume"] }], niceToHaves: [], eligibility: [] },
      },
    },
  };
  const withRole = () => {
    const qc = client();
    qc.setQueryData(["role", "r1"], roleDetail);
    return qc;
  };
  const tab = (qc: QueryClient, over: Record<string, unknown> = {}) => render(qc, createElement(PostingTab, { roleId: "r1", roleStatus: "open", canManage: true, canShare: true, roleTitle: "Dental hygienist", companyName: "Bright Dental", ...over }));
  const box = (html: string) => text(/<textarea[^>]*id="linkedin-text"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? "");

  it("comes right after the public link, at #linkedin, with the three tones, the job's own words, a preview and the count", () => {
    const html = tab(withRole());
    const words = text(html);
    const at = html.indexOf('<section id="linkedin" class="setup-section" tabindex="-1">');
    expect(at).toBeGreaterThan(html.indexOf('<div class="share-link">'));
    expect(at).toBeLessThan(html.indexOf("Where it is posted"));
    expect(words).toContain("Post on LinkedIn");
    expect(html).toMatch(/<legend class="small">Tone<\/legend>/);
    // Proud is picked to start with
    expect(html).toContain('<label class="wording-option" data-checked="true"><input type="radio" name="linkedin-tone-r1" checked="" value="proud"/>');
    expect(html).toContain('<input type="radio" name="linkedin-tone-r1" value="straight"/>');
    expect(words).toContain("Proud Upbeat: big news, we're hiring");
    expect(words).toContain("Straight Just the facts");
    expect(words).toContain("Friendly Warm: asks people to share it");
    // the words come from the job itself: company, title, place, kind of job, pay, must-haves and the job's address
    const post = box(html);
    expect(post).toContain("Big news: Bright Dental is hiring.");
    expect(post).toContain("Job: Dental hygienist Where: Irvine, CA · On site Type: Full time Pay: $45–$55 an hour");
    expect(post).toContain("• Active CA RDH license • 2+ years in a dental office");
    expect(post).toContain("Apply here: https://jobs.test/c/bright/jobs/r1");
    expect(html).toMatch(/<label for="linkedin-text">Your post<\/label><textarea id="linkedin-text" class="textarea" rows="14" aria-describedby="linkedin-count linkedin-hint">/);
    expect(words).toMatch(/\d+ of 3,000 characters/);
    // the preview shows the same words, for the eye only (the box holds them for everyone)
    expect(html).toMatch(/<div class="stack" style="[^"]*" aria-hidden="true"><span class="small muted">Preview<\/span>/);
    expect(words).toContain("Copy and open LinkedIn");
    expect(words).toContain("Copy text");
    expect(words).toContain("Nothing is posted for you. LinkedIn opens in a new tab: paste, then post.");
    // plain words and plain links only: nothing from LinkedIn loads on the page
    expect(html).not.toMatch(/<script|<iframe/);
  });

  it("uses the job's own LinkedIn link once it has one, so applicants from the post show LinkedIn as their source", () => {
    const qc = withRole();
    qc.setQueryData(["postings", "r1"], { ...postings, share: { ...postings.share, places: postings.share.places.map((p) => (p.place === "linkedin" ? { ...p, link: { id: "li", url: "https://jobs.test/a/li", visits: 0 } } : p)) } });
    const post = box(tab(qc));
    expect(post).toContain("Apply here: https://jobs.test/a/li");
    expect(post).not.toContain("https://jobs.test/c/bright/jobs/r1");
  });

  it("is there for someone who cannot share (with the job page's address), and says when the job takes no applications", () => {
    expect(box(tab(withRole(), { canManage: false, canShare: false }))).toContain("https://jobs.test/c/bright/jobs/r1");
    const qc = withRole();
    qc.setQueryData(["postings", "r1"], { ...postings, role: { ...postings.role, acceptingApplications: false } });
    expect(text(tab(qc))).toContain("This job is not taking applications right now. Hold the post until it is.");
  });

  it("is not offered before ITS confirms the company (the card says why, where Post on LinkedIn lands), nor for a job that is not live", () => {
    const waitLine = "You can post on LinkedIn once ITS has checked your company.";
    const waiting = withRole();
    waiting.setQueryData(["company"], { settings: {} });
    expect(tab(waiting)).not.toContain('id="linkedin-text"');
    expect(tab(waiting)).toContain('<section id="linkedin" class="setup-section" tabindex="-1">');
    expect(text(tab(waiting))).toContain(waitLine);
    const held = withRole();
    held.setQueryData(["postings", "r1"], { ...postings, publishing: { ...postings.publishing, state: "waiting_for_company_check" } });
    expect(tab(held)).not.toContain('id="linkedin-text"');
    expect(text(tab(held))).toContain(waitLine);
    for (const roleStatus of ["paused", "closed", "draft"]) expect(tab(withRole(), { roleStatus })).not.toContain('id="linkedin"');
  });
});

describe("what keeps a board's card open, and which way the accepting switch goes (Wave S1)", () => {
  it("opens the boards' cards only for a step the team has to take", () => {
    const p = (over: Record<string, unknown>) => posting(over) as never;
    // ITS posts: nothing for the team, unless ITS could not do it
    expect(postingNeedsTeam(p({}), true)).toBe(false);
    expect(postingNeedsTeam(p({ task: { id: "t1", kind: "post_job", status: "resolved", label: "Post", recruiterName: null, createdAt: "", resolvedAt: "", notDone: true, note: null } }), true)).toBe(true);
    // the team posts: an address to record, a failed check, a listing to take down, an earlier version still up
    expect(postingNeedsTeam(p({ postedBy: "self", task: null }), true)).toBe(true);
    expect(postingNeedsTeam(p({ postedBy: "self", task: null, status: "failed" }), true)).toBe(true);
    expect(postingNeedsTeam(p({ postedBy: "self", task: null, status: "closed", closureRequired: true }), false)).toBe(true);
    expect(postingNeedsTeam(p({ postedBy: "self", task: null, status: "closed", closureRequired: true, closureConfirmedAt: "2026-10-09" }), false)).toBe(false);
    expect(postingNeedsTeam(p({ postedBy: "self", task: null, status: "live_verified", showsOldVersion: true }), true)).toBe(true);
    expect(postingNeedsTeam(p({ postedBy: "self", task: null, status: "live_verified" }), true)).toBe(false);
  });

  it("stops applications, takes them again, or (after the closing date) offers a later date; nothing once the job is not live", () => {
    expect(acceptingMode({ status: "open", acceptingApplications: true, closingDate: null } as never)).toBe("stop");
    expect(acceptingMode({ status: "paused", acceptingApplications: false, closingDate: null } as never)).toBe("reopen");
    expect(acceptingMode({ status: "open", acceptingApplications: false, closingDate: { ...closingDate, applicationsClosedByDate: true } } as never)).toBe("extend");
    expect(acceptingMode({ status: "closed", acceptingApplications: false, closingDate: null } as never)).toBeNull();
  });
});

describe("an ITS posting task in the recruiter queue (D3)", () => {
  const preview = { id: "r1", status: "claimed", kind: "post_job", urgency: "normal", requiredExpertise: "job board posting; dental hiring", summary: "Post the job on Indeed from the customer's own account.", companyName: "Bright Dental", roleTitle: "Dental hygienist", slaDueAt: null, slaRemainingMinutes: null, businessMinutesRemaining: null, overdue: false, createdAt: "2026-10-08T10:00:00.000Z", claimedByMe: true, claimed: true };
  const task = {
    question: "Post it.", kind: "post_job", label: "Post the job on Indeed", companyName: "Bright Dental", role: { id: "role1", title: "Dental hygienist", status: "open", currentPacketVersion: 1 }, board: { channel: "indeed", name: "Indeed" },
    posting: { id: "p", status: "ready_to_post", stateLabel: "Ready to post", externalUrl: null, verifiedAt: null, verificationError: null, error: null, closureRequired: false, closureConfirmedAt: null, boardVersion: null, showsOldVersion: false },
    package: { text: "Dental hygienist at Bright Dental. Apply: https://jobs.test/a/abc", fields: {} }, steps: ["Sign in to Indeed with the company's account.", "Paste the package."], applyUrl: "https://jobs.test/a/abc", boardAccessConfirmed: true,
    whatToDo: "Sign in to Indeed with Bright Dental's own account and post the job with the package below, using Indeed's own apply link.",
  };

  it("opens the job ad, the board's link and the steps, with the address field, and nothing about candidates", () => {
    const qc = client();
    qc.setQueryData(["escalations"], [preview]);
    qc.setQueryData(["escalation", "r1"], { ...preview, accessGranted: false, why: null, postingTask: task });
    const html = render(qc, createElement(RecruiterQueue));
    const words = text(html);
    expect(words).toContain("Post a job · Bright Dental");
    expect(words).toContain("Sign in to Indeed with Bright Dental's own account");
    expect(words).toContain("Indeed's own apply link: https://jobs.test/a/abc");
    expect(words).toContain("The posting package (the job ad to paste)");
    expect(words).toContain("The listing's public address");
    expect(words).toContain("Record the address");
    expect(words).toContain("Close the task with this note");
    expect(words).not.toMatch(/Candidate:|Resume text/);
  });

  it("says before accepting that a posting task opens nothing about candidates", () => {
    const qc = client();
    qc.setQueryData(["escalations"], [{ ...preview, status: "open", claimedByMe: false, claimed: false }]);
    qc.setQueryData(["escalation", "r1"], { ...preview, status: "open", claimedByMe: false, claimed: false, accessGranted: false, why: "claim it to open the full context" });
    const words = text(render(qc, createElement(RecruiterQueue)));
    expect(words).toContain("Accept this task");
    expect(words).toContain("A posting task never opens the customer's candidates");
  });
});

describe("Setup: how candidates see the company, and the job boards (Q13, D3, Q11)", () => {
  const company = (settings: Record<string, unknown>) => ({ id: "co1", name: "Bright Dental", slug: "bright-dental", vertical: "dental", sizeBand: "20-49", timezone: "America/Los_Angeles", planKey: "pilot", status: "active", locations: [{ city: "Irvine", region: "CA" }], settings: { verifiedAt: "2026-10-01T00:00:00.000Z", ...settings }, integrations: [{ kind: "jobboard", provider: "indeed", status: "not_connected" }], ai: { provider: "fake" } });
  const page = (settings: Record<string, unknown>) => {
    const qc = client();
    qc.setQueryData(["company"], company(settings));
    qc.setQueryData(["me"], { user: { id: "u1" }, activeCompanyId: "co1", memberships: [{ companyId: "co1", role: "owner", companyName: "Bright Dental" }] });
    const own = settings.hiringContact as { email: string; name: string | null } | undefined;
    qc.setQueryData(["public-profile"], { hiringContact: own ?? null, contactShown: own ? { ...own, kind: "company" } : { email: "help@its.test", name: null, kind: "its" } });
    return render(qc, createElement(Setup));
  };

  it("offers the assistant's draft or your own words, and a picture for the logo, before anything shows", () => {
    const html = page({});
    const words = text(html);
    expect(html).toContain('<div id="setup-profile" class="setup-section" tabindex="-1">');
    expect(words).toContain("How candidates see you");
    expect(words).toContain("No logo yet: job pages show your company's name.");
    expect(html).toMatch(/<input id="co-logo-file" class="input" type="file" accept="image\/png,image\/jpeg,image\/webp"/);
    expect(words).toContain("Nothing yet. Job pages show the job without an \"about the company\" part until someone approves one.");
    expect(words).toContain("Draft it with the assistant");
    expect(words).toContain("Write it yourself");
    // the boards: ITS posts by default, ZipRecruiter only with the company's own plan; the services table says ITS posts
    expect(html).toMatch(/<button type="button" class="on" aria-pressed="true">ITS posts them for us<\/button>/);
    expect(words).toContain("We have our own paid ZipRecruiter plan");
    expect(words).toContain("ITS posts your jobs here from your company's own account");
    // who candidates write to before they apply: the ITS inbox until the company sets its own (plan D10)
    expect(words).toContain("Who candidates can write to before they apply");
    expect(words).toContain("Candidates see: help@its.test. This is the ITS inbox that answers for your company");
    expect(words).toContain("Set your own contact");
  });

  it("shows the company's own contact once it is set, with the way back to the ITS inbox", () => {
    const words = text(page({ hiringContact: { email: "jobs@bright.test", name: "Dana" } }));
    expect(words).toContain("Candidates see: Dana, jobs@bright.test. Your own address, set here.");
    expect(words).toContain("Change the contact");
    expect(words).toContain("Use the ITS inbox");
  });

  it("shows the approved words with who approved them, and the stored logo", () => {
    const html = page({ logoUrl: "/files/logo/co1.png", about: { text: "We are a family dental practice in Irvine.", approvedAt: "2026-10-05T10:00:00.000Z", approvedBy: { id: "u1", name: "Dana Whitfield" } }, boardPosting: "self", zipRecruiterPlan: true });
    const words = text(html);
    expect(html).toContain('<img src="/files/logo/co1.png" alt="Bright Dental logo"/>');
    expect(words).toContain("We are a family dental practice in Irvine.");
    expect(words).toMatch(/Approved by Dana Whitfield on .+\. Shown on your careers page and every job page\./);
    expect(words).toContain("Change it");
    expect(html).toMatch(/<button type="button" class="on" aria-pressed="true">Our team posts them<\/button>/);
    expect(words).toContain("Not connected to Indeed. Post from your own Indeed account");
  });
});

describe("Setup: When a candidate cancels (founder decisions 1A to 4A; 3A)", () => {
  const company = (settings: Record<string, unknown> = {}) => ({ id: "co1", name: "Bright Dental", slug: "bright-dental", vertical: "dental", sizeBand: "20-49", timezone: "America/Los_Angeles", planKey: "pilot", status: "active", locations: [{ city: "Irvine", region: "CA" }], settings: { verifiedAt: "2026-10-01T00:00:00.000Z", ...settings }, integrations: [], ai: { provider: "fake" } });
  const page = (opts: { role?: string; settings?: Record<string, unknown>; view?: Record<string, unknown> } = {}) => {
    const qc = client();
    qc.setQueryData(["company"], company(opts.settings));
    qc.setQueryData(["me"], { user: { id: "u1" }, activeCompanyId: "co1", memberships: [{ companyId: "co1", role: opts.role ?? "owner", companyName: "Bright Dental" }] });
    qc.setQueryData(["public-profile"], { hiringContact: null, contactShown: { email: "help@its.test", name: null, kind: "its" } });
    if (opts.view) qc.setQueryData(["new-times-setting"], opts.view);
    return render(qc, createElement(Setup));
  };

  it("sits after the job boards, on by default after 3 working days, with the number and its hint", () => {
    const html = page();
    const words = text(html);
    expect(html.indexOf('id="setup-boards"')).toBeLessThan(html.indexOf('id="setup-new-times"'));
    // its own section, which the old #setup-new-times links still reach (Settings' tabs are slice D's; kept loose)
    expect(html).toContain('id="setup-new-times"');
    expect(words).toContain("When a candidate cancels");
    expect(words).toContain("When candidates cancel a booked interview, they choose: send me new times later, or I'm no longer interested.");
    expect(html).toMatch(/<input type="checkbox" checked=""\/>Send new times automatically to people who ask for them/);
    expect(html).toMatch(/<input id="new-times-days" class="input" type="number" min="1" max="10" step="1" style="width:100px" value="3"\/>/);
    expect(words).toContain("Working days to wait");
    expect(words).toContain("1 to 10. Weekends and holidays are not counted. The email goes out in the morning, your company's time.");
    expect(words).toContain("Each person gets one set of new times by email, 3 working days after they cancel, for the same interview.");
    // a confirmed company: nothing about the ITS check
    expect(words).not.toContain("Automatic new times start once ITS confirms your company.");
  });

  it("switched off: nobody gets times automatically, and there is no number to set", () => {
    const html = page({ view: { auto: false, workingDays: 5, pending: 0, companyConfirmed: true } });
    expect(html).toMatch(/<input type="checkbox"\/>Send new times automatically to people who ask for them/);
    expect(html).not.toContain('id="new-times-days"');
    expect(text(html)).toContain("Nobody gets new times automatically. People who ask for them wait under Cancelled until you send times or decide.");
  });

  it("before ITS confirms the company, says automatic times start then", () => {
    expect(text(page({ view: { auto: true, workingDays: 3, pending: 0, companyConfirmed: false } }))).toContain("Automatic new times start once ITS confirms your company. Until then, emails to candidates wait.");
  });

  it("reads as one line for someone who may not change it", () => {
    const html = page({ role: "hr", settings: { newTimesAfterCancel: { auto: true, workingDays: 5 } } });
    expect(text(html)).toContain("Automatic new times: on, after 5 working days. Only owners and admins change this.");
    expect(html).not.toContain('id="new-times-days"');
    expect(text(page({ role: "hiring_manager", view: { auto: false, workingDays: 3, pending: 0, companyConfirmed: true } }))).toContain("Automatic new times: off. Only owners and admins change this.");
  });
});

describe("the guided answers of someone without a résumé (D10)", () => {
  it("shows each answer on its own labelled line, and an older one-box answer as it was written", () => {
    const guided = text(renderToStaticMarkup(createElement(NoResumeAnswers, { answers: { recentWork: "Hygienist at Coastal Dental, 2019 to now", skills: "Active CA RDH license", summary: "Most recent work: Hygienist at Coastal Dental, 2019 to now\nSkills, licenses or tools: Active CA RDH license" } })));
    expect(guided).toContain("Most recent work Hygienist at Coastal Dental, 2019 to now Skills, licenses or tools Active CA RDH license");
    expect(guided).not.toContain("Day to day");
    expect(text(renderToStaticMarkup(createElement(NoResumeAnswers, { answers: { summary: "Six years as a dental assistant." } })))).toContain("Six years as a dental assistant.");
  });
});

describe("the empty applicant list of a live job (D8)", () => {
  it("offers to share the job instead of an empty box", () => {
    const qc = client();
    qc.setQueryData(["roles"], [{ id: "r1", title: "Dental hygienist", status: "open", openedAt: "2026-10-08T10:00:00.000Z", counts: { total: 0 }, needsYou: 0, daysOpen: 0 }]);
    qc.setQueryData(["applications", "r1"], { applications: [], counts: { total: 0, byOwnerStage: { new: 0, longlist: 0, shortlist: 0, interviewing: 0, cancelled: 0, on_hold: 0, offer: 0, hired: 0, not_moving_forward: 0 }, byGroup: { waiting_on_you: 0, in_process: 0, not_moving_forward: 0, hired: 0 }, notTold: 0, holdsEnded: 0 } });
    const html = render(qc, createElement(People));
    expect(text(html)).toContain("Nobody has applied yet");
    expect(html).toContain('<fieldset class="share-buttons" aria-label="Share the job">');
    // and the way to the Share tab's LinkedIn post (Wave S2)
    expect(html).toContain('<a href="/roles/r1?tab=share#linkedin">Post on LinkedIn</a>');
  });
});
