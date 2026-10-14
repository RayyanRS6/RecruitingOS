import { Hono, type Context } from "hono";
import { and, desc, eq, gte, inArray, lt, lte, or } from "drizzle-orm";
import { GettingStartedRequest, UpdateCompany, isCompanyVerified, type Actor, type NewTimesSettingView } from "@ros/contracts";
import { DEFAULT_NOTICES, applyNoticeOverrides, assertCan, audit, boardPostingOf, emit, newTimesSettingOf, pendingNewTimesRows, revokeSessionsForCompany, setAutoState, withdrawPostingTasks, zipRecruiterOffered } from "@ros/core";
import { auditRecords, companies, memberships, uuidv7, withPlatform, withTenant, type Tx } from "@ros/db";
import { LOGO_MAX_BYTES, inspectLogo, logoFileName, logoKey } from "@ros/integrations";
import { cancelNewTimesRuns } from "@ros/workflows";
import { actorOf, clientIp, requireTenant, type Tenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { assertRecentAuth } from "../middleware/reauth";
import { CUSTOMER_AUDIT_ACTIONS, auditCsv, customerAuditRow, isoTime } from "../services/audit-history";
import { AboutApproval, AboutDraftRequest, HiringContactInput, aboutWordingProblem, draftAbout, logoMemberPath, logoResponse, profileOf, publicProfileView, type SettingsWithProfile } from "../services/company-settings-profile";
import { dismissGettingStarted, markPoliciesReviewed } from "../services/company-trust";
import { openMissingTasksAndTell } from "../services/publishing-backfill";

/**
 * Company preferences, what the job pages say about the company (plan D10), the customer's audit history and member
 * sign-out (audit findings A8, A9, A11, J16). Mounted under /api/v1/companies next to routes/companies.ts, which keeps
 * the company itself, the team and recruiter access.
 */
export const companySettingsRoutes = new Hono<Vars>();

/** Keys a customer may never set here; naming them gives a plain answer instead of a generic validation error. */
const ADMIN_ONLY_COMPANY_KEYS: Record<string, string> = {
  planKey: "the plan", plan: "the plan", status: "the account status", slug: "the careers page address", vertical: "the kind of business", id: "the company id", entitlements: "the allowances", usage: "the allowances",
};
const ADMIN_ONLY_SETTINGS_KEYS: Record<string, string> = { pilot: "the pilot term", retention: "the retention periods", brief: "the daily brief settings", entitlements: "the allowances", plan: "the plan", verifiedAt: "the ITS company check", verifiedBy: "the ITS company check", onboarding: "the getting-started checklist" };

/** Settings with their own routes below (plan D10): named here so a PATCH that sends them gets a plain answer. */
const PROFILE_SETTINGS_KEYS: Record<string, string> = {
  about: "The text about your company is drafted and approved under \"How candidates see you\" in Settings.",
  aboutDraft: "The text about your company is drafted and approved under \"How candidates see you\" in Settings.",
  logo: "Upload the logo under \"How candidates see you\" in Settings.",
  hiringContact: "Set the contact for candidates under \"How candidates see you\" in Settings.",
};

function refuseAdminOnlyKeys(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const body = raw as Record<string, unknown>;
  for (const k of Object.keys(body)) if (ADMIN_ONLY_COMPANY_KEYS[k]) throw new HttpError(400, "not_yours_to_change", `You cannot change ${ADMIN_ONLY_COMPANY_KEYS[k]} here. Identified Talent Solutions sets it; ask them.`, { field: k });
  const settings = body.settings;
  if (settings && typeof settings === "object") for (const k of Object.keys(settings as Record<string, unknown>)) {
    if (ADMIN_ONLY_SETTINGS_KEYS[k]) throw new HttpError(400, "not_yours_to_change", `You cannot change ${ADMIN_ONLY_SETTINGS_KEYS[k]} here. Identified Talent Solutions sets it; ask them.`, { field: `settings.${k}` });
    if (PROFILE_SETTINGS_KEYS[k]) throw new HttpError(400, "use_its_own_page", PROFILE_SETTINGS_KEYS[k], { field: `settings.${k}` });
  }
}

/**
 * The logo is uploaded and stored by us (plan D10); its address is ours, so a form that sends it back unchanged is
 * answered as if it had not (the address can be on a plain-http host in development, which the https-only check of a
 * typed address would refuse). Anything else in `logoUrl` is judged below.
 */
function withoutStoredLogoUrl(raw: unknown, settings: SettingsWithProfile): unknown {
  const s = (raw as { settings?: Record<string, unknown> } | null)?.settings;
  if (!s || typeof s !== "object" || typeof s.logoUrl !== "string" || !settings.logo || s.logoUrl.trim() !== (settings.logoUrl ?? "")) return raw;
  const rest = { ...s };
  delete rest.logoUrl;
  return { ...(raw as Record<string, unknown>), settings: rest };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What switching automatic new times off, or changing their days, did: recorded on the audit record and the event. */
type NewTimesChange = { before: { auto: boolean; workingDays: number }; after: { auto: boolean; workingDays: number }; pendingChoice: "keep" | "stop" | null; stopped: number };

/**
 * Preferences owners and admins change themselves: name, website, locations, time zone, size, careers-page intro,
 * benefits summary, taking the logo off (it is uploaded below), contact hours, the wording of the candidate notices and
 * the automatic new times after a candidate cancels (founder decision 3A). Every change is audited with the
 * keys that changed and emitted; a reworded notice gets a new version (the date) that the candidate pages show from
 * then on. Rewording a notice, or changing what reaches candidates without a person (the new times), needs a fresh
 * sign-in (audit finding A12). Switching the new times off while people were already told a day for theirs needs the
 * owner's choice for them (`pending`: "keep" or "stop"), never assumed: 409 `pending_choice_needed` with the count. The
 * answer carries `pendingNewTimes`, how many automatic sets are still promised a day.
 */
companySettingsRoutes.patch("/current", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.update");
  if (t.staff) throw new HttpError(403, "forbidden", "Recruiters cannot change a customer's company settings.");
  const raw = await c.req.json().catch(() => { throw new HttpError(400, "invalid_request", "Send the changes as JSON."); });
  refuseAdminOnlyKeys(raw);
  const container = c.get("container");
  const [stored] = await withTenant(container.db, t.companyId, (tx) => tx.select({ settings: companies.settings }).from(companies).where(eq(companies.id, t.companyId)).limit(1));
  const body = UpdateCompany.parse(withoutStoredLogoUrl(raw, profileOf(stored?.settings) as SettingsWithProfile));
  if (body.settings?.notices) assertRecentAuth(c);
  if (body.settings?.newTimesAfterCancel) assertRecentAuth(c);
  const now = container.engine.clock();
  const actor = actorOf(c);
  const removedLogo: { key: string | null } = { key: null };
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    // Locked: the settings are written back whole, so an ITS confirmation made meanwhile (services/company-trust.ts) is kept.
    const [existing] = await tx.select().from(companies).where(eq(companies.id, t.companyId)).limit(1).for("update");
    if (!existing) throw new HttpError(404, "not_found", "Company not found.");
    const patch: Partial<typeof companies.$inferInsert> = {};
    const fields: string[] = [];
    if (body.name !== undefined && body.name !== existing.name) { patch.name = body.name; fields.push("name"); }
    if (body.timezone !== undefined && body.timezone !== existing.timezone) { patch.timezone = body.timezone; fields.push("timezone"); }
    if (body.sizeBand !== undefined && body.sizeBand !== existing.sizeBand) { patch.sizeBand = body.sizeBand; fields.push("sizeBand"); }
    if (body.locations !== undefined && !sameJson(body.locations, existing.locations)) { patch.locations = body.locations; fields.push("locations"); }
    const settings = { ...existing.settings };
    const s = body.settings ?? {};
    const website = body.website ?? s.website;
    if (website !== undefined && (website || "") !== (existing.settings.website ?? "")) { if (website) settings.website = website; else delete settings.website; fields.push("website"); }
    if (s.logoUrl !== undefined && (s.logoUrl || "") !== (existing.settings.logoUrl ?? "")) {
      // The logo is uploaded, stored and served by us (plan D10): a typed address could not show on the job pages, whose
      // policy loads images from our own address only. An empty value takes the logo off.
      if (s.logoUrl) throw new HttpError(400, "logo_upload_only", "Upload the logo as an image file instead of typing its address: we keep a copy, so it shows on your careers page and job pages.", { field: "settings.logoUrl" });
      const profile = settings as SettingsWithProfile;
      removedLogo.key = profile.logo?.key ?? null;
      delete settings.logoUrl;
      delete profile.logo;
      fields.push("logoUrl");
    }
    if (s.benefitsSummary !== undefined && (s.benefitsSummary || "") !== (existing.settings.benefitsSummary ?? "")) { if (s.benefitsSummary) settings.benefitsSummary = s.benefitsSummary; else delete settings.benefitsSummary; fields.push("benefitsSummary"); }
    // Who posts on the job boards (plan D3): ITS unless the company says its own team does. Boards already waiting keep
    // the tasks or cards they have; the choice applies to what is posted, updated or taken down from now on.
    if (s.boardPosting !== undefined && s.boardPosting !== boardPostingOf(existing.settings)) { settings.boardPosting = s.boardPosting; fields.push("boardPosting"); }
    // The company's own paid ZipRecruiter plan (Q11): only then is ZipRecruiter offered as a board.
    if (s.zipRecruiterPlan !== undefined && s.zipRecruiterPlan !== zipRecruiterOffered(existing.settings)) { if (s.zipRecruiterPlan) settings.zipRecruiterPlan = true; else delete settings.zipRecruiterPlan; fields.push("zipRecruiterPlan"); }
    // The automatic new times after a candidate cancels (founder decision 3A). Changing the days never moves anyone
    // already told a day: their due moment is stored. Switching off while people were told a day is the owner's call for
    // them, asked, never assumed: "keep" (they still get them on that day) or "stop" (stopped now, the team takes over).
    let newTimesChange: NewTimesChange | null = null;
    const nt = s.newTimesAfterCancel;
    const before = newTimesSettingOf(existing.settings);
    if (nt !== undefined && !sameJson({ auto: nt.auto, workingDays: nt.workingDays }, before)) {
      // Locked, inside the transaction that holds the company row. A candidate's cancel reads the setting under a share
      // lock on that row (`autoNewTimesPlan`), so a set cannot start waiting while the choice is applied: a cancel that
      // came first is listed here, and one that comes after reads the setting as saved.
      const pending = before.auto && !nt.auto ? await pendingNewTimesRows(tx, t.companyId, { lock: true }) : [];
      if (pending.length && !nt.pending) throw new HttpError(409, "pending_choice_needed", `${pending.length} ${pending.length === 1 ? "person was" : "people were"} already told a day for their new times. Choose whether they still get them.`, { pending: pending.length });
      newTimesChange = { before, after: { auto: nt.auto, workingDays: nt.workingDays }, pendingChoice: pending.length && nt.pending ? nt.pending : null, stopped: 0 };
      settings.newTimesAfterCancel = { auto: nt.auto, workingDays: nt.workingDays };
      fields.push("newTimesAfterCancel");
      if (nt.pending === "stop") {
        for (const row of pending) {
          await setAutoState(tx, { followUpId: row.id, to: "not_sent", reason: "switched_off", actor, now });
          await cancelNewTimesRuns(tx, container.engine, { companyId: t.companyId, applicationId: row.applicationId, actor, reason: "automatic new times switched off" });
          newTimesChange.stopped += 1;
        }
      }
    }
    if (s.careersPage?.intro !== undefined && (s.careersPage.intro || "") !== (existing.settings.careersPage?.intro ?? "")) {
      settings.careersPage = { enabled: existing.settings.careersPage?.enabled ?? true, ...(s.careersPage.intro ? { intro: s.careersPage.intro } : {}) };
      fields.push("careersPage");
    }
    if (s.businessHours !== undefined && !sameJson(s.businessHours, existing.settings.businessHours ?? null)) {
      if (s.businessHours) settings.businessHours = { days: [...new Set(s.businessHours.days)].sort((a, b) => a - b), start: s.businessHours.start, end: s.businessHours.end }; else delete settings.businessHours;
      fields.push("businessHours");
    }
    let noticeChanges: ReturnType<typeof applyNoticeOverrides>["changed"] = [];
    if (s.notices) {
      const applied = applyNoticeOverrides(existing.settings.notices, s.notices, now);
      if (applied.changed.length) { settings.notices = applied.notices; fields.push("notices"); noticeChanges = applied.changed; }
    }
    if (fields.some((f) => !["name", "timezone", "sizeBand", "locations"].includes(f))) patch.settings = settings;
    // How many automatic sets are still promised a day once this is saved: Setup says what became of them.
    const pendingNewTimes = async () => (await pendingNewTimesRows(tx, t.companyId)).length;
    if (!fields.length) return { row: existing, fields, noticeChanges, pendingNewTimes: await pendingNewTimes() };
    const [updated] = await tx.update(companies).set(patch).where(eq(companies.id, t.companyId)).returning();
    // Handing the boards to ITS gives it a task for every board already waiting on someone; taking them back withdraws
    // ITS's waiting tasks, and Today and the Posting tab show the team what to do instead.
    if (fields.includes("boardPosting")) {
      if (settings.boardPosting === "its") await openMissingTasksAndTell(tx, container, { companyId: t.companyId, actor, now, key: `handed_to_its:${t.companyId}:${now.getTime()}` });
      else await withdrawPostingTasks(tx, { companyId: t.companyId, reason: "The company now posts on the job boards itself.", actor, now });
    }
    // The new times' change is recorded with what it was before, after, the choice for people already told a day and how
    // many were stopped (no personal data).
    const newTimes = newTimesChange ? { newTimesAfterCancel: newTimesChange } : {};
    await audit(tx, { companyId: t.companyId, actor, action: "company.updated", target: { type: "company", id: t.companyId }, reason: "company settings changed", ip: clientIp(c), details: { fields, notices: noticeChanges.map((n) => n.key), ...newTimes } });
    for (const n of noticeChanges) await audit(tx, { companyId: t.companyId, actor, action: "notice.changed", target: { type: "company", id: t.companyId }, reason: n.version ? `reworded ${n.key}` : `standard text restored for ${n.key}`, ip: clientIp(c), details: { key: n.key, version: n.version, previousVersion: n.previousVersion } });
    await emit(tx, { type: "company.updated", companyId: t.companyId, actor, subject: { type: "company", id: t.companyId }, payload: { fields, notices: noticeChanges.map((n) => ({ key: n.key, version: n.version })), ...newTimes } });
    return { row: updated, fields, noticeChanges, pendingNewTimes: await pendingNewTimes() };
  });
  if (removedLogo.key) await container.integrations.storage.delete(removedLogo.key).catch(() => undefined);
  // The ITS queue's email about posting tasks handed over (above) leaves through the outbox.
  if (result.fields.includes("boardPosting")) await container.kick();
  return c.json({ ...result.row, changed: result.fields, notices: noticesView(result.row.settings.notices), pendingNewTimes: result.pendingNewTimes });
});

