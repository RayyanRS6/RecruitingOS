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
// The address the pages read: the recruiter queue's tests change it (a request open or not, `?show=`, `?q=`).
const address = vi.hoisted(() => ({ id: "r1" as string | undefined, search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/roles/r1",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => (address.id ? { id: address.id } : {}),
  useSearchParams: () => new URLSearchParams(address.search),
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
const { RecruiterQueue, queueCounts, queueSearch, queueShown, queueViewFrom } = await import("@ros/web/src/pages/RecruiterQueue");
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
    const html = render(client(), createElement(PacketApprovalCard, { role: withLists as never, onEdit: () => undefined, canEdit: true, canManage: true, canSeePay: true, showingProposed: false, onShowProposed: () => undefined, onApproved: () => undefined }));
    const out = text(html);
    expect(out).toContain("Candidates see this The job page lists what you are looking for: Active RDH license. Nice to have: Dentrix.");
    expect(out).not.toContain("Required by the state");
    // that the reasons stay with the team is a lock whose words are its accessible name and tooltip (fewer words, 23 Oct 2026)
    expect(html).toContain('<span class="icon-label align-text-bottom" title="Why each one matters stays with your team.">');
    expect(out).toContain("Nice to have: Dentrix. Why each one matters stays with your team.");
  });
});

