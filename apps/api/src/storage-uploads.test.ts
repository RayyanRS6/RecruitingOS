import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { MAX_RESUME_BYTES } from "@ros/contracts";
import { anonymizeCandidate, buildCandidateCsp, entitlements } from "@ros/core";
import { applications, auditRecords, candidates, documents, events, withTenant } from "@ros/db";
import { EICAR_TEST_STRING, type FakeMalwareScanner, type MemoryStorageAdapter } from "@ros/integrations";
import { discardUnusedObject, examineQuarantinedDocument, processQuarantinedDocument, recordQuarantineVerdict } from "@ros/workflows";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { NO_SCRIPT_MAX_RESUME_BYTES } from "./pages/candidate";
import { statusTokenFor } from "./test-helpers";

/**
 * Founder decision 2 (22 September 2026): résumés go straight to private storage under short-lived single-object
 * authorizations, sit in quarantine until the worker has checked their bytes and scanned them, move to a random
 * tenant- and candidate-scoped key, are opened by staff only through audited, expiring links, and are removed on
 * deletion. Everything here runs against the in-memory store and the fake scanner, which speak the same contract.
 */
describe("résumé storage: direct upload, quarantine, validation, download, deletion", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let eligibilityKeys: string[] = [];
  const baseEnv = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3001" };
  const storage = () => container.integrations.storage as MemoryStorageAdapter;
  const scanner = () => container.integrations.scanner as FakeMalwareScanner;
  const scanDeps = () => ({ db: container.db, integrations: container.integrations, engine: container.engine });
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  /** The apply budget is thirty an hour per address; later cases post from their own address so the earlier ones do not spend it. */
  const intent = (body: unknown, ip?: string) => app.request(`/careers/${slug}/jobs/${roleId}/upload-intent`, { method: "POST", headers: { "content-type": "application/json", ...(ip ? { "x-forwarded-for": ip } : {}) }, body: JSON.stringify(body) });
  let applicant = 0;
  const apply = async (extra: (fd: FormData) => void, ip?: string) => {
    applicant++;
    const fd = new FormData();
    fd.set("firstName", "Dana"); fd.set("lastName", `Example${applicant}`); fd.set("email", `dana${applicant}@example.com`); fd.set("smsConsent", "no"); fd.set("locationText", "Irvine, CA");
    for (const k of eligibilityKeys) fd.set(`elig_${k}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    extra(fd);
    const r = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd, headers: ip ? { "x-forwarded-for": ip } : undefined });
    const token = r.status === 302 ? await statusTokenFor(container, { roleId, email: String(fd.get("email")) }) : "";
    return { r, token };
  };
  const applicationOf = async (token: string) => (await container.db.select().from(applications).where(eq(applications.statusToken, token)))[0]!;
  const documentOf = async (id: string) => (await container.db.select().from(documents).where(eq(documents.id, id)))[0]!;
  /** Uploads a file the way the browser does: intent, PUT to the granted URL, then the form with the grant. */
  const directUpload = async (file: { name: string; type: string; bytes: Uint8Array }, ip?: string) => {
    const ir = await intent({ filename: file.name, size: file.bytes.byteLength, type: file.type }, ip);
    expect(ir.status).toBe(200);
    const j = (await ir.json()) as { uploadId: string; url: string; method: string; headers: Record<string, string>; grant: string; expiresAt: string; maxBytes: number };
    const put = await app.request(new URL(j.url).pathname, { method: j.method, headers: j.headers, body: asBody(file.bytes) });
    expect(put.status).toBe(200);
    return j;
  };
  const text = (s: string) => new TextEncoder().encode(s);
  /** A request body from bytes, typed the way fetch wants it. */
  const asBody = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;
  const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...new Array(64).fill(0)]);

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: baseEnv });
    app = createApp(container);
    owner = await signIn("owner@storage.test");
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Storage Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    await entitlements.applyPlan(container.db, co.id, "growth");
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's growth. Ceiling $58. I decide. Must-haves: RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" });
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    eligibilityKeys = role.currentPacket.packet.requirements.eligibility.map((r) => r.key);
    await container.drain();
  });
  afterAll(async () => {
    await container.close();
  });

  it("direct upload: the file goes to quarantine, the form carries only a grant, the worker checks, scans, moves and reads it", async () => {
    const j = await directUpload({ name: "Dana Résumé.txt", type: "text/plain", bytes: text("Dana Example\nRegistered dental hygienist, 6 years.\n") });
    const grant = container.uploadGrants.open(j.grant)!;
    expect(grant.key.startsWith(`quarantine/${companyId}/${roleId}/`)).toBe(true);
    expect(storage().has(grant.key)).toBe(true);
    const { r, token } = await apply((fd) => fd.set("uploadGrant", j.grant));
    expect(r.status).toBe(302);
    const appRow = await applicationOf(token);
    // The inline worker runs as the request commits, so the row is already past quarantine here; the trail proves the order.
    await container.drain();
    const doc = await documentOf(appRow.resumeDocumentId!);
    expect(doc).toMatchObject({ status: "clean", uploadedVia: "direct", filename: "Dana Résumé.txt", mime: "text/plain" });
    expect(doc.storageKey.startsWith(`${companyId}/${appRow.candidateId}/${appRow.id}/`)).toBe(true);
    expect(doc.storageKey).toMatch(/\.txt$/);
    expect(doc.storageKey).not.toContain("Résumé");
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.textExtracted).toContain("Registered dental hygienist");
    expect(doc.scanEngine).toBe("fake_scanner");
    expect(doc.scanVerdict).toBe("clean");
    expect(storage().has(grant.key)).toBe(false);
    expect(storage().has(doc.storageKey)).toBe(true);
    const types = (await container.db.select({ type: events.type }).from(events).where(and(eq(events.subjectType, "application"), eq(events.subjectId, appRow.id))).orderBy(events.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["document.uploaded", "document.validated", "resume.ingested"]));
    expect(types.indexOf("document.uploaded")).toBeLessThan(types.indexOf("document.validated"));
    const audits = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "document.uploaded"));
    expect(audits.some((a) => (a.target as { id: string })?.id === doc.id)).toBe(true);
    // The application went on: the intake workflow ran with the extracted text in hand.
    expect((await applicationOf(token)).stage).not.toBe("applied");
  });

  it("a program named as a PDF is refused in quarantine, removed, and recorded; the application continues without it", async () => {
    const j = await directUpload({ name: "cv.pdf", type: "application/pdf", bytes: EXE });
    const key = container.uploadGrants.open(j.grant)!.key;
    const { r, token } = await apply((fd) => fd.set("uploadGrant", j.grant));
    expect(r.status).toBe(302);
    await container.drain();
    const appRow = await applicationOf(token);
    const doc = await documentOf(appRow.resumeDocumentId!);
    expect(doc).toMatchObject({ status: "rejected", rejectedReason: "executable", textExtracted: null });
    expect(storage().has(key)).toBe(false);
    expect(await storage().list(`${companyId}/`)).not.toContain(doc.storageKey);
    const rejected = await container.db.select().from(events).where(and(eq(events.subjectType, "application"), eq(events.subjectId, appRow.id), eq(events.type, "document.rejected")));
    expect(rejected.length).toBe(1);
    expect(JSON.stringify(rejected[0]!.payload)).not.toContain("MZ");
    expect(["eligible", "triaged", "received"]).toContain(appRow.stage);
  });

  it("the EICAR test file is flagged by the scanner and refused", async () => {
    const j = await directUpload({ name: "cv.txt", type: "text/plain", bytes: text(`${EICAR_TEST_STRING}\n`) });
    const { token } = await apply((fd) => fd.set("uploadGrant", j.grant));
    await container.drain();
    const doc = await documentOf((await applicationOf(token)).resumeDocumentId!);
    expect(doc).toMatchObject({ status: "rejected", rejectedReason: "infected", scanVerdict: "infected", scanEngine: "fake_scanner" });
    const a = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "document.rejected"));
    expect(a.some((x) => (x.target as { id: string })?.id === doc.id && x.reason === "infected")).toBe(true);
  });

  it("a scanner outage leaves the file in quarantine, unreadable, for another attempt", async () => {
    scanner().failNext = true;
    const j = await directUpload({ name: "cv.txt", type: "text/plain", bytes: text("Dana Example, RDH") });
    const { token } = await apply((fd) => fd.set("uploadGrant", j.grant));
    await container.drain();
    const appRow = await applicationOf(token);
    const doc = await documentOf(appRow.resumeDocumentId!);
    expect(doc.status).toBe("quarantined");
    expect(doc.textExtracted).toBeNull();
    expect(storage().has(doc.storageKey)).toBe(true);
    const r = await app.request(`/api/v1/applications/${appRow.id}/documents/${doc.id}/file`, { headers: { cookie: owner } });
    expect(r.status).toBe(409);
  });

  it("without script the form still posts the file itself; it is quarantined and processed the same way", async () => {
    const quarantinedBefore = (await storage().list(`quarantine/${companyId}/`)).length;
    const { r, token } = await apply((fd) => fd.set("resume", new File(["Dana Example\nRDH, 6 years"], "dana.txt", { type: "text/plain" })));
    expect(r.status).toBe(302);
    const appRow = await applicationOf(token);
    await container.drain();
    const doc = await documentOf(appRow.resumeDocumentId!);
    expect(doc).toMatchObject({ status: "clean", uploadedVia: "server" });
    expect(doc.storageKey.startsWith(`${companyId}/${appRow.candidateId}/`)).toBe(true);
    expect(doc.textExtracted).toContain("RDH");
    expect((await storage().list(`quarantine/${companyId}/`)).length).toBe(quarantinedBefore);
    // An executable is refused at the door on this path, before anything is stored.
    const bad = await apply((fd) => fd.set("resume", new File([EXE], "cv.pdf", { type: "application/pdf" })));
    expect(bad.r.status).toBe(400);
    expect(await bad.r.text()).toContain("cannot be used");
  });

  it("refuses bad intents, mismatched or oversized puts, and tampered, foreign, expired or unfulfilled grants", async () => {
    expect((await intent({ filename: "cv.pdf", size: 0, type: "application/pdf" })).status).toBe(400);
    expect((await intent({ filename: "cv.pdf", size: 9 * 1024 * 1024, type: "application/pdf" })).status).toBe(400);
    expect((await intent({ filename: "cv.exe", size: 100, type: "application/octet-stream" })).status).toBe(400);
    expect((await intent({ filename: "cv.zip", size: 100, type: "application/zip" })).status).toBe(400);
    expect((await intent("nonsense")).status).toBe(400);
    const ir = await intent({ filename: "cv.pdf", size: 100, type: "application/pdf" });
    const j = (await ir.json()) as { url: string; headers: Record<string, string>; grant: string };
    const path = new URL(j.url).pathname;
    expect((await app.request(path, { method: "PUT", headers: { "content-type": "text/plain" }, body: asBody(text("x")) })).status).toBe(415);
    expect((await app.request(path, { method: "PUT", headers: { "content-type": "application/pdf" }, body: asBody(new Uint8Array(0)) })).status).toBe(400);
    expect((await app.request(path, { method: "PUT", headers: { "content-type": "application/pdf" }, body: asBody(new Uint8Array(8 * 1024 * 1024 + 1)) })).status).toBe(413);
    expect((await app.request(`/files/put/${"x".repeat(40)}.yyy`, { method: "PUT", headers: { "content-type": "application/pdf" }, body: asBody(text("x")) })).status).toBe(403);
    // grant issued but nothing uploaded
    const none = await apply((fd) => fd.set("uploadGrant", j.grant));
    expect(none.r.status).toBe(400);
    expect(await none.r.text()).toContain("did not arrive");
    // tampered grant
    const [body, mac] = j.grant.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), key: `quarantine/${companyId}/${roleId}/other.pdf` })).toString("base64url")}.${mac}`;
    expect((await apply((fd) => fd.set("uploadGrant", forged))).r.status).toBe(400);
    // a grant for another role, and an expired grant, are refused even when the object exists
    const real = container.uploadGrants.open(j.grant)!;
    await storage().put(real.key, text("%PDF-1.4\n%%EOF"), "application/pdf");
    const foreign = container.uploadGrants.seal({ ...real, roleId: "00000000-0000-0000-0000-000000000000" });
    expect((await apply((fd) => fd.set("uploadGrant", foreign))).r.status).toBe(400);
    const expired = container.uploadGrants.seal({ ...real, exp: Math.floor(Date.now() / 1000) - 1 });
    const ex = await apply((fd) => fd.set("uploadGrant", expired));
    expect(ex.r.status).toBe(400);
    expect(await ex.r.text()).toContain("expired");
    await storage().delete(real.key);
  });

  it("staff open a clean file only through an audited, expiring, single-object link scoped to their own company", async () => {
    const j = await directUpload({ name: "dana.txt", type: "text/plain", bytes: text("Dana Example, RDH, Irvine") });
    const { token } = await apply((fd) => fd.set("uploadGrant", j.grant));
    await container.drain();
    const appRow = await applicationOf(token);
    const doc = await documentOf(appRow.resumeDocumentId!);
    expect(doc.status).toBe("clean");
    // the detail route shows status, never the key
    const detail = (await (await json(owner, "GET", `/api/v1/applications/${appRow.id}`)).json()) as { documents: Array<Record<string, unknown>> };
    expect(detail.documents[0]).toMatchObject({ id: doc.id, status: "clean", uploadedVia: "direct" });
    expect(JSON.stringify(detail)).not.toContain(doc.storageKey);
    const r = await app.request(`/api/v1/applications/${appRow.id}/documents/${doc.id}/file`, { headers: { cookie: owner } });
    expect(r.status).toBe(302);
    const location = r.headers.get("location")!;
    expect(location.startsWith("http://localhost:3001/files/get/")).toBe(true);
    const file = await app.request(new URL(location).pathname);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("text/plain");
    expect(file.headers.get("content-disposition")).toBe('attachment; filename="dana.txt"');
    expect(file.headers.get("cache-control")).toBe("private, no-store");
    expect(await file.text()).toContain("Irvine");
    const reads = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "document.read"));
    expect(reads.some((a) => (a.target as { id: string })?.id === doc.id && a.companyId === companyId)).toBe(true);
    // a signed-out request, and a member of another company, get nothing
    expect((await app.request(`/api/v1/applications/${appRow.id}/documents/${doc.id}/file`)).status).toBe(401);
    const other = await signIn("owner@other-storage.test");
    await json(other, "POST", "/api/v1/companies", { name: "Other Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Tustin", region: "CA", country: "US" }] });
    const foreign = await app.request(`/api/v1/applications/${appRow.id}/documents/${doc.id}/file`, { headers: { cookie: other } });
    expect([403, 404]).toContain(foreign.status);
    expect(reads.filter((a) => (a.target as { id: string })?.id === doc.id).length).toBe(1);
    // storage keys never cross tenants: nothing of this company sits outside its prefix
    const all = await storage().list("");
    expect(all.filter((k) => k.includes(appRow.id)).every((k) => k.startsWith(`${companyId}/`))).toBe(true);
  });

  it("anonymization removes the file, records the deletion, and the link stops working", async () => {
    const j = await directUpload({ name: "dana.txt", type: "text/plain", bytes: text("Dana Example, RDH") });
    const { token } = await apply((fd) => fd.set("uploadGrant", j.grant));
    await container.drain();
    const appRow = await applicationOf(token);
    const before = await documentOf(appRow.resumeDocumentId!);
    expect(storage().has(before.storageKey)).toBe(true);
    await anonymizeCandidate(container.db, { companyId, candidateId: appRow.candidateId, actor: { kind: "user", id: "admin" }, deleteFile: (k) => storage().delete(k) });
    const after = await documentOf(before.id);
    expect(after.status).toBe("deleted");
    expect(storage().has(before.storageKey)).toBe(false);
    expect(after.textExtracted).toBeNull();
    const deleted = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "document.deleted"));
    expect(deleted.some((a) => (a.target as { id: string })?.id === before.id)).toBe(true);
    expect((await app.request(`/api/v1/applications/${appRow.id}/documents/${before.id}/file`, { headers: { cookie: owner } })).status).toBe(409);
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, appRow.candidateId));
    expect(cand!.anonymizedAt).toBeTruthy();
  });

  it("a PDF résumé posted by the form itself, and a Word résumé by the direct upload, are read: the text is on the document and the application understands it", async () => {
    const ip = "203.0.113.31";
    const fixtures = (name: string) => new Uint8Array(readFileSync(new URL(`../../../packages/agents/src/fixtures/${name}`, import.meta.url)));
    const typesOf = async (applicationId: string) => (await container.db.select({ type: events.type }).from(events).where(and(eq(events.subjectType, "application"), eq(events.subjectId, applicationId))).orderBy(events.id)).map((e) => e.type);
    // the PDF, through the no-script path (the form carries the file)
    const pdf = await apply((fd) => fd.set("resume", new File([fixtures("resume.pdf")], "Jordan Rivera.pdf", { type: "application/pdf" })), ip);
    expect(pdf.r.status).toBe(302);
    await container.drain();
    const pdfApp = await applicationOf(pdf.token);
    const pdfDoc = await documentOf(pdfApp.resumeDocumentId!);
    expect(pdfDoc).toMatchObject({ status: "clean", uploadedVia: "server", mime: "application/pdf", filename: "Jordan Rivera.pdf" });
    expect(pdfDoc.storageKey).toMatch(/\.pdf$/);
    expect(pdfDoc.textExtracted).toContain("Registered Dental Hygienist at Harbor Point Dental");
    expect(pdfDoc.textExtracted!.split(/\s+/).length).toBeGreaterThanOrEqual(40);
    const pdfTypes = await typesOf(pdfApp.id);
    expect(pdfTypes).toEqual(expect.arrayContaining(["document.uploaded", "document.validated", "resume.ingested"]));
    expect(pdfTypes).not.toContain("resume.extraction_failed");
    expect((pdfApp.extraction as { positions: unknown[] } | null)?.positions.length).toBeGreaterThanOrEqual(1);
    expect(pdfApp.stage).not.toBe("applied");
    // the Word document, through the direct upload
    const j = await directUpload({ name: "resume.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: fixtures("resume.docx") }, ip);
    const docx = await apply((fd) => fd.set("uploadGrant", j.grant), ip);
    expect(docx.r.status).toBe(302);
    await container.drain();
    const docxApp = await applicationOf(docx.token);
    const docxDoc = await documentOf(docxApp.resumeDocumentId!);
    expect(docxDoc).toMatchObject({ status: "clean", uploadedVia: "direct", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    expect(docxDoc.storageKey).toMatch(/\.docx$/);
    expect(docxDoc.textExtracted).toContain("Registered Dental Hygienist at Harbor Point Dental");
    expect(await typesOf(docxApp.id)).toEqual(expect.arrayContaining(["document.validated", "resume.ingested"]));
    // a scanned PDF (no text layer) is kept as a clean file, but the application is told nothing could be read and goes on by its answers
    const scan = await apply((fd) => fd.set("resume", new File([fixtures("scanned.pdf")], "scan.pdf", { type: "application/pdf" })), ip);
    expect(scan.r.status).toBe(302);
    await container.drain();
    const scanApp = await applicationOf(scan.token);
    const scanDoc = await documentOf(scanApp.resumeDocumentId!);
    expect(scanDoc).toMatchObject({ status: "clean", textExtracted: null });
    expect(storage().has(scanDoc.storageKey)).toBe(true);
    const scanTypes = await typesOf(scanApp.id);
    expect(scanTypes).toContain("resume.extraction_failed");
    expect(scanTypes).not.toContain("resume.ingested");
    expect(["eligible", "triaged", "received", "screen_invited"]).toContain(scanApp.stage);
  });

  it("the form itself refuses an oversized file and a wrong-type file with a plain message, keeps what was typed, and stores nothing", async () => {
    const quarantinedBefore = (await storage().list(`quarantine/${companyId}/`)).length;
    const keptBefore = (await storage().list(`${companyId}/`)).length;
    const appsBefore = (await container.db.select({ id: applications.id }).from(applications).where(eq(applications.roleId, roleId))).length;
    const refused = async (file: File) => {
      const { r } = await apply((fd) => fd.set("resume", file), "203.0.113.32");
      expect(r.status).toBe(400);
      const html = await r.text();
      expect(html).toContain('value="Dana"'); // everything typed is still there (D12)
      return html;
    };
    // over the no-script limit but under the storage limit: the direct upload could have taken it
    expect(await refused(new File([new Uint8Array(NO_SCRIPT_MAX_RESUME_BYTES + 1)], "cv.pdf", { type: "application/pdf" }))).toContain("Files over 4 MB can only be sent by the direct upload");
    // over the storage limit altogether
    expect(await refused(new File([new Uint8Array(MAX_RESUME_BYTES + 1)], "cv.pdf", { type: "application/pdf" }))).toContain("Resume files must be under 8 MB.");
    // the wrong kind of file: an archive, an image, a Word document sent as a PDF, an old Word file
    const friendly = "Please upload a PDF, Word (.docx), or text file.";
    expect(await refused(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(200).fill(0)])], "cv.zip", { type: "application/zip" }))).toContain(friendly);
    expect(await refused(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)])], "photo.png", { type: "image/png" }))).toContain(friendly);
    const docxBytes = new Uint8Array(readFileSync(new URL("../../../packages/agents/src/fixtures/resume.docx", import.meta.url)));
    expect(await refused(new File([docxBytes], "cv.pdf", { type: "application/pdf" }))).toContain(friendly);
    expect(await refused(new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(64).fill(0)])], "cv.doc", { type: "application/msword" }))).toContain("cannot be used");
    expect((await storage().list(`quarantine/${companyId}/`)).length).toBe(quarantinedBefore);
    expect((await storage().list(`${companyId}/`)).length).toBe(keptBefore);
    expect((await container.db.select({ id: applications.id }).from(applications).where(eq(applications.roleId, roleId))).length).toBe(appsBefore);
  });

  it("a grant whose object is over the limit is refused and the object removed from quarantine", async () => {
    const ip = "203.0.113.33";
    const ir = await intent({ filename: "cv.pdf", size: 100, type: "application/pdf" }, ip);
    expect(ir.status).toBe(200);
    const j = (await ir.json()) as { grant: string };
    const real = container.uploadGrants.open(j.grant)!;
    // the object grew past the limit after the intent (a client that lied about the size and a store that did not enforce it)
    await storage().put(real.key, new Uint8Array(MAX_RESUME_BYTES + 1), "application/pdf");
    expect(storage().has(real.key)).toBe(true);
    const { r } = await apply((fd) => fd.set("uploadGrant", j.grant), ip);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("Resume files must be under 8 MB.");
    expect(storage().has(real.key)).toBe(false);
  });

  it("the worker refuses a quarantined file over the limit: removed, recorded without its contents, and the application goes on without it", async () => {
    // a quarantined row the API could never have produced at this size (it caps before storing), as an inbound attachment might
    const { r, token } = await apply((fd) => fd.set("resume", new File(["Dana Example, RDH"], "dana.txt", { type: "text/plain" })), "203.0.113.34");
    expect(r.status).toBe(302);
    await container.drain();
    const appRow = await applicationOf(token);
    const key = `quarantine/${companyId}/${roleId}/oversized-test.pdf`;
    await storage().put(key, new Uint8Array(MAX_RESUME_BYTES + 1), "application/pdf");
    const doc = await withTenant(container.db, companyId, async (tx) => (await tx.insert(documents).values({ companyId, candidateId: appRow.candidateId, applicationId: appRow.id, kind: "resume", filename: "oversized.pdf", mime: "application/pdf", sizeBytes: MAX_RESUME_BYTES + 1, storageKey: key, sha256: "pending", status: "quarantined", uploadedVia: "email" }).returning())[0]);
    const outcome = await processQuarantinedDocument(scanDeps(), { documentId: doc.id, companyId, actor: { kind: "system", id: "test" } });
    expect(outcome).toEqual({ outcome: "rejected", documentId: doc.id, reason: "too_large" });
    const after = await documentOf(doc.id);
    expect(after).toMatchObject({ status: "rejected", rejectedReason: "too_large", textExtracted: null, sha256: "rejected" });
    expect(storage().has(key)).toBe(false);
    const rejected = await container.db.select().from(events).where(and(eq(events.subjectType, "application"), eq(events.subjectId, appRow.id), eq(events.type, "document.rejected")));
    expect(rejected).toHaveLength(1);
    expect(rejected[0].payload).toMatchObject({ documentId: doc.id, reason: "too_large", via: "email" });
    const audits = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "document.rejected"));
    expect(audits.some((a) => (a.target as { id: string })?.id === doc.id && a.reason === "too_large")).toBe(true);
    // a second pass changes nothing: the row is no longer quarantined
    expect(await processQuarantinedDocument(scanDeps(), { documentId: doc.id, companyId, actor: { kind: "system", id: "test" } })).toEqual({ outcome: "skipped", documentId: doc.id });
    // the application itself is untouched by the stray document
    expect((await applicationOf(token)).resumeDocumentId).not.toBe(doc.id);
  });

  it("the apply page carries the upload script under the request nonce, and the policy names the store only when it is another origin", async () => {
    const page = await app.request(`/careers/${slug}/jobs/${roleId}/apply`);
    const html = await page.text();
    const csp = page.headers.get("content-security-policy-report-only") ?? page.headers.get("content-security-policy")!;
    const nonce = csp.match(/script-src 'nonce-([^']+)'/)![1]!;
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain('data-upload-intent="/careers/');
    expect(html).toContain('name="uploadGrant"');
    expect(csp).toContain("connect-src 'self';");
    expect(buildCandidateCsp({ nonce: "n", production: true, connectOrigins: ["https://abc.storage.supabase.co"] })).toContain("connect-src 'self' https://abc.storage.supabase.co;");
  });

  it("the scan and the clean copy happen before the verdict's transaction; a verdict that never commits leaves the file in quarantine, the next pass takes it, and the unused copy is swept", async () => {
    const { r, token } = await apply((fd) => fd.set("resume", new File(["Dana Example, RDH"], "dana.txt", { type: "text/plain" })), "203.0.113.35");
    expect(r.status).toBe(302);
    await container.drain();
    const appRow = await applicationOf(token);
    const key = `quarantine/${companyId}/${roleId}/rollback-test.txt`;
    await storage().put(key, text("Dana Example\nRegistered dental hygienist, 6 years.\n"), "text/plain");
    const doc = await withTenant(container.db, companyId, async (tx) => (await tx.insert(documents).values({ companyId, candidateId: appRow.candidateId, applicationId: appRow.id, kind: "resume", filename: "dana.txt", mime: "text/plain", sizeBytes: 50, storageKey: key, sha256: "pending", status: "quarantined", uploadedVia: "email" }).returning())[0]);
    // phase one: scanned and copied, with no transaction open; the row and the quarantine file are untouched
    const first = await examineQuarantinedDocument(scanDeps(), { documentId: doc.id, companyId });
    expect(first).toMatchObject({ verdict: "clean", documentId: doc.id, storageKey: key });
    const firstCopy = (first as { finalKey: string }).finalKey;
    expect(storage().has(firstCopy)).toBe(true);
    expect(storage().has(key)).toBe(true);
    expect(await documentOf(doc.id)).toMatchObject({ status: "quarantined", storageKey: key });
    // phase two rolls back (the commit fails, the worker dies): the row still points at a file that is still there
    await expect(withTenant(container.db, companyId, async (tx) => {
      await recordQuarantineVerdict(tx, first, { companyId, actor: { kind: "system", id: "test" } });
      throw new Error("the commit failed");
    })).rejects.toThrow("the commit failed");
    expect(await documentOf(doc.id)).toMatchObject({ status: "quarantined", storageKey: key, textExtracted: null });
    expect(storage().has(key)).toBe(true);
    // the next pass finds the file and records it clean; the quarantine copy goes only after that commit
    expect(await processQuarantinedDocument(scanDeps(), { documentId: doc.id, companyId, actor: { kind: "system", id: "test" } })).toMatchObject({ outcome: "clean", documentId: doc.id });
    const after = await documentOf(doc.id);
    expect(after).toMatchObject({ status: "clean", scanVerdict: "clean" });
    expect(after.textExtracted).toContain("Registered dental hygienist");
    expect(after.storageKey).not.toBe(firstCopy);
    expect(storage().has(after.storageKey)).toBe(true);
    expect(storage().has(key)).toBe(false);
    // a verdict written for a row that already moved on changes nothing and hands back its own copy for removal
    expect(await withTenant(container.db, companyId, (tx) => recordQuarantineVerdict(tx, first, { companyId, actor: { kind: "system", id: "test" } }))).toEqual({ outcome: { outcome: "skipped", documentId: doc.id }, discard: [firstCopy] });
    // the copy from the attempt that never committed is removed by the sweep an hour later; the copy in use stays
    expect(storage().has(firstCopy)).toBe(true);
    const engine = container.engine as unknown as { now: () => Date };
    const realNow = engine.now;
    engine.now = () => new Date(Date.now() + 2 * 3600_000);
    try {
      await container.drain();
    } finally {
      engine.now = realNow;
    }
    expect(storage().has(firstCopy)).toBe(false);
    expect(storage().has(after.storageKey)).toBe(true);
    // the sweep never touches an object a live row uses, nor another company's
    await discardUnusedObject(container.db, storage(), { companyId, key: after.storageKey });
    expect(storage().has(after.storageKey)).toBe(true);
    await discardUnusedObject(container.db, storage(), { companyId: "00000000-0000-0000-0000-000000000000", key: after.storageKey });
    expect(storage().has(after.storageKey)).toBe(true);
  });
});