/**
 * The automatic new times after a candidate cancels (founder decision 3A), for Setup and the Talent page's Cancelled
 * column: on or off, the working days, how many people were already told a day for theirs (Setup asks about them before
 * switching off), and whether ITS has confirmed the company (until then nothing goes automatically). Any member.
 */
companySettingsRoutes.get("/current/new-times", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const view = await withTenant(c.get("container").db, t.companyId, async (tx): Promise<NewTimesSettingView> => {
    const [co] = await tx.select({ settings: companies.settings }).from(companies).where(eq(companies.id, t.companyId)).limit(1);
    if (!co) throw new HttpError(404, "not_found", "Company not found.");
    return { ...newTimesSettingOf(co.settings), pending: (await pendingNewTimesRows(tx, t.companyId)).length, companyConfirmed: isCompanyVerified(co.settings) };
  });
  return c.json(view);
});

/** Every notice with the text in force for this company, the standard text, and whether the company reworded it. */
function noticesView(overrides: Record<string, { version: string; text: string; jurisdictions: string[] }> | undefined) {
  return DEFAULT_NOTICES.map((n) => {
    const o = overrides?.[n.key];
    return { key: n.key, version: o?.version ?? n.version, text: o?.text ?? n.text, jurisdictions: o?.jurisdictions ?? n.jurisdictions, overridden: !!o, defaultText: n.text, defaultVersion: n.version };
  });
}

