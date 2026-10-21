import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RolePacket, ScreenWriteup } from "@ros/contracts";
import { CHAT_WRAP_QUESTION, WRITEUP_NOT_GIVEN_NOTE } from "@ros/agents";
import { CHAT_WRAP_KEY, applicationAnswerSentences } from "@ros/core";
import { aiRuns, applications, candidates, companies, rolePackets, roles, screens, unconfirmedScreens, withTenant } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { SCREEN_BUSY_JS } from "./pages/candidate";
import { conversationView, findConversation, startDetachedConversation } from "./services/apply-conversation";
import { followApply, useOneVisitApplyFlow } from "./test-helpers";

/**
 * Review & send (Wave S7, slice S7-D; scratchpad kanvis-2/spec-s7-apply-flow.md step 7), over HTTP the way a browser
 * without JavaScript uses it: at the end of the chat, "Review and send" writes the answers up from the candidate's own
 * replies (once, however often it is pressed; their own words when the assistant is down), and the page shows "Check
 * what you're sending": their details for the company, then each answer with Edit and any note from the assistant kept
 * apart; a change is exactly what they typed and theirs from then on; Send sends as before. Nothing of it reaches the
 * team before Send, a repeat submission's conversation reads the same, and a company's private "what to look for"
 * never reaches the page.
 */
