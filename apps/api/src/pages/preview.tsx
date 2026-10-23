/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono, type Context, type Next } from "hono";
import { desc, eq } from "drizzle-orm";
import type { DraftRolePacket } from "@ros/contracts";
import { PermissionError, applyByLabel, assertCan, benefitsDescriptionFor, jobNoticesFor, scopeAllows } from "@ros/core";
import { companies, rolePackets, roles, withTenant } from "@ros/db";
import type { Container } from "../container";
import { HttpError, PERMISSION_MESSAGE } from "../middleware/errors";
import { rolesInterviewedBy, type Tenant, type Vars } from "../middleware/session";
import { loadDraft } from "../routes/intake";
import { approvedAbout, contactLineFor, logoMemberPath, profileOf } from "../services/company-settings-profile";
import { APPLY_FLOW, jobPreview, type ApplyFlowView, type PreviewSource } from "../services/job-preview";
import { jobUrls } from "../services/job-urls";
import { currentVersionOf } from "../services/packet-versions";
import { ApplyFormPage } from "./apply-form";
import { JobPage, type JobPageCompany, type JobPageRole, type PreviewInfo } from "./job-page";
import { Layout } from "./layout";
import { withPlainQuestionHelp } from "./question-help";

/**
 * The authenticated preview of a job page (plan D1): the very page and apply form candidates get, drawn by the same
 * components (pages/job-page.tsx) from a saved version or from the job builder's draft, before anything is public. It
 * needs `role.read` and `compensation.read` (the page shows the pay, so an interviewer cannot open it), is served from
 * the app's own address under /api (never under /careers), is marked "not public yet", is kept out of search engines
 * (a robots tag and header), carries no JobPosting data and no share tags, and its form sends nothing. Its data is the
 * job builder's preview data (services/job-preview.ts): the banner and what the page is still missing.
 *
 * Addresses: GET /api/v1/roles/:id/preview?version=N and GET /api/v1/intake/sessions/:id/preview answer a browser tab
 * (which asks for a page) with the page and the app's own requests with the data (routes/role-packets.ts); the same
 * pages are always at .../preview/page. `&view=apply` shows the apply form. These pages are mounted before the role
 * routes (app.ts), so every refusal, an interviewer's "Role not found." included, is this plain page, never the API's JSON.
 */
export const rolePreviewPages = new Hono<Vars>();
export const draftPreviewPages = new Hono<Vars>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A browser opening the address in a tab asks for a page first; the app's own requests ask for anything (data). */
function wantsPage(c: Context<Vars>): boolean {
  return (c.req.header("accept") ?? "").split(",")[0].trim().toLowerCase() === "text/html";
}

/** A preview that cannot be shown says why, as a page (the person opened it in a tab), with the status the data route would give. */
function problemPage(c: Context<Vars>, err: unknown) {
  const known = err instanceof HttpError ? { status: err.status, message: err.message } : err instanceof PermissionError ? { status: 403, message: `${PERMISSION_MESSAGE} Seeing the job page before it is public needs access to the role and its pay.` } : null;
  if (!known) throw err;
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  return c.html(
    <Layout title="Preview not available" noindex>
      <h1>This preview cannot be shown</h1>
      <p>{known.message}</p>
    </Layout>,
    known.status as 401,
  );
}

/** Signed in, in a company, and for ITS staff under a grant, inside the grant's role. */
function tenantFor(c: Context<Vars>, roleId?: string): Tenant {
  if (!c.get("session")) throw new HttpError(401, "unauthorized", "Sign in to see this preview, then open it again.");
  const t = c.get("tenant");
  if (!t) throw new HttpError(403, "no_company", "Create or join a company first.");
  if (t.staff && roleId && !scopeAllows({ roleId: t.staff.scope.roleId, applicationId: t.staff.scope.applicationId }, { roleId })) throw new HttpError(403, "staff_scope", "Your access is limited to the role and candidate of the escalation you accepted.");
  return t;
}

type CompanyRow = typeof companies.$inferSelect;

/** The company as its job page would show it; the logo comes from the team's own address, since nothing may be public yet. */
function previewCompany(company: CompanyRow, container: Container): JobPageCompany {
  const logo = profileOf(company.settings).logo;
  return { name: company.name, slug: company.slug, about: approvedAbout(company.settings), website: company.settings.website ?? null, logoSrc: logo ? logoMemberPath(logo) : null, contact: contactLineFor(company.settings, container.env) };
}

/** What the page could still show about the company (plan D10), added to the builder's own list of what is missing. */
function profileGaps(company: CompanyRow): string[] {
  const p = profileOf(company.settings);
  return [
    ...(approvedAbout(company.settings) ? [] : ["There is no text about your company yet. Draft and approve it in Settings, and it shows on every job page."]),
    ...(p.logo ? [] : ["There is no logo yet. Upload one in Settings; until then the page shows your initials."]),
  ];
}

/** The job page or the apply form for a packet, with the preview's note and its own links. */
function render(c: Context<Vars>, input: { packet: DraftRolePacket; company: CompanyRow; role: JobPageRole; preview: PreviewInfo; flow: ApplyFlowView }) {
  const container = c.get("container");
  const { packet, company, role, preview, flow } = input;
  const notices = jobNoticesFor({ jobLocations: packet.identity.locations, companyLocations: company.locations, overrides: company.settings.notices });
  const view = previewCompany(company, container);
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex, nofollow");
  if (c.req.query("view") === "apply") {
    return c.html(<ApplyFormPage company={{ slug: company.slug, name: company.name, contact: view.contact }} role={{ id: role.id }} packet={withPlainQuestionHelp(packet)} notices={notices} smsEnabled={container.env.SMS_ENABLED} privacyEmail={container.env.PRIVACY_EMAIL} formOpened="" flow={flow} links={{ job: preview.jobHref, uploadIntent: "" }} preview={preview} />);
  }
  return c.html(<JobPage packet={packet} company={view} role={role} notices={notices} smsEnabled={container.env.SMS_ENABLED} flow={flow} benefits={benefitsDescriptionFor(packet.compensation, company.settings)} links={{ careers: null, apply: preview.applyHref }} preview={preview} />);
}