companySettingsRoutes.get("/current/notices", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const [co] = await withTenant(c.get("container").db, t.companyId, (tx) => tx.select({ settings: companies.settings }).from(companies).where(eq(companies.id, t.companyId)).limit(1));
  return c.json(noticesView(co?.settings.notices));
});

/* ---------------------------------------------------------------------------------------------------------- */
/* What candidates see about the company (plan D10, founder decision Q13): the text about it, drafted by the  */
/* assistant and approved by a person; the logo, stored and served by us; the contact before applying.       */
/* ---------------------------------------------------------------------------------------------------------- */

/** Owners and admins of the company itself; never ITS staff under a grant (what the company says about itself is its own). */
function assertMayEditProfile(c: Context<Vars>): Tenant {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.update");
  if (t.staff) throw new HttpError(403, "forbidden", "Recruiters cannot change what a customer's job pages say about the company.");
  return t;
}

/**
 * Changes the company's settings under a row lock, writes them back whole (an ITS confirmation made meanwhile is kept),
 * and records the change: one audit record and one event naming the fields, never their content.
 */
async function changeProfile(c: Context<Vars>, tx: Tx, companyId: string, reason: string, change: (settings: SettingsWithProfile, ctx: { now: string; actor: Actor; slug: string }) => string[]) {
  const [existing] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1).for("update");
  if (!existing) throw new HttpError(404, "not_found", "Company not found.");
  const actor = actorOf(c);
  const settings: SettingsWithProfile = { ...existing.settings };
  const fields = change(settings, { now: c.get("container").engine.clock().toISOString(), actor, slug: existing.slug });
  if (!fields.length) return existing;
  const [updated] = await tx.update(companies).set({ settings }).where(eq(companies.id, companyId)).returning();
  await audit(tx, { companyId, actor, action: "company.updated", target: { type: "company", id: companyId }, reason, ip: clientIp(c), details: { fields } });
  await emit(tx, { type: "company.updated", companyId, actor, subject: { type: "company", id: companyId }, payload: { fields } });
  return updated;
}

