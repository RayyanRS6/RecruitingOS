import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FakeHandler, StructuredRequest } from "@ros/ai";
import type { LearnedFact, RolePacket } from "@ros/contracts";
import { KEPT_FACTS_MAX, chatFactsOf, chatFactsWithKept, chatGaps, chatOpening, keptFactLines } from "@ros/agents";
import { entitlements } from "@ros/core";
import { applications, candidates } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { changeLearnedFact, factsToKeep, reuseToken } from "./services/profile-facts";
import { useOneVisitApplyFlow } from "./test-helpers";

/**
 * Wave S8, slice B (spec-s8-followups.md): the profile learns, and the next application starts with it. A form opened
 * from the emailed reuse link lists the facts the candidate's earlier chats at the company taught their record, each
 * ticked; what is still ticked at Send is kept on the new application and read by its chat as their own words. Only ids
 * come from the form, the address typed must be the one on file, and without the link nothing earlier is shown or used.
 * The résumé reading never learns that an earlier application existed (D-04 C).
 */

describe("kept facts as the chat reads them (pure)", () => {
  it("are the candidate's own words, with nothing about an earlier chat, job or application", () => {
    const lines = keptFactLines([{ text: "I renewed my CA RDH license in March and it runs to 2028." }]);
    expect(lines).toEqual(["Their own words about their work: I renewed my CA RDH license in March and it runs to 2028."]);
    expect(lines.join(" ")).not.toMatch(/earlier|chat|applied|application|from your/i);
  });

  it("keep their place among the chat's facts, after the CV's lines, within the limit", () => {
    const cv = Array.from({ length: 20 }, (_, i) => `Position ${i + 1}`);
    const kept = Array.from({ length: KEPT_FACTS_MAX + 3 }, (_, i) => ({ text: `I did thing number ${i + 1} at work.` }));
    const out = chatFactsWithKept({ cv, formAnswers: ["Do you hold an active CA RDH license? Yes."] }, kept);
    expect(out.cv).toHaveLength(20);
    expect(out.cv.slice(0, 20 - KEPT_FACTS_MAX)).toEqual(cv.slice(0, 20 - KEPT_FACTS_MAX));
    expect(out.cv.filter((l) => l.startsWith("Their own words"))).toHaveLength(KEPT_FACTS_MAX);
    expect(out.formAnswers).toEqual(["Do you hold an active CA RDH license? Yes."]);
    // nothing kept: the facts exactly as they were
    const same = { cv: ["Position 1"], formAnswers: [] };
    expect(chatFactsWithKept(same, [])).toBe(same);
  });

  it("settle what they cover, so the chat does not ask it again, and are never named as a résumé line", () => {
    const packet = { requirements: { mustHaves: [{ key: "nitrous", text: "Nitrous oxide sedation monitoring permit", rationale: "r", evidencedBy: ["resume", "screen"] }] } } as unknown as RolePacket;
    const cvOnly = { cv: ["Dental hygienist at Coastal Dental (2019 to now)"], formAnswers: [] };
    expect(chatGaps({ packet, progress: {}, triageMet: null, facts: cvOnly, written: [] })).toEqual(["nitrous"]);
    const withKept = chatFactsWithKept(cvOnly, [{ text: "I hold a nitrous oxide sedation monitoring permit since 2021." }]);
    expect(chatGaps({ packet, progress: {}, triageMet: null, facts: withKept, written: [] })).toEqual([]);
    const opening = chatOpening({ firstName: "Maria", cv: keptFactLines([{ text: "I drive my own car and live ten minutes away." }]), question: "What can you tell me about it?" });
    expect(opening).not.toContain("Your resume shows");
    expect(opening).not.toContain("Their own words");
  });
});

