import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { AI_HELP_BUSY_LINE, AI_HELP_LINE, AboutDraftRequest, AboutInput, HiringContactInput, UpdateCompany, type Actor } from "@ros/contracts";
import { outOfCredit } from "@ros/ai";
import { assertCan, audit, emit } from "@ros/core";
import { companies, uuidv7, withTenant, type CompanySettings, type Tx } from "@ros/db";
import { LOGO_MAX_BYTES, inspectLogo, logoFileName, logoKey } from "@ros/integrations";
import { actorOf, clientIp, requireTenant, type Tenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { aiCreditAnswer } from "../services/ai-credit";
import { aboutWordingProblem, companyView, draftAbout, logoMemberPath, logoResponse } from "../services/company-settings-profile";

/**
 * Settings, Company: the details an owner or an admin changes, and what candidates see about the company (the text
 * about it, the logo, the contact before applying). Every change answers the company as Settings reads it
 * (`CompanyView`), is audited with the fields that changed, never their content, and emitted. Mounted under
 * /api/v1/companies next to routes/companies.ts, which keeps the company itself and the team.
 */
export const companySettingsRoutes = new Hono<Vars>();

/** Owners and admins of the company itself. */
function mayEdit(c: Context<Vars>): Tenant {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.update");
  return t;
}

/**
 * Changes the company under its row lock (so a change made elsewhere at the same moment is kept), and records it: one
 * audit record and one event naming the fields. `change` edits the row's copy and answers the fields it changed; with
 * none, nothing is written.
 */
async function changeCompany(c: Context<Vars>, tx: Tx, companyId: string, reason: string, change: (company: typeof companies.$inferSelect, ctx: { now: string; actor: Actor }) => string[]): Promise<void> {
  const [existing] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1).for("update");
  if (!existing) throw new HttpError(404, "not_found", "Company not found.");
  const actor = actorOf(c);
  const next = { ...existing, settings: { ...existing.settings } };
  const fields = change(next, { now: c.get("container").engine.clock().toISOString(), actor });
  if (!fields.length) return;
  await tx.update(companies).set({ name: next.name, timezone: next.timezone, sizeBand: next.sizeBand, locations: next.locations, settings: next.settings }).where(eq(companies.id, companyId));
  await audit(tx, { companyId, actor, action: "company.updated", target: { type: "company", id: companyId }, reason, ip: clientIp(c), details: { fields } });
  await emit(tx, { type: "company.updated", companyId, actor, subject: { type: "company", id: companyId }, payload: { fields } });
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Sets one text of the settings, or takes it off when it is sent empty. True when that changed anything. */
function setText(settings: CompanySettings, key: "website" | "benefitsSummary", value: string | undefined): boolean {
  if (value === undefined || value === (settings[key] ?? "")) return false;
  if (value) settings[key] = value;
  else delete settings[key];
  return true;
}

/**
 * The details owners and admins change themselves: name, website, time zone, size, locations and the benefits line
 * (which the legal check of a job reads when the job has none of its own). Only the fields sent change. Anything else,
 * the plan and the company's standing among it, is refused with the other unknown fields.
 */
companySettingsRoutes.patch("/current", requireTenant, async (c) => {
  const t = mayEdit(c);
  const body = UpdateCompany.parse(await c.req.json().catch(() => { throw new HttpError(400, "invalid_request", "Send the changes as JSON."); }));
  await withTenant(c.get("container").db, t.companyId, (tx) => changeCompany(c, tx, t.companyId, "company details changed", (co) => {
    const fields: string[] = [];
    if (body.name !== undefined && body.name !== co.name) { co.name = body.name; fields.push("name"); }
    if (body.timezone !== undefined && body.timezone !== co.timezone) { co.timezone = body.timezone; fields.push("timezone"); }
    if (body.sizeBand !== undefined && body.sizeBand !== co.sizeBand) { co.sizeBand = body.sizeBand; fields.push("sizeBand"); }
    if (body.locations !== undefined && !sameJson(body.locations, co.locations)) { co.locations = body.locations; fields.push("locations"); }
    if (setText(co.settings, "website", body.website)) fields.push("website");
    if (setText(co.settings, "benefitsSummary", body.benefitsSummary)) fields.push("benefitsSummary");
    return fields;
  }));
  return c.json(await companyView(c.get("container"), t));
});

/**
 * The assistant drafts a few sentences about the company from what it already told us (and the person's notes, when
 * given). Nothing is shown to candidates: the draft waits in Settings until a person approves a text.
 */
companySettingsRoutes.post("/current/about/draft", requireTenant, async (c) => {
  const t = mayEdit(c);
  const body = AboutDraftRequest.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const actor = actorOf(c);
  const out = await draftAbout(container, { companyId: t.companyId, actor, notes: body.notes || null });
  if (outOfCredit(out)) throw await aiCreditAnswer(container, t, out.refusedHoldUsd, { usedUp: AI_HELP_LINE.about, busy: AI_HELP_BUSY_LINE.about });
  if (!out.ok) throw new HttpError(502, "ai_failed", "The assistant could not write a draft just now. Try again in a minute, or write the text yourself.");
  await withTenant(container.db, t.companyId, (tx) => changeCompany(c, tx, t.companyId, "the assistant drafted the text about the company", (co, { now }) => {
    // `basedOn` (the facts the draft rested on) was asked of the model and read by nothing: it is no longer asked for,
    // and the stored shape (CompanySettings in packages/db) keeps the field, empty, until it is taken out there.
    co.settings.aboutDraft = { text: out.output.text, draftedAt: now, draftedBy: actor, aiRunId: out.runId, basedOn: [] };
    return ["aboutDraft"];
  }));
  return c.json(await companyView(container, t), 201);
});

/**
 * A person approves the text, their own or the draft as they left it; from then on it shows on the careers page and
 * every job page. Wording that stands in for a protected trait is refused with the reason and a fairer way to say it.
 * `{ text: null }` takes the text off (and drops a draft).
 */
companySettingsRoutes.post("/current/about", requireTenant, async (c) => {
  const t = mayEdit(c);
  const { text } = AboutInput.parse(await c.req.json().catch(() => ({})));
  const problem = text === null ? null : aboutWordingProblem(text);
  if (problem) throw new HttpError(400, "about_wording", `"${problem.text}": ${problem.reason} ${problem.alternative}`, problem);
  const container = c.get("container");
  await withTenant(container.db, t.companyId, (tx) => changeCompany(c, tx, t.companyId, text === null ? "took the text about the company off the job pages" : "approved the text about the company", (co, { now, actor }) => {
    const fields = [...(text !== null || co.settings.about ? ["about"] : []), ...(co.settings.aboutDraft ? ["aboutDraft"] : [])];
    if (text === null) delete co.settings.about;
    else co.settings.about = { text, approvedAt: now, approvedBy: actor, aiAssisted: !!co.settings.aboutDraft };
    delete co.settings.aboutDraft;
    return fields;
  }));
  return c.json(await companyView(container, t));
});

/**
 * Uploads the logo: a form with a `file` field holding a PNG, JPEG or WebP under 2 MB, judged by its bytes. It is stored
 * in our own bucket under a fresh name and served from our own address (`/careers/:slug/logo/:file`), so the candidate
 * pages keep loading images from nowhere else. The previous file is removed once the new one is in place.
 */
companySettingsRoutes.post("/current/logo", requireTenant, async (c) => {
  const t = mayEdit(c);
  if (Number(c.req.header("content-length") ?? "0") > LOGO_MAX_BYTES + 64 * 1024) throw new HttpError(413, "logo_too_large", "The logo must be under 2 MB. Save it smaller and try again.");
  const file = (await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)).file;
  if (!file || typeof file === "string") throw new HttpError(400, "no_file", "Choose an image file for the logo.");
  const bytes = new Uint8Array(await (file as File).arrayBuffer());
  const look = inspectLogo(bytes);
  if (!look.ok) throw new HttpError(look.reason === "too_large" ? 413 : 400, `logo_${look.reason}`, look.message);
  const container = c.get("container");
  const name = logoFileName(uuidv7(), look.extension);
  const key = logoKey(t.companyId, name);
  await container.integrations.storage.put(key, bytes, look.mime);
  const replaced: { key: string | null } = { key: null };
  await withTenant(container.db, t.companyId, (tx) => changeCompany(c, tx, t.companyId, "uploaded a logo", (co, { now, actor }) => {
    replaced.key = co.settings.logo?.key ?? null;
    co.settings.logo = { file: name, key, contentType: look.mime, sizeBytes: bytes.byteLength, width: look.width, height: look.height, uploadedAt: now, uploadedBy: actor };
    co.settings.logoUrl = logoMemberPath({ file: name });
    return ["logo"];
  })).catch(async (err) => {
    await container.integrations.storage.delete(key).catch(() => undefined);
    throw err;
  });
  if (replaced.key && replaced.key !== key) await container.integrations.storage.delete(replaced.key).catch(() => undefined);
  return c.json(await companyView(container, t), 201);
});