/** What Setup shows under "How candidates see you". Any member may read it. */
companySettingsRoutes.get("/current/public-profile", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const container = c.get("container");
  const [co] = await withTenant(container.db, t.companyId, (tx) => tx.select({ slug: companies.slug, settings: companies.settings }).from(companies).where(eq(companies.id, t.companyId)).limit(1));
  if (!co) throw new HttpError(404, "not_found", "Company not found.");
  return c.json(publicProfileView(co, container.env));
});

/**
 * The assistant drafts a few sentences about the company from what it already told us (and the person's notes, when
 * given). Nothing is shown to candidates: the draft waits in Setup until a person approves it, as written or edited.
 */
companySettingsRoutes.post("/current/about/draft", requireTenant, async (c) => {
  const t = assertMayEditProfile(c);
  const body = AboutDraftRequest.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const actor = actorOf(c);
  const out = await draftAbout(container, { companyId: t.companyId, actor, notes: body.notes || null });
  if (!out.ok) throw new HttpError(502, "about_draft_failed", "The assistant could not write a draft just now. Try again in a minute, or write the text yourself.");
  const row = await withTenant(container.db, t.companyId, (tx) => changeProfile(c, tx, t.companyId, "the assistant drafted the text about the company", (settings, { now }) => {
    settings.aboutDraft = { text: out.output.text, draftedAt: now, draftedBy: actor, aiRunId: out.runId, basedOn: out.output.basedOn };
    return ["aboutDraft"];
  }));
  return c.json(publicProfileView(row, container.env), 201);
});