describe("Review & send", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let slug = "";
  let roleId = "";
  let packet: RolePacket;
  let ip = 40;

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const post = (path: string, fields: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const page = async (path: string) => {
    const r = await app.request(path);
    expect(r.status, path).toBe(200);
    return decode(await r.text());
  };
  const scriptsOf = (html: string) => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const screenOf = async (token: string) => (await container.db.select().from(screens).where(eq(screens.token, token)))[0];
  const writeupRuns = async () => (await container.db.select().from(aiRuns).where(eq(aiRuns.task, "screen.writeup"))).length;
  /** The chat's latest message, the one to answer now (Wave S7). */
  const nowLine = (html: string) => html.match(/<li class="msg assistant now" id="question">([\s\S]*?)<\/li>/)?.[1] ?? "";
  /** The question the chat is asking now: the job's own questions (no CV lines from a reading, so no gaps), then the closing question. */
  const keyOf = (html: string) => [...packet.screening.questions, { key: CHAT_WRAP_KEY, question: CHAT_WRAP_QUESTION }].find((q) => nowLine(html).includes(q.question))?.key ?? null;
  /** The chat's end: "Review and send" in place of the reply box (or on "Check your answers"). */
  const chatEnd = (token: string) => `<form method="post" action="/c/screen/${token}/review">`;
  const TYPED = "At Smile Bright I see nine patients a day, chart everything in Dentrix and do perio maintenance.";

  async function apply(p: { first: string; last: string; email: string }): Promise<string> {
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", p.last); fd.set("email", p.email); fd.set("locationText", "Irvine, CA");
    fd.set("resume", new File([`${p.first} ${p.last}, RDH\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present\nLicenses: RDH license CA #RDH12345, active\nSkills: Dentrix, periodontal charting`], "resume.txt", { type: "text/plain" }));
    for (const rule of packet.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("acknowledged", "yes");
    ip += 1;
    const r = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${ip}` } });
    await container.drain();
    // the waiting room opens the AI interview once the résumé is read (20 Oct 2026, R20-12)
    const { token } = await followApply(app, r, container);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    return token!;
  }

  /** Start, then every question: a tap where offered, a skip where asked, the same words otherwise; ends at the chat's end. */
  async function answerAll(token: string, skip: string[] = []): Promise<string> {
    await post(`/c/screen/${token}/start`);
    for (let i = 0; i < 24; i++) {
      const html = await page(`/c/screen/${token}`);
      if (html.includes(chatEnd(token)) || html.includes("<h1>Check your answers</h1>")) return html;
      const key = keyOf(html);
      const fields: Record<string, string> = key && skip.includes(key) ? { action: "skip" } : html.includes('<input type="hidden" name="tap" value="yes_no"/>') ? { tap: "yes_no", choice: "yes" } : html.includes('<input type="hidden" name="tap" value="pay_range"/>') ? { tap: "pay_range", min: "50", max: "54" } : { message: TYPED };
      expect((await post(`/c/screen/${token}`, fields)).status).toBe(302);
    }
    throw new Error("the conversation did not reach check your answers");
  }

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", JOBS_BASE_URL: "https://jobs.example.test", SMS_ENABLED: "false" } });
    app = createApp(container);
    const r1 = await json("POST", "/api/v1/auth/magic-link", { email: "dana@reviewsend.test" });
    const { devLink } = (await r1.json()) as { devLink: string };
    cookie = (await json("POST", "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token") })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Send Dental", vertical: "dental", sizeBand: "20-49", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    slug = co.slug;
    await useOneVisitApplyFlow(container, co.id);
    const s = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    packet = ((await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: RolePacket } }).currentPacket.packet;
    expect(packet.screening.questions.map((q) => q.key)).toEqual(expect.arrayContaining(["license_confirm", "hard_moment", "pay"]));
  });
  afterAll(async () => {
    await container.close();
  });

  let token = "";
  let applicationId = "";

  it("'Review and send' writes the answers up from their own replies, once however often it is pressed, and the page becomes Review & send", async () => {
    token = await apply({ first: "Maria", last: "Reyes", email: "maria.reyes@example.com" });
    const check = await answerAll(token, ["hard_moment"]);
    const base = `/c/screen/${token}`;
    // until it is written up, the chat's end stays on its close with "Review and send" in place of the reply box
    expect(check).toContain("<div class=\"chat-end\"><p>Your chat is complete.</p>");
    const view = (await conversationView(container.db, (await findConversation(container.db, token))!))!;
    if (view.counter) expect(check).toContain(`<form method="post" action="${base}/review"><button class="btn" type="submit">Review and send</button></form>`);
    else expect(check).not.toContain(`${base}/review`);
    const runs = await writeupRuns();
    const [first, second] = await Promise.all([post(`${base}/review`), post(`${base}/review`)]);
    expect(first.headers.get("location")).toBe(base);
    expect(second.headers.get("location")).toBe(base);
    expect((await post(`${base}/review`)).headers.get("location")).toBe(base);
    const scr = await screenOf(token);
    applicationId = scr.applicationId;
    const w = scr.progress.writeup as ScreenWriteup;
    // one answer per question the page shows, in its order: the job's own questions among them
    expect(w.answers.map((a) => a.questionKey)).toEqual(view.written.map((q) => q.key));
    expect(w.answers.map((a) => a.questionKey)).toEqual(expect.arrayContaining(["license_confirm", "hard_moment", "pay"]));
    expect(w.aiRunId).toBeTruthy();
    // screen.writeup version 2 (Wave S9): a short reply stays short, and never the question's words
    expect(w.promptVersion).toBe(2);
    // each question's answer is the candidate's own words; the skipped one is a skip, with nothing written for them
    expect(w.answers.find((a) => a.questionKey === "license_confirm")).toMatchObject({ answer: "Yes", status: "answered", by: "writeup", note: null });
    expect(w.answers.find((a) => a.questionKey === "hard_moment")).toMatchObject({ answer: "", status: "skipped", note: null });
    expect(w.answers.find((a) => a.questionKey === "pay")?.answer).toBe("I'm looking for $50 to $54 an hour.");
    // the model was asked at most twice for two presses at once, and the third press asked nothing
    expect((await writeupRuns()) - runs).toBeLessThanOrEqual(2);
    expect((await writeupRuns()) - runs).toBeGreaterThanOrEqual(1);
    const [run] = await container.db.select().from(aiRuns).where(eq(aiRuns.id, w.aiRunId!));
    expect(run).toMatchObject({ task: "screen.writeup", promptKey: "screen.writeup" });
    expect(run.inputRef).toMatchObject({ screenId: scr.id });
  });

  it("shows 'Check what you're sending': the AI line first, the steps at Review & send, their details, each answer with Edit, the count and Send; no new script", async () => {
    const base = `/c/screen/${token}`;
    const html = await page(base);
    const main = html.slice(html.indexOf("<main>") + "<main>".length);
    expect(main.startsWith('<p class="ai-line"><span class="ai-tag">AI assistant</span>')).toBe(true);
    expect(main).toMatch(/^<p class="ai-line">.*?<\/p><nav class="journey" aria-label="Your application">/);
    expect(html).toContain('<li class="current" aria-current="step">Review & send</li>');
    expect(html).toContain(`<form method="post" action="${base}/later" class="journey-later"><span>Saved</span><button class="link-action" type="submit">Finish later</button></form>`);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain("<h1>Check what you're sending</h1>");
    expect(html).toContain('<p class="lead">Send Dental reads this exactly as written, so change anything now. The hiring team sees your answers only once you send them.</p>');
    expect(html).toContain("<details class=\"more\"><summary>What if I don't press Send?</summary><p>If you do not press Send, the conversation closes a few days after your last answer or change, and your application goes to the hiring team without these answers. If we have not reminded you yet, we email you once before then.</p></details>");
    expect(html).toContain('<h2 id="send-details">Your details for Send Dental</h2>');
    expect(html).toContain('<h2 id="send-chat">From your chat</h2><p>Written up from your own replies. Change anything that came out wrong.</p>');
    const w = (await screenOf(token)).progress.writeup as ScreenWriteup;
    const n = w.answers.findIndex((a) => a.questionKey === "hard_moment") + 1;
    const hard = packet.screening.questions.find((q) => q.key === "hard_moment")!;
    expect(html).toContain(`<li class="answer" id="w-hard_moment"><div class="answer-head"><p class="answer-q">${n}. ${hard.question}</p><span class="pill">Skipped</span></div><p class="pre">You skipped this question.</p><a href="${base}/answers/hard_moment">Answer it<span class="sr-only"> (question ${n})</span></a></li>`);
    expect(html).toContain(`<p class="pre">Yes</p><a href="${base}/answers/license_confirm">Edit<span class="sr-only">`);
    const [, answered, total] = html.match(/<p class="send-count">(\d+) of (\d+) answered<\/p>/) ?? [];
    expect(Number(total)).toBeGreaterThanOrEqual(w.answers.length);
    expect(Number(answered)).toBe(Number(total) - 1);
    expect(html).toContain(`<form method="post" action="${base}/submit"><button class="btn" type="submit">Send my answers</button></form>`);
    expect(html).toContain(`<a class="link-action" href="${base}/person">I'd rather talk to a person</a>`);
    // everything that goes to the team is listed and can be changed: the closing answer too, under "Your other answers"
    expect(html).toContain("<h3>Your other answers</h3>");
    expect(html).toContain(`<a href="${base}/answers/${CHAT_WRAP_KEY}">Change<span class="sr-only">`);
    // and the whole chat, word for word, one click away
    expect(html).toContain("<details class=\"more\"><summary>See your whole chat</summary><ol class=\"thread\" aria-label=\"Your whole chat\">");
    // the page's own styles in the conversation's one style element; the one script that stops a second press
    expect(html.match(/<style\b/g)?.length).toBe((await page(`/c/screen/${await apply({ first: "Ola", last: "Berg", email: "ola.berg@example.com" })}`)).match(/<style\b/g)?.length);
    expect(html).toContain(".assistant-note {");
    expect(scriptsOf(html)).toEqual([SCREEN_BUSY_JS]);
    // nothing listed from the form: the details are said, the same for every kind of conversation
    expect(html).not.toContain("maria.reyes@example.com");
    expect(html).not.toContain("Reyes");
  });

  it("nothing of the write-up reaches the team before Send", async () => {
    const detail = (await (await json("GET", `/api/v1/applications/${applicationId}`)).json()) as { screens: Array<{ progress: Record<string, unknown>; answers: Record<string, string> }> };
    expect(detail.screens.length).toBeGreaterThan(0);
    for (const s of detail.screens) {
      expect(s.progress.writeup).toBeUndefined();
      expect(s.answers).toEqual({});
    }
    expect(JSON.stringify(detail)).not.toContain("I'm looking for $50 to $54 an hour.");
  });

  it("Edit: the answer as written up in the box, the change saved exactly, marked as theirs, in the transcript; a skipped one answered", async () => {
    const base = `/c/screen/${token}`;
    const typedKey = packet.screening.questions.find((q) => !["license_confirm", "hard_moment", "pay"].includes(q.key))!.key;
    const edit = await page(`${base}/answers/${typedKey}`);
    expect(edit).toContain(`<a href="${base}#w-${typedKey}">`);
    expect(edit).toContain("Back to what you're sending");
    expect(edit).toContain(`>${TYPED}`);
    expect(edit).toContain("</textarea>");
    const words = "I see nine patients a day at Smile Bright and chart in Dentrix; I also run the recall list.";
    expect((await post(`${base}/answers/${typedKey}`, { message: words })).headers.get("location")).toBe(`${base}?changed=${typedKey}#w-${typedKey}`);
    expect((await post(`${base}/answers/hard_moment`, { message: "A nervous patient wanted to stop, so I slowed down and explained each step." })).headers.get("location")).toBe(`${base}?changed=hard_moment#w-hard_moment`);
    const scr = await screenOf(token);
    const w = scr.progress.writeup as ScreenWriteup;
    expect(w.answers.find((a) => a.questionKey === typedKey)).toMatchObject({ answer: words, by: "candidate", status: "answered", note: null });
    expect(w.answers.find((a) => a.questionKey === "hard_moment")).toMatchObject({ status: "answered", by: "candidate" });
    expect(scr.answers[typedKey]).toBe(words);
    expect(scr.transcript.at(-2)).toMatchObject({ role: "candidate", content: words, questionKey: typedKey, source: "edit" });
    expect(scr.progress.declined ?? []).not.toContain("hard_moment");
    const html = await page(`${base}?changed=${typedKey}`);
    expect(html).toContain('<div class="card" role="status"><strong>Your answer is changed.</strong></div>');
    const item = html.slice(html.indexOf(`<li class="answer" id="w-${typedKey}">`));
    expect(item.slice(0, item.indexOf("</li>"))).toContain('<span class="pill">Changed</span>');
    const [, answered, total] = html.match(/<p class="send-count">(\d+) of (\d+) answered<\/p>/) ?? [];
    expect(answered).toBe(total);
    // an empty change says so; a tapped one is changed by tapping
    expect((await post(`${base}/answers/${typedKey}`, { message: " " })).headers.get("location")).toBe(`${base}/answers/${typedKey}?error=empty`);
    expect(await page(`${base}/answers/license_confirm`)).toContain('<input type="hidden" name="tap" value="yes_no"/>');
    await post(`${base}/answers/license_confirm`, { tap: "yes_no", choice: "no" });
    expect(((await screenOf(token)).progress.writeup as ScreenWriteup).answers.find((a) => a.questionKey === "license_confirm")).toMatchObject({ answer: "No", by: "candidate" });
  });

  it("Send sends as before; the team then reads the write-up with the chat", async () => {
    const base = `/c/screen/${token}`;
    expect((await post(`${base}/submit`)).headers.get("location")).toBe(base);
    await container.drain();
    expect(await page(base)).toContain("<h1>Thanks, your answers are sent</h1>");
    expect((await screenOf(token)).status).toBe("completed");
    const detail = (await (await json("GET", `/api/v1/applications/${applicationId}`)).json()) as { screens: Array<{ progress: { writeup?: ScreenWriteup } }> };
    expect(detail.screens.some((s) => s.progress.writeup?.answers.some((a) => a.questionKey === "pay"))).toBe(true);
    // after Send nothing more is written up or changed
    expect((await post(`${base}/review`)).headers.get("location")).toBe(base);
    expect((await app.request(`${base}/answers/pay`)).headers.get("location")).toBe(base);
  });

  it("the assistant's note sits apart from the answer, labelled as the assistant's", async () => {
    const t = await apply({ first: "Ana", last: "Lind", email: "ana.lind@example.com" });
    await answerAll(t);
    const scr = await screenOf(t);
    const said = scr.transcript.filter((x) => x.role === "candidate" && x.questionKey === undefined).map((x) => x.content);
    expect(said.length).toBeGreaterThan(0);
    const hard = packet.screening.questions.find((q) => q.key === "hard_moment")!;
    container.fake!.scriptNext("screen.writeup", { answers: packet.screening.questions.map((q) => (q.key === "hard_moment" ? { questionKey: q.key, answer: "I see nine patients a day.", status: "partly", quotes: ["I see nine patients a day"], note: "No example was given of a hard moment with a patient." } : { questionKey: q.key, answer: "", status: "not_given", quotes: [], note: null })) });
    await post(`/c/screen/${t}/review`);
    container.fake!.clearScripts();
    const html = await page(`/c/screen/${t}`);
    const item = html.slice(html.indexOf('<li class="answer" id="w-hard_moment">'));
    const li = item.slice(0, item.indexOf("</li>"));
    // a plain block with its visible label, never a landmark (axe: one complementary landmark per note would nest them)
    expect(li).toContain(`${hard.question}</p><span class="pill">Partly answered</span></div><p class="pre">I see nine patients a day.</p><div class="assistant-note"><p class="note-label">Note from the assistant</p><p>No example was given of a hard moment with a patient.</p></div><a href=`);
    expect(html).not.toContain("<aside");
    // where the model said "not given" but the chat has their reply, their own words stand
    const w = (await screenOf(t)).progress.writeup as ScreenWriteup;
    expect(w.answers.find((a) => a.questionKey === "license_confirm")).toMatchObject({ answer: "Yes", status: "answered" });
  });

  it("with the assistant down, the write-up is their own replies, and the page works the same", async () => {
    const t = await apply({ first: "Bo", last: "Strand", email: "bo.strand@example.com" });
    await answerAll(t);
    container.fake!.failNext("screen.writeup", "throw");
    await post(`/c/screen/${t}/review`);
    const w = (await screenOf(t)).progress.writeup as ScreenWriteup;
    expect(w).toMatchObject({ aiRunId: null, promptVersion: null });
    expect(w.answers.find((a) => a.questionKey === "license_confirm")).toMatchObject({ answer: "Yes", status: "answered" });
    expect(await page(`/c/screen/${t}`)).toContain("<h1>Check what you're sending</h1>");
  });

  /** A repeat submission's detached copy, as the apply page's waiting room opens one (Q14, kept in full on 21 Oct 2026). */
  async function detachedCopy(email: string, firstName: string): Promise<string> {
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    const [company] = await container.db.select().from(companies).where(eq(companies.id, role.companyId));
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, email));
    const [first] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id)));
    const formAnswers = applicationAnswerSentences(packet, { eligibility: Object.fromEntries(packet.requirements.eligibility.map((r) => [r.key, "yes"])), quick: null }).map((s) => s.sentence);
    const made = await withTenant(container.db, company.id, (tx) => startDetachedConversation(tx, container, { application: first, role, company, firstName, typedFacts: { cv: [], formAnswers } }));
    return made!.token;
  }

  it("a repeat submission's conversation reads the same: written up on its own copy, with nothing of the person on file", async () => {
    const t = await detachedCopy("maria.reyes@example.com", "Mia");
    const [row] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.token, t));
    expect(row).toBeTruthy();
    await answerAll(t);
    await post(`/c/screen/${t}/review`);
    const [after] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.token, t));
    expect(after.progress.writeup?.answers.length).toBe(packet.screening.questions.length);
    const html = await page(`/c/screen/${t}`);
    expect(html).toContain("<h1>Check what you're sending</h1>");
    // the form's answers as the chat read them, the same lines as a first application's, then the one correction line
    const details = html.slice(html.indexOf('<h2 id="send-details">'), html.indexOf("</section>", html.indexOf('<h2 id="send-details">')));
    expect(details).toMatch(/^<h2 id="send-details">Your details for Send Dental<\/h2><ul>(<li>[^<]+ Yes\.<\/li>)+<\/ul><p>These went with your form, with your name, contact details and resume; this chat does not change them\. To correct something, use "Ask for a copy, a fix, deletion, or a person's review" on your application's page; its link is in the email we sent you when you applied\.<\/p>$/);
    expect(html).not.toContain("Reyes");
    expect(html).not.toContain("Maria");
    // a change works the same on the copy, and the real application is untouched
    const typedKey = packet.screening.questions.find((q) => !["license_confirm", "hard_moment", "pay"].includes(q.key))!.key;
    expect((await post(`/c/screen/${t}/answers/${typedKey}`, { message: "I chart in Dentrix every day." })).headers.get("location")).toBe(`/c/screen/${t}?changed=${typedKey}#w-${typedKey}`);
    const [changed] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.token, t));
    expect(changed.progress.writeup?.answers.find((a) => a.questionKey === typedKey)).toMatchObject({ answer: "I chart in Dentrix every day.", by: "candidate" });
    expect(changed.transcript.at(-1)).toMatchObject({ content: "I chart in Dentrix every day.", source: "edit" });
    const [run] = (await container.db.select().from(aiRuns).where(eq(aiRuns.task, "screen.writeup"))).filter((r) => (r.inputRef as { unconfirmedScreenId?: string }).unconfirmedScreenId === row.id);
    expect(run).toBeTruthy();
  });

  it("a company's own written questions: written up from the chat, one the chat never asked noted as missing and answered here; their private look-for never on the page", async () => {
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, role.currentPacketVersion!)));
    const why = { key: "wq_why", question: "Why would you like to work at a small practice?", required: true, lookFor: "SECRET-LOOK-FOR wants long tenure" };
    await container.db.update(rolePackets).set({ packet: { ...pv.packet, companyQuestions: { quick: [], written: [why] } } }).where(eq(rolePackets.id, pv.id));
    const t = await apply({ first: "Eva", last: "Holm", email: "eva.holm@example.com" });
    await answerAll(t);
    // a second question added to the job after the chat started: the chat never asked it
    const later = { key: "wq_later", question: "Which days of the week suit you best?", required: true, lookFor: "SECRET-LOOK-FOR weekends" };
    await container.db.update(rolePackets).set({ packet: { ...pv.packet, companyQuestions: { quick: [], written: [why, later] } } }).where(eq(rolePackets.id, pv.id));
    await post(`/c/screen/${t}/review`);
    const base = `/c/screen/${t}`;
    const w = (await screenOf(t)).progress.writeup as ScreenWriteup;
    expect(w.answers.map((a) => a.questionKey)).toEqual(["wq_why", "wq_later"]);
    // nothing invented for the one never asked, and the note says so, apart from the answer
    expect(w.answers[1]).toEqual({ questionKey: "wq_later", answer: "", status: "not_given", quotes: [], note: WRITEUP_NOT_GIVEN_NOTE, by: "writeup" });
    // the one the chat asked holds the candidate's own words, or says it is missing; never anything else
    if (w.answers[0].answer) expect(w.answers[0].answer).toContain("Dentrix");
    let html = await page(base);
    expect(html).not.toContain("SECRET-LOOK-FOR");
    expect(html).toContain('<li class="answer" id="w-wq_later"><div class="answer-head"><p class="answer-q">2. Which days of the week suit you best?</p><span class="pill">Not answered</span></div><p class="pre">No answer yet.</p><div class="assistant-note"><p class="note-label">Note from the assistant</p><p>No answer to this question was given in the chat.</p></div><a href=');
    const edit = await page(`${base}/answers/wq_later`);
    expect(edit).toContain('<h1 class="question" id="question">Which days of the week suit you best?</h1>');
    expect(edit).not.toContain("SECRET-LOOK-FOR");
    expect((await post(`${base}/answers/wq_later`, { message: "Monday to Thursday suits me best." })).headers.get("location")).toBe(`${base}?changed=wq_later#w-wq_later`);
    const scr = await screenOf(t);
    expect(scr.answers.wq_later).toBe("Monday to Thursday suits me best.");
    expect(scr.transcript.at(-1)).toMatchObject({ role: "candidate", content: "Monday to Thursday suits me best.", questionKey: "wq_later", source: "edit" });
    expect((scr.progress.writeup as ScreenWriteup).answers[1]).toMatchObject({ answer: "Monday to Thursday suits me best.", status: "answered", note: null, by: "candidate" });
    expect(scr.progress.edits?.wq_later).toBe(1);
    html = await page(`${base}?changed=wq_later`);
    expect(html).toContain('<div class="card" role="status"><strong>Your answer is changed.</strong></div>');
    const item = html.slice(html.indexOf('<li class="answer" id="w-wq_later">'));
    expect(item.slice(0, item.indexOf("</li>"))).not.toContain("Note from the assistant");
    // the application row is untouched by any of it
    const [appRow] = await container.db.select().from(applications).where(eq(applications.id, scr.applicationId));
    expect(JSON.stringify(appRow.answers)).not.toContain("Monday to Thursday suits me");
  });
});
