import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * "Try different weights" (founder decision L-07 A, preview only), as the server first draws it: the preview label in
 * the drawer's header, the must-haves and the scored skills each with a labelled choice set to the job's own level, the
 * candidates in score order with plain numbers (never the score badge), "Use these weights" waiting for a change, and
 * the job page's Scoring tab offering it only to whoever may edit the job.
 */
const nav = vi.hoisted(() => ({ search: "tab=scoring" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/roles/r1",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({ id: "r1" }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));
vi.mock("@ros/web/src/components/use-is-client", () => ({ useIsClient: () => true }));

(globalThis as { React?: typeof React }).React = React;
const { WeightsPreview } = await import("@ros/web/src/pages/role/WeightsPreview");
const { RoleDetail } = await import("@ros/web/src/pages/RoleDetail");
const wp = await import("@ros/web/src/weights-preview");
const { READ_FROM_NOW_ON } = await import("@ros/web/src/skills-form");
const { samplePacket } = await import("../../../packages/agents/src/fixtures/sample-packet");
const { matchScore } = await import("../../../packages/core/src/match-score");
type Packet = import("@ros/web/src/api/client").RolePacket;
type Finding = { key: string; met: "yes" | "no" | "partially" | "unknown"; quote?: string };

// The sample packet's must-haves (radiography, chairside experience) and skills (chairside Essential, patient care and
// infection control Important), with one more skill checked in the interviews only.
const packet = samplePacket((p) => {
  p.competencies = [...p.competencies, { key: "manner", name: "Bedside manner", definition: "Calm with every patient.", weight: 3, evaluatedIn: "interview", indicators: ["A story"] }];
}) as unknown as Packet;
const scoreFrom = (musts: Finding[], skills: Finding[]) => matchScore({ resume: { kind: "triage", createdAt: "2026-10-01T10:00:00Z", packetVersion: 3, result: { requirementFindings: musts.map((m) => ({ requirementKey: m.key, met: m.met, ...(m.quote ? { evidence: { source: "resume" as const, quote: m.quote } } : {}) })), competencyFindings: skills.map((s) => ({ competencyKey: s.key, finding: s.met === "yes" ? "evidenced" as const : s.met === "no" ? "contradicted" as const : "partially_evidenced" as const, ...(s.quote ? { evidence: { source: "resume" as const, quote: s.quote } } : {}) })) } }, screen: null }, packet as never)!;
const both = [{ key: "mh_xray", met: "yes" as const, quote: "Radiography certificate, 2021" }, { key: "mh_chairside", met: "yes" as const, quote: "Four years chairside" }];
const people = {
  // 100: everything shown
  ana: scoreFrom(both, [{ key: "chairside", met: "yes", quote: "x" }, { key: "patients", met: "yes", quote: "y" }, { key: "infection", met: "yes", quote: "z" }]),
  // patient care goes against him
  bo: scoreFrom(both, [{ key: "chairside", met: "yes", quote: "x" }, { key: "patients", met: "no", quote: "I avoid nervous patients" }, { key: "infection", met: "yes", quote: "z" }]),
  // the radiography certificate shown not met holds the score
  cai: scoreFrom([{ key: "mh_xray", met: "no", quote: "I have no radiography certificate" }, both[1]], [{ key: "chairside", met: "yes", quote: "x" }]),
};
const card = (applicationId: string, name: string, score: unknown, ownerStageLabel = "New") => ({ applicationId, name, ownerStage: "new", ownerStageLabel, score, readingVersion: null, placement: {}, facts: {} });
const board = {
  role: { id: "r1", title: "Dental Assistant", status: "open", currentPacketVersion: 3 },
  columns: { shortlist: [card("a1", "Ana Lopez", people.ana, "Shortlist")], longlist: [card("a3", "Cai Wong", people.cai), card("a2", "Bo Chen", people.bo)], not_moving_forward: [] },
  stillApplying: [card("a4", "Dot Reyes", null)],
  summary: { total: 4 },
  generatedAt: "2026-10-16T09:00:00.000Z",
};

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
function client(data: Array<[unknown[], unknown]> = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  for (const [key, value] of data) qc.setQueryData(key, value);
  return qc;
}
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const drawn = () => render(client([[["applications", "r1", "board"], board]]), createElement(WeightsPreview, { roleId: "r1", packet, onClose: () => undefined, onUse: () => undefined }));

describe("the weights preview drawer", () => {
  it("says in its header that it is a preview nothing is saved from", () => {
    const html = drawn();
    expect(html).toContain('aria-label="Try different weights"');
    expect(html).toMatch(/<div class="drawer-banner"><div class="alert info" role="status">Preview — nothing is saved; candidates and the team never see these numbers\.<\/div><\/div>/);
    expect(text(html)).toContain(wp.INTRO);
  });

  it("lists the must-haves and the scored skills in their own groups, each with a labelled choice at the job's own level", () => {
    const html = drawn();
    expect(html).toContain('<fieldset class="weights-set"><legend>Must-haves</legend>');
    expect(html).toContain('<fieldset class="weights-set"><legend>Skills we look for</legend>');
    for (const [id, label, level] of [["weights-m-mh_xray", "Radiography certificate", "must_have"], ["weights-m-mh_chairside", "Chairside experience in a dental office", "must_have"], ["weights-s-chairside", "Chairside skill", "essential"], ["weights-s-patients", "Patient care", "important"], ["weights-s-infection", "Infection control", "important"]]) {
      expect(html).toContain(`<label for="${id}">${label}</label><select id="${id}" class="select">`);
      expect(html).toMatch(new RegExp(`<select id="${id}" class="select">(?:(?!</select>).)*<option value="${level}" selected="">`));
    }
    // the skill checked in the interviews only is not offered, and the drawer says why
    expect(html).not.toContain("Bedside manner");
    expect(text(html)).toContain(wp.INTERVIEW_ONLY_LINE);
    expect(html).toContain('<option value="off">Leave out of the score</option>');
  });

  it("lists the candidates in score order with plain numbers, never the score badge, and counts those with no score apart", () => {
    const html = drawn();
    const t = text(html);
    expect(people.ana.score).toBe(100);
    const at = (who: string) => t.indexOf(who);
    expect(at("Ana Lopez")).toBeLessThan(at("Bo Chen"));
    expect(at("Bo Chen")).toBeLessThan(at("Cai Wong"));
    expect(t).toContain(`Preview ${people.bo.score} · now ${people.bo.score}`);
    expect(t).toContain("These are the job's own weights: this is the order today.");
    expect(html).toContain('<p role="status" class="weights-status">');
    expect(html).toContain('<ol class="weights-order">');
    expect(t).toContain("1 person has no match score yet, so they are not in this order.");
    expect(t).not.toContain("Dot Reyes");
    // the badge's markup ("91/100", class "score") never appears: these numbers must not pass for real scores
    expect(html).not.toMatch(/class="score[ "]/);
    expect(html).not.toContain("/100");
  });

  it("waits for a change before \"Use these weights\", and says what saving in the editor does", () => {
    const html = drawn();
    expect(html).toMatch(/<button type="button" class="btn primary sm" disabled="" title="Change a weight first">Use these weights<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn secondary sm" disabled="">Back to the job&#x27;s weights<\/button>/);
    expect(text(html)).toContain(READ_FROM_NOW_ON);
    expect(text(html)).toContain(wp.USE_WEIGHTS_LINE);
  });

  it("says so plainly while nobody has a score yet", () => {
    const empty = { ...board, columns: { shortlist: [], longlist: [card("a4", "Dot Reyes", null)], not_moving_forward: [] }, stillApplying: [] };
    const t = text(render(client([[["applications", "r1", "board"], empty]]), createElement(WeightsPreview, { roleId: "r1", packet, onClose: () => undefined, onUse: () => undefined })));
    expect(t).toContain("Nobody has a match score yet");
  });
});

describe("the Scoring tab of the job page", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const job = {
    id: "r1", title: "Dental Assistant", status: "open", acceptingApplications: true, applicationsClosedAt: null, applicationsClosedReason: null, closingDate: null, proposedPacket: null, packetApproval: { pending: null, latest: null },
    packetVersions: [{ version: 3, status: "approved", source: "editor", createdAt: daysAgo(2), createdBy: { kind: "user", id: "u2", name: "Dana Whitfield" }, changeSummary: null }],
    counts: { new: 3, longlist: 1 }, boardsStillUp: [], boardsShowingOldVersion: [], whoPosts: "its", decisionMaker: null, pendingApprovals: [], postings: [],
    currentPacket: { version: 3, status: "approved", packet },
  };
  const me = (memberships: Array<{ role: string }>, applicationId: string | null = null) => ({
    user: { id: "u1", email: "dana@harbor.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null },
    memberships: memberships.map((m) => ({ companyId: "co1", companyName: "Harbor Dental", companySlug: "harbor-dental", role: m.role })), activeCompanyId: "co1",
    staffAccess: applicationId ? { grantId: "g1", kind: "review", purpose: "A recruiter request", expiresAt: daysAgo(-1), companyName: "Harbor Dental", scope: { escalationId: "e1", roleId: null, applicationId } } : null,
    ai: { provider: "fake" },
  });
  const page = (who: ReturnType<typeof me>) => text(render(client([[["me"], who], [["company"], { settings: { verifiedAt: "2026-10-01T00:00:00.000Z" } }], [["role", "r1"], job]]), createElement(RoleDetail)));

  it("offers \"Try different weights\" to an owner, beside changing the skills", () => {
    const t = page(me([{ role: "owner" }]));
    expect(t).toContain("Change the skills or how much each counts");
    expect(t).toContain("Try different weights");
  });

  it("never to HR (who cannot edit the job), nor to an ITS recruiter given one candidate", () => {
    expect(page(me([{ role: "hr" }]))).not.toContain("Try different weights");
    expect(page(me([], "app-7"))).not.toContain("Try different weights");
    // even holding a recruiter's rights in the company, a grant about one candidate has no order to change
    const scoped = page(me([{ role: "recruiter" }], "app-7"));
    expect(scoped).toContain("Change the skills or how much each counts");
    expect(scoped).not.toContain("Try different weights");
  });

  it("not before anyone has applied", () => {
    const t = text(render(client([[["me"], me([{ role: "owner" }])], [["company"], { settings: { verifiedAt: "2026-10-01T00:00:00.000Z" } }], [["role", "r1"], { ...job, counts: {} }]]), createElement(RoleDetail)));
    expect(t).toContain("Change the skills or how much each counts");
    expect(t).not.toContain("Try different weights");
  });
});