/**
 * A person approves the text, as the assistant wrote it or as they changed it; from then on it shows on the careers
 * page and every job page. Wording that stands in for a protected trait is refused with the reason and a fairer way to
 * say it. Approving again replaces it.
 */
async function approveAbout(c: Context<Vars>, raw: unknown) {
  const t = assertMayEditProfile(c);
  const body = AboutApproval.parse(raw);
  const problem = aboutWordingProblem(body.text);
  if (problem) throw new HttpError(400, "about_wording", `"${problem.text}": ${problem.reason} ${problem.alternative}`, problem);
  const container = c.get("container");
  const row = await withTenant(container.db, t.companyId, (tx) => changeProfile(c, tx, t.companyId, "approved the text about the company", (settings, { now, actor }) => {
    settings.about = { text: body.text, approvedAt: now, approvedBy: actor, aiAssisted: !!settings.aboutDraft };
    delete settings.aboutDraft;
    return ["about"];
  }));
  return c.json(publicProfileView(row, container.env));
}

/** Takes the text off the careers page and the job pages (and drops a draft). */
async function removeAbout(c: Context<Vars>) {
  const t = assertMayEditProfile(c);
  const container = c.get("container");
  const row = await withTenant(container.db, t.companyId, (tx) => changeProfile(c, tx, t.companyId, "took the text about the company off the job pages", (settings) => {
    const fields = [...(settings.about ? ["about"] : []), ...(settings.aboutDraft ? ["aboutDraft"] : [])];
    delete settings.about;
    delete settings.aboutDraft;
    return fields;
  }));
  return c.json(publicProfileView(row, container.env));
}

companySettingsRoutes.post("/current/about/approve", requireTenant, async (c) => approveAbout(c, await c.req.json()));
companySettingsRoutes.delete("/current/about", requireTenant, removeAbout);
/** The same as one call: `{text}` approves it as written, `{text: null}` takes it off. */
companySettingsRoutes.post("/current/about", requireTenant, async (c) => {
  const raw = (await c.req.json().catch(() => ({}))) as { text?: unknown };
  return raw && typeof raw === "object" && raw.text === null ? removeAbout(c) : approveAbout(c, raw);
});

