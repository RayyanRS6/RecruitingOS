import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RolePacket } from "@ros/contracts";
import { aiRuns, applications, candidates, entitlements, notifications, screens, unconfirmedScreens } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { CHAT_WRAP_QUESTION } from "@ros/agents";
import { CHAT_WRAP_KEY } from "@ros/core";
import { SCREEN_BUSY_JS } from "./pages/candidate";
import { CHAT_BUSY_NOTE } from "./pages/conversation-frame";
import { pastTheWaitingRoom, statusTokenFor, useOneVisitApplyFlow } from "./test-helpers";

/**
 * Wave E's candidate pages over HTTP, the way a browser without JavaScript uses them (plan E1, E2, E3, E4, E5, E7, E8,
 * E10, E11, E12, E14; founder decisions B1/Q15, Q14, Q16, Q17): the form leads straight to a fixed introduction; Start
 * shows the first question at once, in large type, one at a time, with tap answers for factual questions and a quiet
 * "Skip this question"; "check your answers" with Change, then Send; "I'd rather talk to a person" as two equal
 * choices; "Do this later" by email; the paused and unfinished pages; the neutral receipt for an eligibility mismatch and
 * the one for a used-up allowance; and a repeat submission that sees exactly the same pages, confirmed by email.
 */
describe("Wave E pages: applying and the conversation in one visit", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let cookie = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let packet: RolePacket;
  let ip = 10;

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const post = (path: string, fields: Record<string, string | string[]> = {}) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
    return app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  };
  const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const page = async (path: string, headers: Record<string, string> = {}) => {
    const r = await app.request(path, { headers });
    expect(r.status, path).toBe(200);
    return decode(await r.text());
  };
  /** What each script element on a page runs. */
  const scriptsOf = (html: string) => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const mail = () => (container.integrations.email as FakeEmailAdapter).sent;
  const screenOf = async (token: string) => (await container.db.select().from(screens).where(eq(screens.token, token)))[0];
  const question = (key: string) => packet.screening.questions.find((q) => q.key === key)!;
  /** The chat's latest message, the one to answer now (Wave S7). */
  const nowLine = (html: string) => html.match(/<li class="msg assistant now" id="question">([\s\S]*?)<\/li>/)?.[1] ?? "";
  /** The question the chat is asking now: the job's own questions (no CV was passed, so no gaps), then the closing question. */
  const keyOf = (html: string) => [...packet.screening.questions, { key: CHAT_WRAP_KEY, question: CHAT_WRAP_QUESTION }].find((q) => nowLine(html).includes(q.question))?.key ?? null;
  /** The chat's end: "Review and send" in place of the reply box. */
  const chatEnd = (token: string) => `<form method="post" action="/c/screen/${token}/review"><button class="btn" type="submit">Review and send</button></form>`;

  /** The apply form as a browser posts it. */
  async function apply(p: { first: string; last: string; email: string; eligibility?: "yes" | "no" }) {
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", p.last); fd.set("email", p.email); fd.set("locationText", "Irvine, CA");
    fd.set("resume", new File([`${p.first} ${p.last}, RDH\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present\nLicenses: RDH license CA #RDH12345, active\nSkills: Dentrix, periodontal charting`], "resume.txt", { type: "text/plain" }));
    for (const rule of packet.requirements.eligibility) fd.set(`elig_${rule.key}`, p.eligibility ?? "yes");
    fd.set("acknowledged", "yes");
    ip += 1;
    const r = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${ip}` } });
    await container.drain();
    return r;
  }
  /** The cookie the introduction reads ("Your application is sent"), set when the waiting room opened each interview. */
  const appliedTo = new Map<string, string>();
  /** Runs `fn` with the engine's clock past the 40 to 90 seconds every waiting room says "preparing" first (Q14, 21 Oct). */
  const pastTheWait = (fn: () => Response | Promise<Response>) => pastTheWaitingRoom(container, async () => fn());
  /** The AI interview the waiting room opens (20 Oct 2026, R20-12): the POST's `…/applied`, then, once its wait is over, its 302 to the interview. */
  const tokenOf = async (r: Response) => {
    expect(r.headers.get("location")).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
    const room = await pastTheWait(() => app.request(r.headers.get("location")!, { headers: { cookie: (r.headers.get("set-cookie") ?? "").match(/ros_applied=[^;,]+/)?.[0] ?? "" } }));
    const to = room.headers.get("location") ?? "";
    expect(to).toMatch(/^\/c\/screen\/[A-Za-z0-9_-]+$/);
    const token = to.slice("/c/screen/".length);
    appliedTo.set(token, (room.headers.get("set-cookie") ?? "").match(/ros_applied_to=[^;,]+/)?.[0] ?? "");
    return token;
  };

  /** Answers every question over HTTP: taps where the page offers them, a skip where asked, words otherwise; ends at the chat's end. */
  async function answerAll(token: string, skip: string[] = []) {
    for (let i = 0; i < 30; i++) {
      const html = await page(`/c/screen/${token}`);
      if (html.includes(chatEnd(token))) return html;
      const key = keyOf(html);
      const r = key && skip.includes(key)
        ? await post(`/c/screen/${token}`, { action: "skip" })
        : html.includes('<input type="hidden" name="tap" value="yes_no"/>')
          ? await post(`/c/screen/${token}`, { tap: "yes_no", choice: "yes" })
          : html.includes('<input type="hidden" name="tap" value="pay_range"/>')
            ? await post(`/c/screen/${token}`, { tap: "pay_range", min: "50", max: "54" })
            : await post(`/c/screen/${token}`, { message: "At Smile Bright I see nine patients a day, chart everything in Dentrix and do perio maintenance; I can work Monday to Friday and start in two weeks." });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe(`/c/screen/${token}`);
    }
    throw new Error("the conversation did not reach the chat's end");
  }

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", JOBS_BASE_URL: "https://jobs.example.test", SMS_ENABLED: "false" } });
    app = createApp(container);
    const r1 = await json("POST", "/api/v1/auth/magic-link", { email: "dana@visitpages.test" });
    const { devLink } = (await r1.json()) as { devLink: string };
    cookie = (await json("POST", "/api/v1/auth/magic-link/consume", { token: new URL(devLink).searchParams.get("token") })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Visit Dental", vertical: "dental", sizeBand: "20-49", ownerName: "Dana Whitfield", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    // A pilot company: ITS switched the one-visit flow on for it.
    await useOneVisitApplyFlow(container, companyId);
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

  let mariaToken = "";

  it("E1, E2: the form leads straight to a fixed introduction: the AI line first, what it is for, a conversation and not a test, how many questions and minutes, skipping and coming back, and three ways on; nothing written by the model", async () => {
    const turns = (await container.db.select().from(aiRuns).where(eq(aiRuns.task, "screen.turn"))).length;
    const r = await apply({ first: "Maria", last: "Reyes", email: "maria.reyes@example.com" });
    expect(r.status).toBe(302);
    mariaToken = await tokenOf(r);
    expect(await screenOf(mariaToken)).toMatchObject({ invitedVia: "with_application", channel: "web", status: "invited" });
    const applied = appliedTo.get(mariaToken)!;
    const html = await page(`/c/screen/${mariaToken}`, { cookie: applied });
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    const main = html.slice(html.indexOf("<main>") + "<main>".length);
    expect(main.startsWith('<p class="ai-line"><span class="ai-tag">AI assistant</span><span>This conversation is with Visit Dental\'s AI assistant, a software program, not a person. People on the hiring team make every decision.</span></p>')).toBe(true);
    expect(html).toContain(`<p class="eyebrow">Visit Dental · ${packet.identity.title}</p>`);
    expect(html).toContain("<strong>Your application is sent.</strong><p>Your own link to it is on its way to m***@example.com.");
    expect(html).toContain(`<h1>A few questions about the ${packet.identity.title} role</h1>`);
    expect(html).toContain("Hi Maria, this is Visit Dental's hiring assistant, a software program.");
    expect(html).toContain("It is a conversation, not a test.");
    expect(html).toContain(`About ${packet.screening.questions.length} questions and ${packet.screening.maxMinutes} minutes, one question at a time.`);
    expect(html).toContain("You can skip any question, or stop and come back later: this page keeps your place.");
    // on the web a person is one press away: the packet's email lines ("Reply HUMAN…", "This message was sent by…") give way to that (polish list)
    expect(html).toContain('<p>Would you rather talk to a person? Press "I\'d rather talk to a person" at any time.</p>');
    expect(html).not.toMatch(/Reply HUMAN at any time|This message was sent by/);
    expect(html).toContain(`<form method="post" action="/c/screen/${mariaToken}/start"><button class="btn" type="submit">Start</button></form>`);
    expect(html).toContain(`<form method="post" action="/c/screen/${mariaToken}/later"><button class="btn secondary" type="submit">Do this later</button></form>`);
    expect(html).toContain(`<a class="btn secondary" href="/c/screen/${mariaToken}/person">I'd rather talk to a person</a>`);
    // the first view is the points and the three ways on; what each way does, and the AI notice word for word, are one click away (founder brief, 14 October 2026)
    expect(html).toMatch(/<\/div><details class="more"><summary>More about this conversation<\/summary><p>Would you rather talk to a person\?/);
    expect(html).toContain('"Do this later" emails you the link.');
    expect(html).toMatch(/<details class="more"><summary>How AI is used<\/summary>(<p class="notice">[^<]*<\/p>)*<p class="notice">[^<]*artificial intelligence/);
    // nothing to type yet, no script but the one that stops a second press, and the model was never asked to write an opening
    expect(html).not.toContain("<textarea");
    expect(scriptsOf(html)).toEqual([SCREEN_BUSY_JS]);
    expect((await container.db.select().from(aiRuns).where(eq(aiRuns.task, "screen.turn"))).length).toBe(turns);
    // without the cookie (opened later from the email) the page says nothing about where the link went
    expect(await page(`/c/screen/${mariaToken}`)).not.toContain("Your application is sent.");
    // her status page leads with the progress line (Wave S2, K4): Applied ticked, the AI interview where she is, then the
    // rest; one line on what happens next, then the button
    const status = await page(`/c/status/${await statusTokenFor(container, { roleId, email: "maria.reyes@example.com" })}`);
    const track = status.slice(status.indexOf('<ol class="track" aria-label="Where your application is">'), status.indexOf("</ol>", status.indexOf('<ol class="track"')));
    expect(track).toMatch(/^<ol class="track" aria-label="Where your application is"><li class="done"><span class="dot" aria-hidden="true"><svg class="icon"[^>]*>.*?<\/svg><\/span><span>Applied<\/span><span class="sr-only"> \(done\)<\/span><\/li><li class="current" aria-current="step"><span class="dot" aria-hidden="true"><\/span><span>AI interview<\/span><\/li><li><span class="dot" aria-hidden="true"><\/span><span>Review<\/span><\/li><li><span class="dot" aria-hidden="true"><\/span><span>Interview<\/span><\/li><li><span class="dot" aria-hidden="true"><\/span><span>Decision<\/span><\/li>$/);
    expect(status).toContain("<h2>What happens next</h2><p>Your next step is a short AI interview with the hiring team's AI assistant. It is waiting for you, whenever suits you.</p>");
    expect(status).toContain(`<a class="btn" href="/c/screen/${mariaToken}">Start your AI interview</a>`);
    // the Status card names where she is as the line does
    expect(status).toMatch(/<span>Status<\/span><strong>AI interview<\/strong>/);
  });

  it("E2, E12, E14, Wave S7: Start opens the chat at once: the steps with the counter, where the replies go, the first question word for word as the latest message, Yes and No to tap, the reply box named after the question, and the quiet skip; a tap is recorded word for word", async () => {
    expect((await post(`/c/screen/${mariaToken}/start`)).headers.get("location")).toBe(`/c/screen/${mariaToken}`);
    const q1 = question("license_confirm");
    const q2 = packet.screening.questions[1];
    const total = packet.screening.questions.length;
    let html = await page(`/c/screen/${mariaToken}`);
    // the AI line stays first; the steps come right under it: Chat now, the counter (never the questions in advance), "Saved" and "Finish later"
    const main = html.slice(html.indexOf("<main>") + "<main>".length);
    expect(main).toMatch(/^<p class="ai-line">.*?<\/p><nav class="journey" aria-label="Your application">/);
    expect(html).toMatch(/aria-current="step">Chat</);
    expect(html).toMatch(new RegExp(`<form method="post" action="/c/screen/${mariaToken}/later"[^>]*>(<span>Saved</span>)?<button class="link-action" type="submit">Finish later</button></form>`));
    expect(html).toContain(`<h1 class="chat-title">Your chat about the ${packet.identity.title} role</h1>`);
    expect(html).toContain("<span>Your replies go to Visit Dental only when you press Send my answers at the end.</span>");
    expect(html).not.toMatch(/Question \d of/);
    // the opening, in code: her first name. Her résumé came inside the form (no script), so only the intake read it, for
    // the fit check and the score: the interview names only what the form's own reading gave, which a returning
    // address's copy has too (21 Oct, Q14), so it thanks her; a résumé the form read is named (apply-details.test.ts).
    // Then anything about the job's must-haves her own words do not show ("About your experience"), then the job's questions
    expect(nowLine(html)).toMatch(/^<span class="sr-only">The assistant said: <\/span>Hi Maria\. Thanks for applying\./);
    expect(html).toContain(`<p class="sending" id="sending" role="status" data-wait="${CHAT_BUSY_NOTE}"></p>`);
    // a second press of Start changes nothing
    await post(`/c/screen/${mariaToken}/start`);
    expect((await screenOf(mariaToken)).transcript.filter((t) => t.role === "assistant")).toHaveLength(1);
    for (let i = 0; i < 8 && !html.includes('<input type="hidden" name="tap" value="yes_no"/>'); i++) {
      expect(html).toContain(" required · About your experience<");
      expect((await post(`/c/screen/${mariaToken}`, { message: "At Smile Bright I see nine patients a day, chart everything in Dentrix and do perio maintenance." })).status).toBe(302);
      html = await page(`/c/screen/${mariaToken}`);
    }
    // the first of the job's questions: a yes-or-no question to tap, the reply box named after it, and the quiet skip
    expect(html).toContain(`>0 of ${total} required · Required questions<`);
    expect(nowLine(html)).toContain(q1.question);
    expect(html).toContain(`<input type="hidden" name="tap" value="yes_no"/><fieldset class="actions" aria-label="Your answer to: ${q1.question}"><button class="btn secondary" type="submit" name="choice" value="yes">Yes</button><button class="btn secondary" type="submit" name="choice" value="no">No</button><button class="link-action" type="submit" name="action" value="skip" formnovalidate="">Skip this question</button></fieldset>`);
    expect(html).toContain("<summary>Answer in your own words instead</summary>");
    expect(html).toContain(`<label for="message">Your reply<span class="sr-only"> to: ${q1.question}</span></label>`);
    expect(html).toContain(`<a class="link-action" href="/c/screen/${mariaToken}/person">I'd rather talk to a person</a>`);
    expect(html).toContain(`<form method="post" action="/c/screen/${mariaToken}/later"><button class="link-action" type="submit">Finish later: email me the link</button></form>`);
    // the tap: recorded as fixed words; the next question follows word for word, after one neutral line
    expect((await post(`/c/screen/${mariaToken}`, { tap: "yes_no", choice: "yes" })).headers.get("location")).toBe(`/c/screen/${mariaToken}`);
    const scr = await screenOf(mariaToken);
    expect(scr.answers[q1.key]).toBe("Yes");
    expect(scr.transcript.find((t) => t.source === "tap")).toMatchObject({ role: "candidate", content: "Yes", questionKey: q1.key });
    html = await page(`/c/screen/${mariaToken}`);
    expect(nowLine(html)).toBe(`<span class="sr-only">The assistant said: </span>Noted: Yes.\n\n${q2.question}`);
    expect(html).toContain(`>1 of ${total} required · Required questions<`);
    // the whole chat is one thread: the opening, her own answer on the right, the next question
    const thread = html.slice(html.indexOf('<ol class="thread" aria-label="Your chat">'), html.indexOf("</ol>", html.indexOf('<ol class="thread" aria-label="Your chat">')));
    expect(thread).toContain(q1.question);
    expect(thread).toContain('<li class="msg candidate"><span class="sr-only">You said: </span>Yes</li>');
    expect(thread.indexOf(q1.question)).toBeLessThan(thread.indexOf("You said: </span>Yes"));
  });

  it("E11, E12: an empty answer and a tap that does not fit are refused plainly; a skip is noted for what it is; the pay range is tapped", async () => {
    expect((await post(`/c/screen/${mariaToken}`, { message: "   " })).headers.get("location")).toBe(`/c/screen/${mariaToken}?error=empty`);
    expect(await page(`/c/screen/${mariaToken}?error=empty`)).toContain('<div class="err" role="alert">Please type an answer first, or press Skip this question.</div>');
    expect((await post(`/c/screen/${mariaToken}`, { tap: "pay_range", min: "" })).headers.get("location")).toBe(`/c/screen/${mariaToken}?error=tap`);
    expect(await page(`/c/screen/${mariaToken}?error=tap`)).toContain("That answer does not fit this question.");
    const end = await answerAll(mariaToken, ["hard_moment"]);
    expect(end).toContain(chatEnd(mariaToken));
    const scr = await screenOf(mariaToken);
    expect(scr.progress.declined).toEqual(["hard_moment"]);
    expect(scr.transcript.find((t) => t.source === "skip")).toMatchObject({ role: "system", questionKey: "hard_moment" });
    expect(scr.answers.pay).toBe("I'm looking for $50 to $54 an hour.");
    // nobody on the team has heard yet: she is still applying (E6)
    expect((await container.db.select().from(notifications).where(eq(notifications.companyId, companyId))).filter((n) => n.title.includes("Maria"))).toHaveLength(0);
  });

  it("Wave S7, E10: the chat ends on its close (one thing she said, what happens next) and 'Review and send' in place of the reply box; Send ends it; only then does the team hear", async () => {
    const base = `/c/screen/${mariaToken}`;
    let html = await page(base);
    const total = packet.screening.questions.length;
    expect(html).toContain(`<div class="chat-end"><p>Your chat is complete.</p>${chatEnd(mariaToken)}</div>`);
    expect(html).not.toContain("<textarea");
    // the close names one concrete thing she said, in her own words, then what happens next: never a time, nothing sent before Send
    expect(nowLine(html)).toMatch(/^<span class="sr-only">The assistant said: <\/span>Thank you, Maria\. You told me "[^"]+"\.\n\nNext, check what you are sending and change anything you like, then press Send\. Nothing goes to Visit Dental until you do\.$/);
    expect(html).toContain(`>${total} of ${total} required · Wrapping up<`);
    expect(html).toContain("<span>Your replies go to Visit Dental only when you press Send my answers at the end.</span>");
    // pressing it writes the answers up (slice S7-D): the page says so while it does
    expect(html).toContain('data-wait="Writing up your answers from your replies… This can take up to a minute, so please keep this page open."');
    // the whole chat stays on the page; the closing question was asked and answered
    expect(html).toContain(CHAT_WRAP_QUESTION);
    const scr = await screenOf(mariaToken);
    expect(scr.progress.phase).toBe("review");
    expect(scr.status).toBe("in_progress");
    // nobody on the team has heard yet
    expect((await container.db.select().from(notifications).where(eq(notifications.companyId, companyId))).some((n) => n.title.includes("Maria") || n.body.includes("Maria"))).toBe(false);
    // Send: the conversation is complete, the scorecard follows, and the team hears now
    expect((await post(`${base}/submit`)).headers.get("location")).toBe(base);
    await container.drain();
    html = await page(base);
    expect(html).toContain("<h1>Thanks, your answers are sent</h1>");
    expect(html).toContain("The hiring team at Visit Dental reads them with your application.");
    // where the score and what she sent can be seen, and her link again by email: never the record's link itself
    expect(html).toContain("<p>Your match score and everything you sent will be on your application page. Its link is in the email we sent you when you applied.</p>");
    expect(html).toContain('<a class="btn secondary" href="/c/link-request">Email me my link again</a>');
    expect(html).not.toMatch(/href="\/c\/status\//);
    expect(html).not.toContain("<textarea");
    expect((await screenOf(mariaToken)).status).toBe("completed");
    // on her status page the AI interview is behind her, ticked, and the team's review is where she is now
    const status = await page(`/c/status/${await statusTokenFor(container, { roleId, email: "maria.reyes@example.com" })}`);
    expect(status).toMatch(/<li class="done"><span class="dot" aria-hidden="true"><svg class="icon"[^>]*>.*?<\/svg><\/span><span>AI interview<\/span><span class="sr-only"> \(done\)<\/span><\/li><li class="current" aria-current="step"><span class="dot" aria-hidden="true"><\/span><span>Review<\/span><\/li>/);
    expect(status).not.toMatch(/<a class="btn" href="\/c\/screen\//);
    expect((await container.db.select().from(notifications).where(eq(notifications.companyId, companyId))).some((n) => n.title.includes("Maria") || n.body.includes("Maria"))).toBe(true);
    // a finished conversation is not changed any more
    expect((await app.request(`${base}/answers/why`)).headers.get("location")).toBe(base);
  });

  it("E3, Q16: 'I'd rather talk to a person' offers two equal choices; sending without the conversation says so and closes it", async () => {
    const token = await tokenOf(await apply({ first: "Ana", last: "Silva", email: "ana.silva@example.com" }));
    const html = await page(`/c/screen/${token}/person`);
    expect(html).toContain("<h1>Talk to a person instead</h1>");
    expect(html.match(/<button class="btn secondary" type="submit">/g)).toHaveLength(2);
    expect(html).toContain('<h2 id="path-send">Send my application as it is</h2>');
    expect(html).toContain('<h2 id="path-person">Have a person contact me</h2>');
    expect(html).toContain(`<a href="/c/screen/${token}"><svg`);
    expect((await post(`/c/screen/${token}/person`, { choice: "send_without" })).headers.get("location")).toBe(`/c/screen/${token}`);
    await container.drain();
    const closed = await page(`/c/screen/${token}`);
    expect(closed).toContain("<h1>Your application is with the hiring team</h1>");
    expect(closed).toContain("It went to the hiring team at Visit Dental without the conversation.");
    expect((await screenOf(token)).status).toBe("declined_by_candidate");
    // the choice page of a closed conversation sends back to it
    expect((await app.request(`/c/screen/${token}/person`)).headers.get("location")).toBe(`/c/screen/${token}`);
  });

  let luisToken = "";

  it("E2: Do this later emails the link to the address on file, keeps the place, and says so", async () => {
    luisToken = await tokenOf(await apply({ first: "Luis", last: "Ortega", email: "luis.ortega@example.com" }));
    const r = await post(`/c/screen/${luisToken}/later`);
    expect(r.headers.get("location")).toBe(`/c/screen/${luisToken}/later?sent=1`);
    await container.drain();
    const html = await page(`/c/screen/${luisToken}/later?sent=1`);
    expect(html).toContain("<h1>Your link is on its way</h1>");
    expect(html).toContain("It went to the email address on your application.");
    expect(html).toContain(`<a href="/c/screen/${luisToken}">Start now instead</a>`);
    const sent = mail().filter((m) => m.to === "luis.ortega@example.com" && /for when you are ready/.test(m.subject));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`https://jobs.example.test/c/screen/${luisToken}`);
    // the message page is only for someone who pressed the button
    expect((await app.request(`/c/screen/${luisToken}/later`)).headers.get("location")).toBe(`/c/screen/${luisToken}`);
    expect((await screenOf(luisToken)).status).toBe("invited");
  });

  it("E5, E4: a paused conversation says so and keeps a person one click away; one closed unfinished says what happened to the answers", async () => {
    const scr = await screenOf(luisToken);
    await container.db.update(screens).set({ status: "paused" }).where(eq(screens.id, scr.id));
    let html = await page(`/c/screen/${luisToken}`);
    expect(html).toContain("<h1>The conversation is paused</h1>");
    expect(html).toContain("Sorry, Visit Dental's AI assistant has stopped working for the moment. Your answers so far are saved.");
    expect(html).toContain("We will email you a link to finish as soon as it is working again");
    expect(html).toContain(`<a href="/c/screen/${luisToken}/person">Talk to a person instead</a>`);
    expect((await app.request(`/c/screen/${luisToken}/person`)).status).toBe(200);
    // the status page says it too, without a link; the screening chat is still where they are on the progress line
    const status = await page(`/c/status/${await statusTokenFor(container, { roleId, email: "luis.ortega@example.com" })}`);
    expect(status).toContain("<h2>What happens next</h2><p>Your AI interview is paused while we fix a problem on our end.");
    expect(status).not.toMatch(/<a class="btn" href="\/c\/screen\//);
    expect(status).toContain('<li class="current" aria-current="step"><span class="dot" aria-hidden="true"></span><span>AI interview</span></li>');
    await container.db.update(screens).set({ status: "unfinished" }).where(eq(screens.id, scr.id));
    html = await page(`/c/screen/${luisToken}`);
    expect(html).toContain("<h1>This conversation has closed</h1>");
    // what they never sent stays theirs (founder decision of 9 October 2026); the application carries on without it
    expect(html).toContain("Your application has gone to the hiring team at Visit Dental and carries on; the answers you did not send were not passed on.");
    expect(html).not.toContain("What you said has gone to the hiring team");
    expect((await app.request(`/c/screen/${luisToken}/person`)).headers.get("location")).toBe(`/c/screen/${luisToken}`);
  });

  it("E7: an eligibility answer that does not match gets the neutral receipt, no conversation, and Review on the status page", async () => {
    const r = await apply({ first: "Sam", last: "Nguyen", email: "sam.nguyen@example.com", eligibility: "no" });
    expect(r.headers.get("location")).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
    const receipt = await page(r.headers.get("location")!, { cookie: (r.headers.get("set-cookie") ?? "").match(/ros_applied=[^;,]+/)![0] });
    expect(receipt).toContain("<h1>Thanks for applying</h1>");
    expect(receipt).toContain("The hiring team at Visit Dental reviews your application. People make every decision.");
    expect(receipt).not.toMatch(/eligib|conversation|did not match/i);
    // "No email?" and sending the link again, one click away (founder brief, 14 October 2026)
    expect(receipt).toMatch(/<details class="more"><summary>No email\?<\/summary><p>It can take a few minutes\.[^<]*<\/p><p>[^<]*<\/p><a class="btn secondary" href="\/c\/link-request">Send my link again<\/a><\/details>/);
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, "sam.nguyen@example.com"));
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, cand.id)));
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, a.id))).toHaveLength(0);
    // the status page: Review is where they are, and nothing hints at a chat they were not offered
    const status = await page(`/c/status/${a.statusToken}`);
    const track = status.slice(status.indexOf('<ol class="track"'), status.indexOf("</ol>", status.indexOf('<ol class="track"')));
    expect(track).toContain('<li class="current" aria-current="step"><span class="dot" aria-hidden="true"></span><span>Review</span></li>');
    expect(track).not.toContain("AI interview");
    expect(status).toMatch(/<span>Status<\/span><strong>Review<\/strong>/);
    expect(status).not.toContain("Your AI interview link");
    // R20-10: the one email is the neutral thank-you, without the AI interview's link
    const toSam = mail().filter((m) => m.to === "sam.nguyen@example.com");
    expect(toSam).toHaveLength(1);
    expect(toSam[0].text).not.toContain("/c/screen/");
  });

  it("Q17, R20-11: with the month's AI interviews used up the page says plainly that the link comes by email, with no loader", async () => {
    const [ent] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "text_screens")));
    await container.db.update(entitlements).set({ limit: 5, used: 5 }).where(eq(entitlements.id, ent.id));
    try {
      const r = await apply({ first: "Rosa", last: "Diaz", email: "rosa.diaz@example.com" });
      expect(r.headers.get("location")).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
      const receipt = await page(r.headers.get("location")!, { cookie: (r.headers.get("set-cookie") ?? "").match(/ros_applied=[^;,]+/)![0] });
      expect(receipt).toContain(`<li>Your next step is a short AI interview with Visit Dental's AI assistant, about ${packet.screening.maxMinutes} minutes. We email you its link as soon as it is ready. You can skip any question, or ask for a person instead.</li>`);
      expect(receipt).not.toContain('class="loader"');
      // her status page says the same while she waits
      const status = await page(`/c/status/${await statusTokenFor(container, { roleId, email: "rosa.diaz@example.com" })}`);
      expect(status).toContain("Your AI interview link follows by email as soon as it is ready.");
    } finally {
      await container.db.update(entitlements).set({ limit: ent.limit, used: ent.used }).where(eq(entitlements.id, ent.id));
    }
  });

  it("Q14 kept in full (21 Oct 2026): a repeat submission gets the same waiting room, which opens a detached AI interview about as long as a reading takes later, never the application's own; the address on file hears by email", async () => {
    const first = await tokenOf(await apply({ first: "Kai", last: "Lee", email: "kai.lee@example.com" }));
    const again = await apply({ first: "Kai", last: "Lee", email: "KAI.LEE@example.com" });
    expect(again.headers.get("location")).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
    const receiptCookie = (again.headers.get("set-cookie") ?? "").match(/ros_applied=[^;,]+/)![0];
    const receipt = await page(again.headers.get("location")!, { cookie: receiptCookie });
    expect(receipt).toContain("preparing your AI interview…");
    expect(receipt).toContain('name="grant"');
    expect(receipt).not.toContain("/c/screen/");
    expect(receipt).not.toContain(first);
    const [kai] = await container.db.select().from(candidates).where(eq(candidates.email, "kai.lee@example.com"));
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.candidateId, kai.id)));
    // a copy made for this visit, greeting the name typed; the application's own interview is untouched
    const copies = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.applicationId, a.id));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ firstName: "Kai", status: "invited", confirmation: null });
    expect(copies[0].token).not.toBe(first);
    const opened = await pastTheWait(() => app.request(again.headers.get("location")!, { headers: { cookie: receiptCookie } }));
    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toBe(`/c/screen/${copies[0].token}`);
    expect((await screenOf(first)).status).toBe("invited");
    // the address on file gets its own link, as before (at most once a day)
    expect(mail().filter((m) => m.to === "kai.lee@example.com" && /^Your application for /.test(m.subject))).toHaveLength(1);
  });

  it("polish list, Wave S7: the chat is one thread holding the candidate's own answers, typed or tapped, beside the assistant's lines, in order; email wording reads as the page's own way to a person", async () => {
    const token = await tokenOf(await apply({ first: "Ina", last: "Park", email: "ina.park@example.com" }));
    await post(`/c/screen/${token}/start`);
    const typed = "At Smile Bright I see nine patients a day and chart every visit in Dentrix; 6 years so far.";
    // answer two questions: a tap where the page offers one, words otherwise
    const answered: string[] = [];
    for (let i = 0; i < 2; i++) {
      const html = await page(`/c/screen/${token}`);
      const key = keyOf(html)!;
      answered.push(question(key).question);
      if (html.includes('<input type="hidden" name="tap" value="yes_no"/>')) await post(`/c/screen/${token}`, { tap: "yes_no", choice: "yes" });
      else await post(`/c/screen/${token}`, { message: typed });
    }
    const html = await page(`/c/screen/${token}`);
    const at = html.indexOf('<ol class="thread" aria-label="Your chat">');
    const thread = html.slice(at, html.indexOf("</ol>", at));
    expect(at).toBeGreaterThan(0);
    // both questions asked (on the left) and both answers (on the right, in the candidate's own words), in order
    const mine = [...thread.matchAll(/<li class="msg candidate"><span class="sr-only">You said: <\/span>([^<]*)<\/li>/g)].map((m) => m[1]);
    expect(mine).toHaveLength(2);
    expect(mine).toEqual(expect.arrayContaining([typed]));
    for (const q of answered) expect(thread).toMatch(new RegExp(`<li class="msg assistant"><span class="sr-only">The assistant said: </span>[^<]*${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(thread.indexOf(answered[0])).toBeLessThan(thread.indexOf(mine[0]));
    expect(thread.indexOf(mine[0])).toBeLessThan(thread.indexOf(answered[1]));
    expect(thread.indexOf(answered[1])).toBeLessThan(thread.indexOf(mine[1]));
    // every message is one restatement and one question
    for (const m of thread.matchAll(/<li class="msg assistant[^"]*"[^>]*><span class="sr-only">The assistant said: <\/span>([^<]*)<\/li>/g)) expect((m[1].match(/\?/g) ?? []).length, m[1]).toBeLessThanOrEqual(1);

    // a line the assistant wrote for email or text ("Reply HUMAN…") reads as the button on this page, and by email once it closed; the transcript keeps its words
    const scr = await screenOf(token);
    const first = scr.transcript.findIndex((t) => t.role === "assistant");
    const transcript = scr.transcript.map((t, i) => (i === first ? { ...t, content: `Hi Ina, this is the hiring team. Reply HUMAN at any time to reach a person.\n\n${t.content}` } : t));
    await container.db.update(screens).set({ transcript }).where(eq(screens.id, scr.id));
    let open = await page(`/c/screen/${token}`);
    expect(open).toContain('Hi Ina, this is the hiring team. Press "I\'d rather talk to a person" at any time.');
    expect(open).not.toContain("Reply HUMAN");
    await container.db.update(screens).set({ status: "completed" }).where(eq(screens.id, scr.id));
    open = await page(`/c/screen/${token}`);
    expect(open).toContain("<summary>See the conversation</summary>");
    expect(open).toContain("Hi Ina, this is the hiring team. To reach a person, reply to any of our emails.");
    expect(open).not.toContain("Reply HUMAN");
    expect((await screenOf(token)).transcript[first].content).toContain("Reply HUMAN at any time to reach a person.");
  });

  it("the conversation pages need no script: every action is a plain form or link, and the one script only stops a second press", async () => {
    const token = await tokenOf(await apply({ first: "Wes", last: "Lund", email: "wes.lund@example.com" }));
    for (const path of [`/c/screen/${token}`, `/c/screen/${token}/person`]) {
      const html = await page(path);
      expect(scriptsOf(html), path).toEqual([SCREEN_BUSY_JS]);
      expect(html, path).not.toMatch(/ on[a-z]+="/);
      for (const m of html.matchAll(/<form\b([^>]*)>/g)) expect(m[1], path).toContain('method="post"');
    }
    await post(`/c/screen/${token}/start`);
    const html = await page(`/c/screen/${token}`);
    expect(scriptsOf(html)).toEqual([SCREEN_BUSY_JS]);
    // the line that says an answer is on its way is there, empty, before anything is pressed (with what it will say)
    expect(html).toContain(`<p class="sending" id="sending" role="status" data-wait="${CHAT_BUSY_NOTE}"></p>`);
    expect(html).not.toMatch(/ style="/);
    // the chat's end works without script too: "Review and send" is a plain form
    await answerAll(token);
    const end = await page(`/c/screen/${token}`);
    expect(scriptsOf(end)).toEqual([SCREEN_BUSY_JS]);
    expect(end).not.toMatch(/ on[a-z]+="/);
    for (const m of end.matchAll(/<form\b([^>]*)>/g)) expect(m[1]).toContain('method="post"');
  });
});