companySettingsRoutes.delete("/current/logo", requireTenant, async (c) => {
  const t = mayEdit(c);
  const container = c.get("container");
  const removed: { key: string | null } = { key: null };
  await withTenant(container.db, t.companyId, (tx) => changeCompany(c, tx, t.companyId, "removed the logo", (co) => {
    if (!co.settings.logo && !co.settings.logoUrl) return [];
    removed.key = co.settings.logo?.key ?? null;
    delete co.settings.logo;
    delete co.settings.logoUrl;
    return ["logo"];
  }));
  if (removed.key) await container.integrations.storage.delete(removed.key).catch(() => undefined);
  return c.json(await companyView(container, t));
});

/** The logo for the team (Settings, and the job-page preview), to anyone on the team. */
companySettingsRoutes.get("/current/logo", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const container = c.get("container");
  const [co] = await withTenant(container.db, t.companyId, (tx) => tx.select({ settings: companies.settings }).from(companies).where(eq(companies.id, t.companyId)).limit(1));
  const logo = co?.settings.logo;
  const bytes = logo ? await container.integrations.storage.get(logo.key) : null;
  if (!logo || !bytes) throw new HttpError(404, "not_found", "There is no logo yet.");
  return logoResponse(bytes, logo.contentType, "private, max-age=300");
});

/**
 * The address candidates may write to before applying, for help or a change to how they apply because of a disability.
 * Null goes back to the Identified Talent Solutions inbox that answers for the company.
 */
companySettingsRoutes.put("/current/hiring-contact", requireTenant, async (c) => {
  const t = mayEdit(c);
  const body = HiringContactInput.parse(await c.req.json());
  const container = c.get("container");
  await withTenant(container.db, t.companyId, (tx) => changeCompany(c, tx, t.companyId, body.email ? "set the contact candidates can reach before applying" : "went back to the ITS contact for candidates", (co, { now, actor }) => {
    const before = co.settings.hiringContact;
    if (!body.email) {
      if (!before) return [];
      delete co.settings.hiringContact;
      return ["hiringContact"];
    }
    const name = body.name?.trim() || null;
    if (before?.email === body.email && before.name === name) return [];
    co.settings.hiringContact = { email: body.email, name, setAt: now, setBy: actor };
    return ["hiringContact"];
  }));
  return c.json(await companyView(container, t));
});