/** The image as sent: the file itself as the body (with its own type), or a form with a `file` (or `logo`) file field. */
async function logoBytes(c: Context<Vars>): Promise<Uint8Array> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > LOGO_MAX_BYTES + 64 * 1024) throw new HttpError(413, "logo_too_large", "The logo must be under 2 MB. Save it smaller and try again.");
  if ((c.req.header("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    const form = await c.req.parseBody();
    const file = form.file ?? form.logo;
    if (!file || typeof file === "string") throw new HttpError(400, "no_file", "Choose an image file for the logo.");
    return new Uint8Array(await (file as File).arrayBuffer());
  }
  return new Uint8Array(await c.req.arrayBuffer());
}

/**
 * Uploads the logo (plan D10): PNG, JPEG or WebP under 2 MB, judged by its bytes. It is stored in our own bucket under a
 * fresh name and served from our own address (`/careers/:slug/logo/:file`), so the candidate pages keep loading images
 * from nowhere else. `settings.logoUrl` becomes the team's own address of the copy (Setup shows it from there, also
 * before the company is public); the public pages and the structured data build the public address from `settings.logo`.
 * The previous file is removed once the new one is in place.
 */
async function uploadLogo(c: Context<Vars>) {
  const t = assertMayEditProfile(c);
  const bytes = await logoBytes(c);
  const look = inspectLogo(bytes);
  if (!look.ok) throw new HttpError(look.reason === "too_large" ? 413 : 400, `logo_${look.reason}`, look.message);
  const container = c.get("container");
  const file = logoFileName(uuidv7(), look.extension);
  const key = logoKey(t.companyId, file);
  await container.integrations.storage.put(key, bytes, look.mime);
  const replaced: { key: string | null } = { key: null };
  const row = await withTenant(container.db, t.companyId, (tx) => changeProfile(c, tx, t.companyId, "uploaded a logo", (settings, { now, actor }) => {
    replaced.key = settings.logo?.key ?? null;
    settings.logo = { file, key, contentType: look.mime, sizeBytes: bytes.byteLength, width: look.width, height: look.height, uploadedAt: now, uploadedBy: actor };
    settings.logoUrl = logoMemberPath({ file });
    return ["logo"];
  })).catch(async (err) => {
    await container.integrations.storage.delete(key).catch(() => undefined);
    throw err;
  });
  if (replaced.key && replaced.key !== key) await container.integrations.storage.delete(replaced.key).catch(() => undefined);
  return c.json(publicProfileView(row, container.env), 201);
}
companySettingsRoutes.put("/current/logo", requireTenant, uploadLogo);
companySettingsRoutes.post("/current/logo", requireTenant, uploadLogo);

companySettingsRoutes.delete("/current/logo", requireTenant, async (c) => {
  const t = assertMayEditProfile(c);
  const container = c.get("container");
  const removed: { key: string | null } = { key: null };
  const row = await withTenant(container.db, t.companyId, (tx) => changeProfile(c, tx, t.companyId, "removed the logo", (settings) => {
    if (!settings.logo && !settings.logoUrl) return [];
    removed.key = settings.logo?.key ?? null;
    delete settings.logo;
    delete settings.logoUrl;
    return ["logo"];
  }));
  if (removed.key) await container.integrations.storage.delete(removed.key).catch(() => undefined);
  return c.json(publicProfileView(row, container.env));
});

/** The logo for the team (Setup, and the job-page preview before the company is public), to anyone on the team. */
companySettingsRoutes.get("/current/logo", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const container = c.get("container");
  const [co] = await withTenant(container.db, t.companyId, (tx) => tx.select({ settings: companies.settings }).from(companies).where(eq(companies.id, t.companyId)).limit(1));
  const logo = profileOf(co?.settings).logo;
  const bytes = logo ? await container.integrations.storage.get(logo.key) : null;
  if (!logo || !bytes) throw new HttpError(404, "not_found", "There is no logo yet.");
  return logoResponse(bytes, logo.contentType, "private, max-age=300");
});

/**
 * The address candidates may write to before applying, for help or a change to how they apply because of a disability
 * (plan D10). Null goes back to the Identified Talent Solutions inbox that answers for the company.
 */
companySettingsRoutes.put("/current/hiring-contact", requireTenant, async (c) => {
  const t = assertMayEditProfile(c);
  const body = HiringContactInput.parse(await c.req.json());
  const container = c.get("container");
  const row = await withTenant(container.db, t.companyId, (tx) => changeProfile(c, tx, t.companyId, body.email ? "set the contact candidates can reach before applying" : "went back to the ITS contact for candidates", (settings, { now, actor }) => {
    const before = settings.hiringContact;
    if (!body.email) {
      if (!before) return [];
      delete settings.hiringContact;
      return ["hiringContact"];
    }
    const name = body.name?.trim() || null;
    if (before?.email === body.email && before.name === name) return [];
    settings.hiringContact = { email: body.email, name, setAt: now, setBy: actor };
    return ["hiringContact"];
  }));
  return c.json(publicProfileView(row, container.env));
});