/** The preview's own addresses: the same path it was opened at, with the version and the view. */
function hrefs(c: Context<Vars>, params: Record<string, string>): { jobHref: string; applyHref: string } {
  const at = (extra: Record<string, string>) => {
    const q = new URLSearchParams({ ...params, ...extra }).toString();
    return q ? `${c.req.path}?${q}` : c.req.path;
  };
  return { jobHref: at({}), applyHref: at({ view: "apply" }) };
}

/** A saved version of a role: the newest unless `?version=N`. */
async function rolePreview(c: Context<Vars>) {
  try {
    const roleId = c.req.param("id") ?? "";
    const t = tenantFor(c, roleId);
    const container = c.get("container");
    // An interviewer reads only the roles they interview for (roleScopeGuard's rule): any other answers as one that does
    // not exist, on this page as on the data route.
    if (t.role === "interviewer" && UUID.test(roleId) && !(await withTenant(container.db, t.companyId, (tx) => rolesInterviewedBy(tx, t.userId, roleId))).has(roleId)) throw new HttpError(404, "not_found", "Role not found.");
    assertCan(t.role, "role.read");
    assertCan(t.role, "compensation.read");
    if (!UUID.test(roleId)) throw new HttpError(404, "not_found", "Role not found.");
    const asked = c.req.query("version");
    const found = await withTenant(container.db, t.companyId, async (tx) => {
      const [role] = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1);
      if (!role) throw new HttpError(404, "not_found", "Role not found.");
      const versions = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
      const pv = asked ? versions.find((v) => String(v.version) === asked) : versions[0];
      if (!pv) throw new HttpError(404, "version_not_found", "That version does not exist.");
      const [company] = await tx.select().from(companies).where(eq(companies.id, role.companyId)).limit(1);
      return { role, pv, company, current: currentVersionOf(role, versions), flow: APPLY_FLOW };
    });
    const { role, pv, company, flow } = found;
    const source: PreviewSource = { kind: "version", roleId: role.id, version: pv.version, status: pv.status, current: found.current?.version === pv.version && !!role.currentPacketVersion, roleStatus: role.status };
    const meta = jobPreview({ packet: pv.packet, company, source, smsEnabled: container.env.SMS_ENABLED, flow });
    const preview: PreviewInfo = { notPublicYet: meta.notPublicYet, banner: meta.banner, gaps: [...meta.gaps, ...profileGaps(company)], ...hrefs(c, { version: String(pv.version) }), publicHref: meta.notPublicYet ? null : jobUrls(container.env, { slug: company.slug, roleId: role.id }).job };
    // Shown as candidates will meet it once it is live: taking applications, with its closing date when it has one.
    const view: JobPageRole = { id: role.id, accepting: true, closedMessage: null, postedOn: role.openedAt, applyBy: role.applicationsCloseOn ? applyByLabel(role.applicationsCloseOn) : null };
    return render(c, { packet: pv.packet, company, role: view, preview, flow });
  } catch (err) {
    return problemPage(c, err);
  }
}

/** The job builder's draft before the role exists (plan C9): only for the person drafting it, by the builder's own rule. */
async function draftPreview(c: Context<Vars>) {
  try {
    const t = tenantFor(c);
    assertCan(t.role, "compensation.read");
    const row = await loadDraft(c, c.req.param("id") ?? "");
    if (row.status !== "active") throw new HttpError(409, "not_active", "This draft has already produced a role, or it was set aside. Open the role to preview it.");
    if (!row.draftPacket) throw new HttpError(409, "no_draft", "Write the draft first; then you can preview it.");
    const container = c.get("container");
    // A draft has no role yet; every job takes the same path to the AI interview (20 Oct 2026).
    const flow = APPLY_FLOW;
    const [company] = await withTenant(container.db, t.companyId, (tx) => tx.select().from(companies).where(eq(companies.id, t.companyId)).limit(1));
    if (!company) throw new HttpError(404, "not_found", "Company not found.");
    const meta = jobPreview({ packet: row.draftPacket, company, source: { kind: "draft", sessionId: row.id }, smsEnabled: container.env.SMS_ENABLED, flow });
    const preview: PreviewInfo = { notPublicYet: true, banner: meta.banner, gaps: [...meta.gaps, ...profileGaps(company)], ...hrefs(c, {}), publicHref: null };
    return render(c, { packet: row.draftPacket, company, role: { id: row.id, accepting: true, closedMessage: null, postedOn: null, applyBy: null }, preview, flow });
  } catch (err) {
    return problemPage(c, err);
  }
}

/** The plan's address answers a browser tab with the page and leaves the app's data requests to the data route. */
const pageOrData = (handler: (c: Context<Vars>) => Promise<Response>) => async (c: Context<Vars>, next: Next) => (wantsPage(c) ? handler(c) : next());

rolePreviewPages.get("/:id/preview", pageOrData(rolePreview));
rolePreviewPages.get("/:id/preview/page", rolePreview);
draftPreviewPages.get("/sessions/:id/preview", pageOrData(draftPreview));
draftPreviewPages.get("/sessions/:id/preview/page", draftPreview);