describe("a form opened from the reuse link: the earlier facts, kept or unticked", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  const roles: Record<"a" | "b" | "c", { id: string; packet: RolePacket }> = {} as never;
  let mariaId = "";
  let mariaFirstApp = "";
  // a distinctive job title for the chat the facts came from: it must never reach the résumé reading
  const EARLIER_TITLE = "Robotics Trainer Spring Cohort";
  const at = "2026-10-01T17:00:00.000Z";
  const fact = (id: string, text: string, kind: LearnedFact["kind"], applicationId: string): LearnedFact => ({ id, kind, text, quote: text, from: { applicationId, screenId: null, roleTitle: EARLIER_TITLE, at } });
  const LICENSE = "I renewed my CA RDH license in March and it runs to 2028.";
  const CAR = "I drive my own car and live ten minutes away.";
  const TRAINED = "I trained two new hygienists on perio charting in Dentrix.";
  const OMAR = "I ran the front desk at a busy orthodontic office.";
  const env = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", SMS_PROVIDER: "fake", SMS_ENABLED: "false", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", JOBS_BASE_URL: "https://jobs.example.test" };
  const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body ? JSON.stringify(body) : undefined });
  let ip = 20;
  const sent: Array<{ system: string; messages: string }> = [];

  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(devLink).searchParams.get("token") }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const openRole = async (message: string) => {
    const s = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: message })).json()) as { session: { id: string } };
    const id = ((await (await json("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json("POST", `/api/v1/roles/${id}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const role = (await (await json("GET", `/api/v1/roles/${id}`)).json()) as { currentPacket: { packet: RolePacket } };
    return { id, packet: role.currentPacket.packet };
  };
  /** The form as a browser without script sends it: every eligibility question answered so it passes, the notice ticked. */
  const applyForm = (role: { id: string; packet: RolePacket }, person: { first: string; last: string; email: string }, extra: { reuse?: string; keep?: string[]; acknowledged?: boolean; resume?: File } = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ firstName: person.first, lastName: person.last, email: person.email, locationText: "Tustin, CA", nr_recentWork: "Dental hygienist at Coastal Family Dentistry for six years.", noticeVersionsShown: "ai_use@2026-09-01,privacy@2026-09-01" })) fd.set(k, v);
    if (extra.acknowledged !== false) fd.set("acknowledged", "yes");
    for (const r of role.packet.requirements.eligibility) {
      const days = (r.expectation as { days?: unknown }).days;
      if (Array.isArray(days) && days.length) for (const d of days) fd.append(`elig_${r.key}`, String(d));
      else fd.set(`elig_${r.key}`, "yes");
    }
    if (extra.reuse !== undefined) fd.set("reuse", extra.reuse);
    for (const id of extra.keep ?? []) fd.append("keep", id);
    if (extra.resume) fd.set("resume", extra.resume);
    return { fd, path: `/careers/${slug}/jobs/${role.id}/apply` };
  };
  const post = (path: string, fd: FormData) => app.request(path, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${ip++}` } });
  const applicationOf = async (roleId: string, email: string) => {
    const [cand] = await container.db.select().from(candidates).where(and(eq(candidates.companyId, companyId), eq(candidates.email, email)));
    return cand ? (await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id))))[0] : undefined;
  };
  /** What the chat that follows the form reads: a known person's detached chat, or a new person's own. */
  /**
   * What the AI interview of the application this address made for the role reads (20 Oct 2026): the application's own
   * facts (`chatFactsOf`), since the interview is made after the résumé is read and never from what a visit typed.
   */
  const chatFactsAfter = async (role: { id: string; packet: RolePacket }, email: string) => {
    await container.drain();
    const a = await applicationOf(role.id, email);
    return a ? chatFactsOf(role.packet, a) : undefined;
  };
  const tokenFor = (roleId: string, over: { companyId?: string; candidateId?: string } = {}) => reuseToken(container.env.SESSION_SECRET, { companyId: over.companyId ?? companyId, candidateId: over.candidateId ?? mariaId, roleId }, container.engine.clock(), 72);

  beforeAll(async () => {
    container = await createContainer({ memory: true, env });
    app = createApp(container);
    owner = await signIn("owner@kept.test");
    const co = (await (await json("POST", "/api/v1/companies", { name: "Kept Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    await useOneVisitApplyFlow(container, companyId);
    roles.a = await openRole("I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.");
    roles.b = await openRole("I need a front desk coordinator in Irvine, $22 to $26 an hour, full time. It's growth. Ceiling $27. I decide. Must-haves: Dentrix scheduling. Just draft it.");
    roles.c = await openRole("I need a dental assistant in Irvine, $24 to $30 an hour, full time. It's growth. Ceiling $32. I decide. Must-haves: x-ray certificate. Just draft it.");
    // Maria applied before, and her sent chat taught her record three things; Omar, another applicant, one
    for (const person of [{ first: "Maria", last: "Reyes", email: "maria.reyes@example.com" }, { first: "Omar", last: "Haddad", email: "omar.haddad@example.com" }]) {
      const { fd, path } = applyForm(roles.a, person);
      expect((await post(path, fd)).status).toBe(302);
    }
    await container.drain();
    const maria = (await applicationOf(roles.a.id, "maria.reyes@example.com"))!;
    const omar = (await applicationOf(roles.a.id, "omar.haddad@example.com"))!;
    mariaId = maria.candidateId;
    mariaFirstApp = maria.id;
    await container.db.update(applications).set({ answers: { ...maria.answers, learned: [fact("lf_kept_license", LICENSE, "skill", maria.id), fact("lf_kept_car", CAR, "logistics", maria.id), fact("lf_kept_trained", TRAINED, "experience", maria.id)] } }).where(eq(applications.id, maria.id));
    await container.db.update(applications).set({ answers: { ...omar.answers, learned: [fact("lf_omar_desk", OMAR, "experience", omar.id)] } }).where(eq(applications.id, omar.id));
    // every résumé reading's request from here on, as the model would receive it
    const fake = container.fake!;
    const reading = (fake as unknown as { handlers: Map<string, FakeHandler> }).handlers.get("triage.assess")!;
    fake.register("triage.assess", (req: StructuredRequest<unknown>) => {
      sent.push({ system: req.system.map((b) => b.text).join("\n"), messages: req.messages.map((m) => m.content).join("\n") });
      return reading(req);
    });
  });
  afterAll(async () => {
    await container.close();
  });

  it("lists each earlier fact with where it came from, every one ticked, inside the form; without the link, nothing", async () => {
    const res = await app.request(`/careers/${slug}/jobs/${roles.b.id}/apply?reuse=${encodeURIComponent(tokenFor(roles.b.id))}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = decode(await res.text());
    expect(html).toContain("<legend>From your earlier chats at Kept Dental</legend>");
    expect(html).toContain('<p class="meta" id="earlier-note">Untick anything that is no longer true. Kept Dental sees what you keep as part of this application.</p>');
    for (const [id, text] of [["lf_kept_license", LICENSE], ["lf_kept_car", CAR], ["lf_kept_trained", TRAINED]]) {
      expect(html).toContain(`<input id="keep-${id}" type="checkbox" name="keep" value="${id}" checked=""/><span>${text}<small>From your chat on ${EARLIER_TITLE}, Oct 1, 2026</small></span>`);
    }
    // inside the application form itself, with the link it was opened from: it works without script
    const form = html.slice(html.indexOf(`<form method="post" action="/careers/${slug}/jobs/${roles.b.id}/apply"`));
    expect(form).toContain('<input type="hidden" name="reuse" value="');
    expect(form).toContain('name="keep" value="lf_kept_license"');
    // nobody else's facts, and no "Applied here before?" fold on a form that came from it
    expect(html).not.toContain(OMAR);
    expect(html).not.toContain(`action="/careers/${slug}/jobs/${roles.b.id}/apply/reuse"`);
    // the details are filled in as before; the person's id never reaches the page
    expect(html).toContain('value="maria.reyes@example.com"');
    expect(html).not.toContain(mariaId);

    // without the link, another job's link, another company's link: nothing earlier on the page
    const plain = decode(await (await app.request(`/careers/${slug}/jobs/${roles.b.id}/apply`)).text());
    const otherJob = decode(await (await app.request(`/careers/${slug}/jobs/${roles.b.id}/apply?reuse=${encodeURIComponent(tokenFor(roles.c.id))}`)).text());
    const otherCompany = decode(await (await app.request(`/careers/${slug}/jobs/${roles.b.id}/apply?reuse=${encodeURIComponent(tokenFor(roles.b.id, { companyId: "00000000-0000-0000-0000-000000000000" }))}`)).text());
    for (const page of [plain, otherJob, otherCompany]) {
      expect(page).not.toContain("From your earlier chats");
      expect(page).not.toContain(LICENSE);
      expect(page).not.toContain('name="reuse"');
      expect(page).not.toContain("maria.reyes@example.com");
    }
    expect(plain).toContain(`action="/careers/${slug}/jobs/${roles.b.id}/apply/reuse"`);
  });

  it("keeps only ticked ids that are hers, read again through the link, and only when the address typed is the one on file", async () => {
    const token = tokenFor(roles.b.id);
    const keep = (over: Partial<Parameters<typeof factsToKeep>[1]>) => factsToKeep(container, { companyId, roleId: roles.b.id, token, typedEmail: "maria.reyes@example.com", ids: ["lf_kept_license"], ...over });
    expect(await keep({})).toMatchObject({ candidateId: mariaId, facts: [{ id: "lf_kept_license", text: LICENSE }] });
    // the address on file however it is typed (the one matching rule)
    expect((await keep({ typedEmail: " Maria.Reyes@Example.com " }))?.facts.map((f) => f.id)).toEqual(["lf_kept_license"]);
    // a forged id, another candidate's fact, words instead of an id: nothing
    expect(await keep({ ids: ["lf_forged"] })).toBeNull();
    expect(await keep({ ids: ["lf_omar_desk"] })).toBeNull();
    expect(await keep({ ids: [LICENSE] })).toBeNull();
    expect((await keep({ ids: ["lf_omar_desk", "lf_forged", "lf_kept_car"] }))?.facts.map((f) => f.text)).toEqual([CAR]);
    // another address, no ids, no link, another job's or company's link, a changed link: nothing
    expect(await keep({ typedEmail: "someone.else@example.com" })).toBeNull();
    expect(await keep({ typedEmail: "not an address" })).toBeNull();
    expect(await keep({ ids: [] })).toBeNull();
    expect(await keep({ token: "" })).toBeNull();
    expect(await keep({ token: tokenFor(roles.c.id) })).toBeNull();
    expect(await keep({ token: tokenFor(roles.b.id, { companyId: "00000000-0000-0000-0000-000000000000" }) })).toBeNull();
    expect(await keep({ token: `${token.slice(0, -3)}abc` })).toBeNull();
    // a link for another person: their facts, never Maria's, and only with their own address
    const omarId = (await applicationOf(roles.a.id, "omar.haddad@example.com"))!.candidateId;
    expect(await keep({ token: tokenFor(roles.b.id, { candidateId: omarId }), ids: ["lf_kept_license"] })).toBeNull();
    expect(await keep({ token: tokenFor(roles.b.id, { candidateId: omarId }), ids: ["lf_omar_desk"] })).toBeNull();
    expect((await keep({ token: tokenFor(roles.b.id, { candidateId: omarId }), ids: ["lf_omar_desk"], typedEmail: "omar.haddad@example.com" }))?.facts.map((f) => f.text)).toEqual([OMAR]);
  });

  it("a form sent back, or read first, lists them again as they were ticked, the link still with it", async () => {
    const token = tokenFor(roles.c.id);
    // the notice box left unticked: the form comes back, only the car still ticked
    const { fd, path } = applyForm(roles.c, { first: "Maria", last: "Reyes", email: "maria.reyes@example.com" }, { reuse: token, keep: ["lf_kept_car"], acknowledged: false });
    const back = await post(path, fd);
    expect(back.status).toBe(400);
    expect(back.headers.get("cache-control")).toBe("no-store");
    const html = decode(await back.text());
    expect(html).toContain("<legend>From your earlier chats at Kept Dental</legend>");
    expect(html).toContain('<input id="keep-lf_kept_car" type="checkbox" name="keep" value="lf_kept_car" checked=""/>');
    expect(html).toContain('<input id="keep-lf_kept_license" type="checkbox" name="keep" value="lf_kept_license"/>');
    expect(html).toContain(`<input type="hidden" name="reuse" value="${token}"/>`);
    expect(await applicationOf(roles.c.id, "maria.reyes@example.com")).toBeUndefined();
    // "Read my resume" on that form: the details come back checked, the earlier facts as they were
    const read = applyForm(roles.c, { first: "", last: "", email: "" }, { reuse: token, keep: ["lf_kept_trained"], resume: new File(["Maria Reyes\nmaria.reyes@example.com\nDental assistant at Coastal Dental 2019 - present\nX-ray certificate\n"], "maria.txt", { type: "text/plain" }) });
    const checked = decode(await (await post(`${read.path}/read`, read.fd)).text());
    expect(checked).toContain('<h2 id="details-title">Check your details</h2>');
    expect(checked).toContain('<input id="keep-lf_kept_trained" type="checkbox" name="keep" value="lf_kept_trained" checked=""/>');
    expect(checked).toContain('<input id="keep-lf_kept_car" type="checkbox" name="keep" value="lf_kept_car"/>');
    // a forged link carried by a posted form lists nothing
    const forged = applyForm(roles.c, { first: "Maria", last: "Reyes", email: "maria.reyes@example.com" }, { reuse: `${token.slice(0, -3)}abc`, keep: ["lf_kept_car"], acknowledged: false });
    const none = decode(await (await post(forged.path, forged.fd)).text());
    expect(none).not.toContain("From your earlier chats");
    expect(none).not.toContain(CAR);
  });

  it("Send keeps the ticked facts on the new application in the record's words, the chat reads them as hers, and the résumé reading learns nothing of the earlier application", async () => {
    sent.length = 0;
    // the car is unticked; Omar's fact, a forged id and words in place of an id ride along and are ignored
    const { fd, path } = applyForm(roles.b, { first: "Maria", last: "Reyes", email: "Maria.Reyes@Example.com" }, { reuse: tokenFor(roles.b.id), keep: ["lf_kept_license", "lf_kept_trained", "lf_omar_desk", "lf_forged", "I run the whole clinic."] });
    const res = await post(path, fd);
    expect(res.status).toBe(302);
    // she is known here (an earlier application): only "check your email", never the link on the page (R20-12)
    expect(res.headers.get("location")).toBe(`/careers/${slug}/jobs/${roles.b.id}/applied`);
    const facts = await chatFactsAfter(roles.b, "maria.reyes@example.com");
    await container.drain();
    const a = (await applicationOf(roles.b.id, "maria.reyes@example.com"))!;
    expect(a.candidateId).toBe(mariaId);
    // in the record's order (newest first) and the record's words, whatever the form sent
    expect(a.answers.kept?.map((k) => [k.id, k.text])).toEqual([["lf_kept_license", LICENSE], ["lf_kept_trained", TRAINED]]);
    for (const k of a.answers.kept ?? []) expect(k).toMatchObject({ from: { applicationId: mariaFirstApp, roleTitle: EARLIER_TITLE }, keptAt: expect.any(String) });
    expect(JSON.stringify(a.answers)).not.toMatch(/drive my own car|orthodontic|whole clinic|lf_forged/);
    // the team sees what she kept, as the form told her: her words only, not the chat or job they came from
    const detail = (await (await json("GET", `/api/v1/applications/${a.id}`)).json()) as { keptFacts: Array<{ id: string; text: string; keptAt: string; editedAt: string | null }> };
    expect(detail.keptFacts.map((k) => [k.id, k.text, k.editedAt])).toEqual([["lf_kept_license", LICENSE, null], ["lf_kept_trained", TRAINED, null]]);
    expect(JSON.stringify(detail.keptFacts)).not.toMatch(new RegExp(`${EARLIER_TITLE}|${mariaFirstApp}`));
    // the chat that follows reads them as her own words, and not the unticked one
    expect(facts?.cv).toEqual(expect.arrayContaining([`Their own words about their work: ${LICENSE}`, `Their own words about their work: ${TRAINED}`]));
    expect(JSON.stringify(facts)).not.toMatch(/drive my own car|orthodontic|whole clinic/);
    expect(JSON.stringify(facts)).not.toContain(EARLIER_TITLE);
    // a chat whose link is emailed later reads them from the application, as the chat in the visit does
    const later = chatFactsOf(roles.b.packet, a);
    expect(later.cv.filter((l) => l.startsWith("Their own words about their work: I "))).toEqual([`Their own words about their work: ${LICENSE}`, `Their own words about their work: ${TRAINED}`]);
    expect(JSON.stringify(later)).not.toMatch(new RegExp(`drive my own car|${EARLIER_TITLE}`));
    // D-04 C: the résumé reading of this application never hears of the earlier one, its job or the chat it came from
    expect(sent.length).toBeGreaterThan(0);
    for (const { system, messages } of sent) {
      expect(`${system}\n${messages}`).not.toContain(EARLIER_TITLE);
      expect(messages).not.toContain(mariaFirstApp);
      expect(messages).not.toMatch(/From your chat|earlier chat|earlier application|keptAt|lf_kept_|prior_applications/i);
    }
  });

  it("with another address typed, or without the link, nothing earlier is kept or reaches the chat", async () => {
    // the link, but someone else's address: a new person, nothing of Maria's
    const other = applyForm(roles.c, { first: "Sam", last: "Other", email: "sam.other@example.com" }, { reuse: tokenFor(roles.c.id), keep: ["lf_kept_license", "lf_kept_car"] });
    const r1 = await post(other.path, other.fd);
    expect(r1.status).toBe(302);
    const f1 = await chatFactsAfter(roles.c, "sam.other@example.com");
    await container.drain();
    const sam = (await applicationOf(roles.c.id, "sam.other@example.com"))!;
    expect(sam.candidateId).not.toBe(mariaId);
    expect(sam.answers.kept).toBeUndefined();
    expect(((await (await json("GET", `/api/v1/applications/${sam.id}`)).json()) as { keptFacts: unknown[] }).keptFacts).toEqual([]);
    expect(f1?.cv.length).toBeGreaterThan(0);
    expect(JSON.stringify(f1)).not.toMatch(/CA RDH license in March|drive my own car/);
    // Maria's own address without the link (ids posted anyway): nothing earlier is kept, and the chat reads only what she typed
    const plain = applyForm(roles.c, { first: "Maria", last: "Reyes", email: "maria.reyes@example.com" }, { keep: ["lf_kept_license"] });
    const r2 = await post(plain.path, plain.fd);
    expect(r2.status).toBe(302);
    const f2 = await chatFactsAfter(roles.c, "maria.reyes@example.com");
    await container.drain();
    const mine = (await applicationOf(roles.c.id, "maria.reyes@example.com"))!;
    expect(mine.answers.kept).toBeUndefined();
    expect(f2?.cv.length).toBeGreaterThan(0);
    expect(f2?.cv.every((l) => l.includes("Coastal Family Dentistry"))).toBe(true);
    expect(JSON.stringify(f2)).not.toMatch(/CA RDH license in March|trained two|drive my own car/);
    expect(JSON.stringify(f2)).not.toContain(EARLIER_TITLE);
  });

  it("a change on her record changes the kept copy too, a removal takes it out, and a repeat submission keeps nothing", async () => {
    const b = (await applicationOf(roles.b.id, "maria.reyes@example.com"))!;
    expect(await changeLearnedFact(container, { companyId, candidateId: mariaId, factId: "lf_kept_license", action: "change", text: "Active CA RDH license, renewed March 2026." })).toBe("changed");
    const changed = (await container.db.select().from(applications).where(eq(applications.id, b.id)))[0];
    expect(changed.answers.kept?.find((k) => k.id === "lf_kept_license")).toMatchObject({ text: "Active CA RDH license, renewed March 2026.", editedAt: expect.any(String) });
    expect(await changeLearnedFact(container, { companyId, candidateId: mariaId, factId: "lf_kept_trained", action: "remove" })).toBe("removed");
    const removed = (await container.db.select().from(applications).where(eq(applications.id, b.id)))[0];
    expect(removed.answers.kept?.map((k) => k.id)).toEqual(["lf_kept_license"]);
    expect(JSON.stringify(removed.answers)).not.toContain("trained two new hygienists");
    // the fact on the application it came from keeps only that it was removed, as before
    const origin = (await container.db.select().from(applications).where(eq(applications.id, mariaFirstApp)))[0];
    expect(origin.answers.learned?.find((f) => f.id === "lf_kept_trained")).toMatchObject({ text: "Removed", removedAt: expect.any(String) });
    // the same job again with the link: a repeat submission changes nothing on file, kept facts included
    const again = applyForm(roles.b, { first: "Maria", last: "Reyes", email: "maria.reyes@example.com" }, { reuse: tokenFor(roles.b.id), keep: ["lf_kept_car"] });
    expect((await post(again.path, again.fd)).status).toBe(302);
    await container.drain();
    const after = (await container.db.select().from(applications).where(eq(applications.id, b.id)))[0];
    expect(after.answers.kept?.map((k) => k.id)).toEqual(["lf_kept_license"]);
  });
});