/**
 * The getting-started card on Today (plan B2): anyone on the team hides it for themselves ("dismiss"); an owner or
 * admin records that the AI rules were reviewed ("policies_reviewed", audited). Never ITS staff under a grant.
 */
companySettingsRoutes.post("/current/getting-started", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  if (t.staff) throw new HttpError(403, "forbidden", "The getting-started card belongs to the company's own team.");
  const body = GettingStartedRequest.parse(await c.req.json().catch(() => ({})));
  if (body.action === "policies_reviewed") assertCan(t.role, "policy.manage");
  const container = c.get("container");
  const now = container.engine.clock();
  await withTenant(container.db, t.companyId, (tx) => body.action === "dismiss"
    ? dismissGettingStarted(tx, { companyId: t.companyId, userId: t.userId, now })
    : markPoliciesReviewed(tx, { companyId: t.companyId, actor: actorOf(c), now, ip: clientIp(c) ?? undefined }));
  return c.json({ ok: true, action: body.action });
});

/* ---------------------------------------------------------------------------------------------------------- */
/* The customer's own audit history (A9): filters, pagination, and the same rows as a file.                    */
/* ---------------------------------------------------------------------------------------------------------- */

const WHEN = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}(:?\d{2})?)?)?$/;
/** A date (2026-09-01, the whole day) or a time as the rows themselves print it; anything else is a 400 in plain words. */
function parseWhen(value: string | undefined, name: string, endOfDay = false): string | null {
  if (!value) return null;
  const iso = value.length === 10 ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : isoTime(value);
  if (!WHEN.test(value) || Number.isNaN(Date.parse(iso))) throw new HttpError(400, "invalid_request", `"${name}" must be a date like 2026-09-01.`);
  return new Date(iso).toISOString();
}

type AuditQuery = { actions: string[]; from: string | null; to: string | null; before: string | null; limit: number; exclude: string[] };

/** actions= (exact names), prefix= (for example staff.), exclude=, from=, to=, before= (a cursor: the id of the last row seen; rows after it in this order), limit=. */
function auditQueryOf(c: Context<Vars>, maxLimit: number, defaultLimit: number): AuditQuery {
  const list = (v: string | undefined) => (v ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  const prefix = (c.req.query("prefix") ?? "").trim();
  // a list that names only actions the customer may not see is honoured as an empty list, never widened to everything
  const requested = list(c.req.query("actions"));
  let actions = requested.length ? requested.filter((a) => CUSTOMER_AUDIT_ACTIONS.includes(a)) : [...CUSTOMER_AUDIT_ACTIONS];
  if (prefix) actions = actions.filter((a) => a.startsWith(prefix));
  const exclude = list(c.req.query("exclude"));
  actions = actions.filter((a) => !exclude.includes(a));
  const from = parseWhen(c.req.query("from"), "from");
  const to = parseWhen(c.req.query("to"), "to", true);
  const before = (c.req.query("before") ?? "").trim() || null;
  if (before && !UUID.test(before)) throw new HttpError(400, "invalid_request", "\"before\" must be the id of a row from this list.");
  const limit = Math.min(maxLimit, Math.max(1, Number(c.req.query("limit") ?? String(defaultLimit)) || defaultLimit));
  return { actions, from, to, before, limit, exclude };
}

async function customerAudit(c: Context<Vars>, q: AuditQuery) {
  const t = c.get("tenant")!;
  if (t.staff) throw new HttpError(403, "forbidden", "Staff cannot read the customer's audit history.");
  assertCan(t.role, "events.read");
  if (!q.actions.length) return [];
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const where = [eq(auditRecords.companyId, t.companyId), inArray(auditRecords.action, q.actions), ...(q.from ? [gte(auditRecords.createdAt, q.from)] : []), ...(q.to ? [lte(auditRecords.createdAt, q.to)] : [])];
    if (q.before) {
      // The cursor is a row, not a time: rows written in one transaction share created_at to the microsecond, and the
      // time the list prints is rounded to the millisecond, so paging on the time alone would skip siblings. The page
      // continues exactly where the order (created_at, then id, both descending) left off.
      const [cursor] = await tx.select({ id: auditRecords.id, createdAt: auditRecords.createdAt }).from(auditRecords).where(and(eq(auditRecords.companyId, t.companyId), eq(auditRecords.id, q.before))).limit(1);
      if (!cursor) throw new HttpError(400, "invalid_request", "\"before\" must be the id of a row from this list.");
      where.push(or(lt(auditRecords.createdAt, cursor.createdAt), and(eq(auditRecords.createdAt, cursor.createdAt), lt(auditRecords.id, cursor.id)))!);
    }
    return tx.select().from(auditRecords).where(and(...where)).orderBy(desc(auditRecords.createdAt), desc(auditRecords.id)).limit(q.limit);
  });
  return rows.map(customerAuditRow);
}