describe("the Share tab (once Posting) when ITS posts (D3, D6, D7, D8)", () => {
  const html = render(client(), createElement(PostingTab, { roleId: "r1", roleStatus: "open", canManage: true, canShare: true, roleTitle: "Dental hygienist", companyName: "Bright Dental" }));
  const words = text(html);

  it("leads with the job's public link, with Copy and Open, before anything about the boards (Wave S1)", () => {
    const link = html.indexOf('<div class="share-link ');
    expect(link).toBeGreaterThan(-1);
    expect(link).toBeLessThan(html.indexOf("Where it is posted"));
    expect(html.slice(link)).toMatch(/^<div class="share-link [^"]*">.*<code title="https:\/\/jobs\.test\/c\/bright\/jobs\/r1">https:\/\/jobs\.test\/c\/bright\/jobs\/r1<\/code>.*Copy<\/button><a class="btn secondary sm" href="https:\/\/jobs\.test\/c\/bright\/jobs\/r1" target="_blank" rel="noopener noreferrer">.*Open<span class="sr-only"> the job page \(opens in a new tab\)<\/span><\/a><\/div>/);
    // the message, the ready-made places, each board's card, the tracked links and the counts by source are one click away
    expect(words).toContain("The message that goes with it");
    expect(words).toContain("Links for a referral, a school or a group");
    expect(words).toContain("Each board and page, step by step (3)");
    expect(words).toContain("Your own tracked links (0)");
    expect(words).toContain("Applications by source, last 14 days");
    // nothing waits on the team here (ITS posts), so the boards' cards start folded
    expect(html).toContain('<details class="more"><summary>Each board and page, step by step (3)</summary>');
    // fewer words (23 October 2026): no helper lines around the share buttons and the message
    expect(words).not.toContain("Each place gets its own link");
    expect(words).not.toContain("You see it in your own app before anything is sent");
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
    // who posts a board is an icon beside its state, the words its accessible name and tooltip
    expect(words).toContain("Posted by ITS from your company's own account");
    expect(html).toContain('<span class="icon-label" title="Posted by ITS from your company&#x27;s own account">');
    expect(words).toContain("ITS is posting this on Indeed from your company's own account");
    expect(words).toContain("Post the job on Indeed: waiting for ITS");
    expect(words).toContain("Posted it yourself? Record the address");
    expect(words).not.toContain("Post the package from your own Indeed account");
  });

  it("has the share block, the board ticks and the closing date, each where Today's cards link to", () => {
    // focusable from code only: following Today's link scrolls there and puts the keyboard there too
    expect(html).toContain('<section id="share" class="setup-section" tabindex="-1">');
    expect(html).toContain('<section id="closing-date" class="setup-section" tabindex="-1">');
    expect(html).toMatch(/<fieldset class="share-buttons[^"]*" aria-label="Share the job">/);
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
    expect(at).toBeGreaterThan(html.indexOf('<div class="share-link '));
    expect(at).toBeLessThan(html.indexOf("Where it is posted"));
    expect(words).toContain("Post on LinkedIn");
    expect(html).toMatch(/<legend class="small[^"]*">Tone<\/legend>/);
    // Proud is picked to start with
    expect(html).toMatch(/<label class="wording-option[^"]*" data-checked="true"><input type="radio" name="linkedin-tone-r1" checked="" value="proud"\/>/);
    expect(html).toContain('<input type="radio" name="linkedin-tone-r1" value="straight"/>');
    // each tone by its name only (fewer words, 23 October 2026): what it sounds like is the name's title, and the box shows it
    expect(words).toContain("Tone Proud Straight Friendly");
    expect(words).not.toContain("Pick a tone, check the words");
    expect(words).not.toContain("Upbeat: big news");
    expect(words).not.toContain("Just the facts");
    expect(html).toContain('title="Just the facts">Straight</span>');
    // the words come from the job itself: company, title, place, kind of job, pay, must-haves and the job's address
    const post = box(html);
    expect(post).toContain("Big news: Bright Dental is hiring.");
    expect(post).toContain("Job: Dental hygienist Where: Irvine, CA · On site Type: Full time Pay: $45–$55 an hour");
    expect(post).toContain("• Active CA RDH license • 2+ years in a dental office");
    expect(post).toContain("Apply here: https://jobs.test/c/bright/jobs/r1");
    expect(html).toMatch(/<label for="linkedin-text">Your post<\/label><textarea id="linkedin-text" class="textarea" rows="14" aria-describedby="linkedin-count linkedin-hint">/);
    expect(words).toMatch(/\d+ of 3,000 characters/);
    // the preview shows the same words, for the eye only (the box holds them for everyone)
    expect(html).toMatch(/<div class="stack[^"]*" aria-hidden="true"><span class="small muted">Preview<\/span>/);
    expect(words).toContain("Copy and open LinkedIn");
    expect(words).toContain("Copy text");
    // what the main button does is its title now, not a line under it (the toast after the copy says the next step)
    expect(words).not.toContain("Nothing is posted for you.");
    expect(html).toMatch(/<button type="button" class="btn primary" title="Nothing is posted for you\. LinkedIn opens in a new tab: paste, then post\.">/);
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
    // fewer words (23 October): the ad's version goes with its package, the company and job stay in the request's title
    // only, the address field has no hint, and who reads the note is the eye beside "Cannot do it?"
    expect(words).toContain("The posting package (the job ad to paste) · version 1");
    expect(words).not.toContain("Bright Dental · Dental hygienist · version 1");
    expect(words).not.toContain("It is checked before anything is called live");
    expect(html).toContain('<span class="icon-label" title="The customer&#x27;s owners and admins read this in full, on the job&#x27;s Share tab and in their updates.">');
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

describe("the recruiter queue's pills, search and request (Wave S6, 2.3)", () => {
  const row = (over: Record<string, unknown>) => ({ id: "x", status: "open", kind: "ask", urgency: "normal", requiredExpertise: "dental hiring", summary: "A question about a role.", companyName: "Bright Dental", roleTitle: null, slaDueAt: "2026-10-16T17:00:00.000Z", slaRemainingMinutes: 600, businessMinutesRemaining: 300, overdue: false, createdAt: "2026-10-15T10:00:00.000Z", claimedByMe: false, claimed: false, ...over });
  const rows = [
    row({ id: "a", urgency: "critical", companyName: "Avon Dental" }),
    row({ id: "b", status: "claimed", claimed: true, claimedByMe: true, companyName: "Bright Dental" }),
    row({ id: "c", status: "in_progress", claimed: true, companyName: "Cara Dental", overdue: true, businessMinutesRemaining: -90, urgency: "low" }),
  ];
  const at = (id: string | undefined, search: string, run: () => void) => {
    const before = { ...address };
    address.id = id;
    address.search = search;
    try {
      run();
    } finally {
      address.id = before.id;
      address.search = before.search;
    }
  };
  const queue = (extra?: (qc: QueryClient) => void) => {
    const qc = client();
    qc.setQueryData(["escalations"], rows);
    extra?.(qc);
    return render(qc, createElement(RecruiterQueue));
  };

  it("counts each pill from the list and keeps the view in the address", () => {
    const view = queueViewFrom(new URLSearchParams("show=overdue&q=cara"));
    expect(view).toEqual({ show: "overdue", q: "cara" });
    expect(queueSearch(view)).toBe("?show=overdue&q=cara");
    expect(queueSearch({ show: "all", q: "" })).toBe("");
    expect(queueViewFrom(new URLSearchParams("show=nonsense")).show).toBe("all");
    expect(queueCounts(rows as never, null, "")).toEqual({ all: 3, waiting: 1, yours: 1, overdue: 1, done: null });
    expect(queueCounts(rows as never, [row({ id: "d", status: "resolved" })] as never, "bright")).toEqual({ all: 1, waiting: 0, yours: 1, overdue: 0, done: 1 });
    expect(queueShown(rows as never, null, { show: "waiting", q: "" }).map((e) => e.id)).toEqual(["a"]);
  });

  it("shows the pills with counts, a search by company, and plain words for urgency and status", () => {
    at(undefined, "", () => {
      const html = queue();
      const words = text(html);
      expect(html).toContain('<fieldset aria-label="Show requests"');
      expect(html).toMatch(/<button type="button" class="toggle-chip" aria-pressed="true">All <span class="count">3<\/span><\/button>/);
      expect(words).toContain("Waiting for someone 1");
      expect(words).toContain("Yours 1");
      expect(words).toContain("Overdue 1");
      // Done is read only when someone asks for it, so it has no count yet
      expect(html).toMatch(/aria-pressed="false">Done<\/button>/);
      expect(html).toContain('aria-label="Search requests by company"');
      expect(words).toContain("Urgent");
      expect(words).toContain("Another recruiter has it");
      expect(words).toContain("overdue by 1h 30m of business time");
      expect(words).not.toMatch(/\bcritical\b|\bin_progress\b/);
      // the longer explanation is one click away, word for word
      expect(words).toContain("How the queue works Urgency changes the order, never the reply-by time.");
    });
  });

  it("opens on the pill in the address, keeps it on the link into a request, and offers the way back when it is empty", () => {
    at(undefined, "show=overdue", () => {
      const html = queue();
      expect(html).toContain('href="/recruiter/queue/c?show=overdue"');
      expect(html).not.toContain('href="/recruiter/queue/a');
      expect(html).toMatch(/aria-pressed="true">Overdue <span class="count">1<\/span>/);
    });
    at(undefined, "show=overdue", () => {
      const words = text(render((() => { const qc = client(); qc.setQueryData(["escalations"], [rows[0]]); return qc; })(), createElement(RecruiterQueue)));
      expect(words).toContain("Nothing overdue");
      expect(words).toContain("Show all requests");
    });
    at(undefined, "q=zeta", () => {
      const words = text(queue());
      expect(words).toContain("No requests from a company by that name");
      expect(words).toContain("Clear search");
    });
    at(undefined, "", () => {
      const qc = client();
      qc.setQueryData(["escalations"], []);
      const words = text(render(qc, createElement(RecruiterQueue)));
      expect(words).toContain("Queue is empty");
      expect(words).not.toContain("Show all requests");
    });
  });

  it("puts the actions at the top, folds what the request is about, and groups the answer", () => {
    const accepted = { ...rows[1], id: "b", accessGranted: true, why: null, companyId: "co1", roleId: "r1", applicationId: null, question: "Should we interview Maria?", contextSnapshot: { company: { name: "Bright Dental", vertical: "dental", sizeBand: "20-49" } }, thread: [], grant: { id: "g1", purpose: "escalation", expiresAt: "2026-10-16T10:00:00.000Z", scope: { roleId: "r1", applicationId: null } } };
    at("b", "", () => {
      const html = queue((qc) => qc.setQueryData(["escalation", "b"], accepted));
      const words = text(html);
      // one strip: Open in the customer's workspace and Release, before the summary
      expect(html.indexOf("Open in the customer&#x27;s workspace")).toBeGreaterThan(-1);
      expect(html.indexOf("Open in the customer&#x27;s workspace")).toBeLessThan(html.indexOf("<p>A question about a role.</p>"));
      expect(words).toContain("Release");
      expect(words).toContain("Your access covers this role and ends");
      expect(html).toContain('<details class="more"><summary>What the request is about (1)</summary>');
      expect(words).toContain("Your answer Write to the customer");
      expect(words).toContain("Resolve What you did or advised (the customer reads this in full)");
      // who reads a message is the eye beside "Write to the customer" (its words its name and tooltip), not a hint line;
      // the minutes field has no hint (23 October)
      expect(html).toContain('<span class="icon-label" title="The person who asked and the owners read it in full on Today.">');
      expect(words).not.toContain("Recorded to size recruiter capacity");
      // ITS recruiters cannot open the console, so the link is not there
      expect(words).not.toContain("See this customer in the console");
    });
    at("b", "", () => {
      const html = queue((qc) => {
        qc.setQueryData(["escalation", "b"], accepted);
        qc.setQueryData(["me"], { user: { id: "u9", email: "ada@its.test", name: "Ada", platformRole: "platform_admin" }, memberships: [], activeCompanyId: null });
      });
      expect(html).toContain('href="/admin/customers?open=co1"');
      expect(text(html)).toContain("See this customer in the console");
    });
  });
});

describe("a request in the recruiter queue: who raised it, and who it is about once accepted (I11, 15 October 2026)", () => {
  const summary = "Raised automatically by Recruiting OS: one candidate's application needs a recruiter's review.";
  const preview = { id: "r1", status: "open", kind: "review", urgency: "normal", requiredExpertise: "candidate evaluation; dental hiring", summary, companyName: "Salman Family Dental", roleTitle: "Dental assistant", slaDueAt: null, slaRemainingMinutes: null, businessMinutesRemaining: null, overdue: false, createdAt: "2026-10-15T10:00:00.000Z", claimedByMe: false, claimed: false };

  it("before Accept: says Recruiting OS raised it, and that Accept shows who it is about; no name", () => {
    const qc = client();
    qc.setQueryData(["escalations"], [preview]);
    qc.setQueryData(["escalation", "r1"], { ...preview, accessGranted: false, why: "claim it to open the full context" });
    const words = text(render(qc, createElement(RecruiterQueue)));
    // the queue list: the role, then who raised it and why
    expect(words).toContain(`Dental assistant · ${summary}`);
    expect(words).toContain(summary);
    expect(words).toContain("Accept to open the full request and see who or what it is about.");
    expect(words).toContain("Your access covers only what the request is about, ends a day after it is resolved, and every page you open is recorded for the customer.");
    expect(words).toContain("Accept this request");
    expect(words).not.toContain("About:");
  });

  it("after Accept: the candidate and the role at the top of the request card", () => {
    const qc = client();
    const held = { ...preview, status: "claimed", claimedByMe: true, claimed: true };
    qc.setQueryData(["escalations"], [held]);
    qc.setQueryData(["escalation", "r1"], {
      ...held, accessGranted: true, why: null, companyId: "co1", roleId: "role1", applicationId: "app1", question: "Processing this application stopped after 4 tries and needs a person to take over.",
      contextSnapshot: { company: { name: "Salman Family Dental", vertical: "dental", sizeBand: "1-19" }, role: { title: "Dental assistant", status: "open" }, candidate: { name: "Lena Ortiz", email: "lena.ortiz@example.com", phone: null }, application: { stage: "triaged" } },
      thread: [{ id: "r1:question", side: "customer", kind: "question", body: "Processing this application stopped after 4 tries and needs a person to take over.", by: null, at: "2026-10-15T10:00:00.000Z", raisedBy: "system" }],
      reopenedCount: 0, grant: { id: "g1", purpose: `review: ${summary}`, expiresAt: "2026-10-29T10:00:00.000Z", scope: { roleId: "role1", applicationId: "app1" } },
    });
    const words = text(render(qc, createElement(RecruiterQueue)));
    expect(words).toContain("About: Lena Ortiz · Dental assistant");
    // at the very top of the request card (the queue list on the left comes first): under its title, before the card's
    // summary and the request itself
    const about = words.indexOf("About: Lena Ortiz");
    expect(about).toBeGreaterThan(words.indexOf("review · Salman Family Dental · Dental assistant"));
    expect(about).toBeLessThan(words.lastIndexOf(summary));
    expect(about).toBeLessThan(words.indexOf("Processing this application stopped"));
    expect(words).not.toContain("Accept to open the full request");
    // the conversation says who raised it, as the summary above it does: never "The customer asked"
    expect(words).toContain("Raised automatically by Recruiting OS · ");
    expect(words.indexOf("Raised automatically by Recruiting OS · ")).toBeLessThan(words.indexOf("Processing this application stopped"));
    expect(words).not.toContain("The customer asked");
    expect(words).not.toContain("The customer's request");
  });

  it("the page header and the empty queue do not say every request comes from a customer", () => {
    const qc = client();
    qc.setQueryData(["escalations"], []);
    const html = render(qc, createElement(RecruiterQueue));
    const words = text(html);
    // fewer words (23 October): the title alone, no eyebrow, no line describing the page; the empty queue's one line
    expect(html).toContain("<h1>Recruiter queue</h1>");
    expect(words).not.toContain("ITS recruiters");
    expect(words).not.toContain("Requests from customers");
    expect(words).toContain("Queue is empty");
    expect(words).not.toContain("Requests appear here.");
    expect(words).not.toContain("Customer requests appear here.");
  });

  it("after Accept with no candidate (a role request): no About line", () => {
    const qc = client();
    const held = { ...preview, summary: "The customer wants a recruiter to review the candidates for this role.", status: "claimed", claimedByMe: true, claimed: true };
    qc.setQueryData(["escalations"], [held]);
    qc.setQueryData(["escalation", "r1"], { ...held, accessGranted: true, why: null, companyId: "co1", roleId: "role1", applicationId: null, question: "Who should we call first?", contextSnapshot: { role: { title: "Dental assistant", status: "open" } }, thread: [], reopenedCount: 0, grant: { id: "g1", purpose: "review", expiresAt: "2026-10-29T10:00:00.000Z", scope: { roleId: "role1", applicationId: null } } });
    expect(text(render(qc, createElement(RecruiterQueue)))).not.toContain("About:");
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
    // the empty state's one line, then its two ways forward (founder, 23 October 2026: fewer words)
    expect(words).toContain("About the company Nothing yet.");
    expect(words).not.toContain("Job pages show the job without an \"about the company\" part");
    expect(words).not.toContain("What candidates see on your careers page and every job page.");
    expect(words).toContain("Draft it with the assistant");
    expect(words).toContain("Write it yourself");
    // the boards: ITS posts by default, ZipRecruiter only with the company's own plan; the services table says ITS posts
    expect(html).toMatch(/<button type="button" class="on" aria-pressed="true">ITS posts them for us<\/button>/);
    expect(words).toContain("We have our own paid ZipRecruiter plan");
    expect(words).toContain("ITS posts your jobs here from your company's own account");
    // who candidates write to before they apply: the ITS inbox until the company sets its own (plan D10)
    expect(words).toContain("Who candidates can write to before they apply");
    expect(words).toContain("Candidates see: help@its.test. This is the ITS inbox that answers for your company.");
    expect(words).not.toContain("set your own address to have them write to you");
    expect(words).toContain("Set your own contact");
  });

  it("shows the company's own contact once it is set, with the way back to the ITS inbox", () => {
    const words = text(page({ hiringContact: { email: "jobs@bright.test", name: "Dana" } }));
    // the address alone: its buttons already say it is the company's own
    expect(words).toContain("Candidates see: Dana, jobs@bright.test. Change the contact");
    expect(words).not.toContain("Your own address, set here.");
    expect(words).toContain("Change the contact");
    expect(words).toContain("Use the ITS inbox");
  });

  it("shows the approved words with who approved them, and the stored logo", () => {
    const html = page({ logoUrl: "/files/logo/co1.png", about: { text: "We are a family dental practice in Irvine.", approvedAt: "2026-10-05T10:00:00.000Z", approvedBy: { id: "u1", name: "Dana Whitfield" } }, boardPosting: "self", zipRecruiterPlan: true });
    const words = text(html);
    expect(html).toContain('<img src="/files/logo/co1.png" alt="Bright Dental logo"/>');
    expect(words).toContain("We are a family dental practice in Irvine.");
    expect(words).toMatch(/Approved by Dana Whitfield on [^.]+\./);
    expect(words).not.toContain("Shown on your careers page and every job page.");
    // beside a stored logo, nothing: where it shows is not said again
    expect(words).not.toContain("Shown at the top of your careers page");
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
    // the title then the checkbox; the explanation of what candidates choose waits under How this works (fewer words, 23 Oct)
    const card = words.slice(words.indexOf("When a candidate cancels"));
    expect(card).toMatch(/^When a candidate cancels Send new times automatically/);
    expect(card.indexOf("How this works")).toBeLessThan(card.indexOf("When candidates cancel a booked interview"));
    expect(html).toMatch(/<input type="checkbox" checked=""\/>Send new times automatically to people who ask for them/);
    expect(html).toMatch(/<input id="new-times-days" class="input w-25" type="number" min="1" max="10" step="1" value="3"\/>/);
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
    expect(html).toMatch(/<fieldset class="share-buttons[^"]*" aria-label="Share the job">/);
    // and the way to the Share tab's LinkedIn post (Wave S2)
    expect(html).toContain('<a href="/roles/r1?tab=share#linkedin">Post on LinkedIn</a>');
  });
});