/**
 * Everything a customer may see of the ledger, newest first: recruiter access, team changes, rule and company changes,
 * candidate views, outcomes and exports. Members with events.read; never ITS staff acting under a grant. Page with
 * `before=<id of the last row>`.
 */
companySettingsRoutes.get("/current/audit", requireTenant, async (c) => c.json(await customerAudit(c, auditQueryOf(c, 200, 50))));

/** The same history as a spreadsheet, up to five thousand rows; the download is itself recorded. */
companySettingsRoutes.get("/current/audit.csv", requireTenant, async (c) => {
  const q = auditQueryOf(c, 5000, 5000);
  const rows = await customerAudit(c, q);
  const t = c.get("tenant")!;
  await withTenant(c.get("container").db, t.companyId, (tx) => audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "audit.exported", target: { type: "company", id: t.companyId }, ip: clientIp(c), details: { rows: rows.length, filters: { actions: q.actions.length === CUSTOMER_AUDIT_ACTIONS.length - q.exclude.length ? "all" : q.actions, from: q.from, to: q.to } } }));
  const day = c.get("container").engine.clock().toISOString().slice(0, 10);
  return c.body(auditCsv(rows), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="activity-${day}.csv"`, "cache-control": "no-store" });
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Sign a member out (A11; audit 01-platform B3): owners and admins only, ranked, this company only, audited.  */
/* ---------------------------------------------------------------------------------------------------------- */

/**
 * Owners and admins sign a teammate out; HR, who otherwise manages the team, does not (the same ranks as a role change
 * in services/team.ts: only an owner touches an owner). Sessions belong to the person, not to a company, so only the
 * sessions working in this company (or in none) are ended (core `revokeSessionsForCompany`): a person who also works in
 * another company keeps their sessions there. The answer says, without telling whether that is the case, that sessions in
 * another company stay open and that removing them from the team is what keeps them out.
 */
companySettingsRoutes.post("/current/members/:userId/sign-out", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "members.manage");
  if (t.staff) throw new HttpError(403, "forbidden", "Recruiters cannot sign a customer's team out.");
  if (t.role !== "owner" && t.role !== "admin") throw new HttpError(403, "admin_only", "Only an owner or an admin can sign a teammate out.");
  const userId = c.req.param("userId") ?? "";
  if (!UUID.test(userId)) throw new HttpError(404, "not_found", "That person is not an active member of your team.");
  if (userId === t.userId) throw new HttpError(400, "self_sign_out", "To sign yourself out everywhere, use \"Sign out everywhere else\" under Your sessions.");
  const container = c.get("container");
  const [member] = await withTenant(container.db, t.companyId, (tx) => tx.select({ id: memberships.id, role: memberships.role }).from(memberships).where(and(eq(memberships.companyId, t.companyId), eq(memberships.userId, userId), eq(memberships.status, "active"))).limit(1));
  if (!member) throw new HttpError(404, "not_found", "That person is not an active member of your team.");
  if (member.role === "owner" && t.role !== "owner") throw new HttpError(403, "owner_only", "Only an owner can sign an owner out.");
  const now = container.engine.clock();
  // sessions are a platform table: the tenant role cannot write them
  const result = await withPlatform(container.db, async (tx) => {
    const r = await revokeSessionsForCompany(tx, userId, t.companyId, { now });
    // Whether the person works for other companies, and how active they are there, is not this company's business: the
    // audit record and the answer say only what happened here.
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "session.revoked", target: { type: "user", id: userId }, reason: "signed out of this company by an owner or admin", ip: clientIp(c), details: { sessionsEnded: r.sessionsEnded, scope: "company" } });
    return r;
  });
  return c.json({ ok: true, userId, sessionsEnded: result.sessionsEnded, message: signOutMessage(result.sessionsEnded) });
});

/**
 * What a sign-out did, in the words the Team card shows. The same words whether or not the person also works for another
 * company, so the answer gives nothing away about other customers.
 */
function signOutMessage(sessionsEnded: number): string {
  const ended = sessionsEnded === 0 ? "They had no session open here." : `Signed out of ${sessionsEnded === 1 ? "one session" : `${sessionsEnded} sessions`} here; they must sign in again to work here.`;
  return `${ended} If they use the same account for another company, their sessions there stay open. To keep them out of this company, remove them from the team.`;
}
