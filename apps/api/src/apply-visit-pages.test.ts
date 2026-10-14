import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { RolePacket } from "@ros/contracts";
import { aiRuns, applications, candidates, entitlements, notifications, screens, unconfirmedScreens } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { SCREEN_BUSY_JS } from "./pages/candidate";
import { statusTokenFor, useOneVisitApplyFlow } from "./test-helpers";

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
  const keyOf = (html: string) => packet.screening.questions.find((q) => html.includes(`<h1 class="question" id="question">${q.question}</h1>`))?.key ?? null;

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
  const tokenOf = (r: Response) => {
    const to = r.headers.get("location") ?? "";
    expect(to).toMatch(/^\/c\/screen\/[A-Za-z0-9_-]+$/);
    return to.slice("/c/screen/".length);
  };

  /** Answers every question over HTTP: taps where the page offers them, a skip where asked, words otherwise; ends on "check your answers". */
  async function answerAll(token: string, skip: string[] = []) {
    for (let i = 0; i < 24; i++) {
      const html = await page(`/c/screen/${token}`);
      if (html.includes("<h1>Check your answers</h1>")) return html;
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
    throw new Error("the conversation did not reach check your answers");
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
    mariaToken = tokenOf(r);
    expect(await screenOf(mariaToken)).toMatchObject({ invitedVia: "apply", channel: "web", status: "invited" });
    const applied = (r.headers.get("set-cookie") ?? "").match(/ros_applied_to=[^;,]+/)![0];
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
  });

  it("E2, E12, E14: Start shows the first question at once in large type, with Yes and No to tap, the own-words box labelled with the question, and the quiet skip; a tap is recorded word for word", async () => {
    expect((await post(`/c/screen/${mariaToken}/start`)).headers.get("location")).toBe(`/c/screen/${mariaToken}`);
    const q1 = question("license_confirm");
    let html = await page(`/c/screen/${mariaToken}`);
    expect(html).toContain(`<h1 class="question" id="question">${q1.question}</h1>`);
    expect(html).toContain(`<label for="progress">Question 1 of ${packet.screening.questions.length}</label>`);
    expect(html).toContain(`<input type="hidden" name="tap" value="yes_no"/><fieldset class="actions" aria-label="Your answer to: ${q1.question}"><button class="btn secondary" type="submit" name="choice" value="yes">Yes</button><button class="btn secondary" type="submit" name="choice" value="no">No</button><button class="link-action" type="submit" name="action" value="skip" formnovalidate="">Skip this question</button></fieldset>`);
    expect(html).toContain("<summary>Answer in your own words instead</summary>");
    expect(html).toContain(`<label for="message">Your answer<span class="sr-only"> to: ${q1.question}</span></label>`);
    expect(html).toContain(`<a class="link-action" href="/c/screen/${mariaToken}/person">I'd rather talk to a person</a>`);
    expect(html).toContain(`<form method="post" action="/c/screen/${mariaToken}/later"><button class="link-action" type="submit">Finish later: email me the link</button></form>`);
    // a second press of Start changes nothing
    await post(`/c/screen/${mariaToken}/start`);
    expect((await screenOf(mariaToken)).transcript.filter((t) => t.role === "assistant")).toHaveLength(1);
    // the tap: recorded as fixed words, and the next question follows in the packet's words
    expect((await post(`/c/screen/${mariaToken}`, { tap: "yes_no", choice: "yes" })).headers.get("location")).toBe(`/c/screen/${mariaToken}`);
    const scr = await screenOf(mariaToken);
    expect(scr.answers[q1.key]).toBe("Yes");
    expect(scr.transcript.find((t) => t.source === "tap")).toMatchObject({ role: "candidate", content: "Yes", questionKey: q1.key });
    html = await page(`/c/screen/${mariaToken}`);
    expect(html).toContain('<p class="lead-in"><span class="sr-only">The assistant said: </span>Thanks.</p>');
    expect(html).toContain(`<label for="progress">Question 2 of ${packet.screening.questions.length}</label>`);
    // the first question and Maria's own answer are folded away above the second
    const earlier = html.slice(html.indexOf('<details class="earlier">'), html.indexOf("</details>"));
    expect(earlier).toContain(q1.question);
    expect(earlier).toContain('<li class="msg candidate"><span class="sr-only">You said: </span>Yes</li>');
  });

  it("E11, E12: an empty answer and a tap that does not fit are refused plainly; a skip is noted for what it is; the pay range is tapped", async () => {
    expect((await post(`/c/screen/${mariaToken}`, { message: "   " })).headers.get("location")).toBe(`/c/screen/${mariaToken}?error=empty`);
    expect(await page(`/c/screen/${mariaToken}?error=empty`)).toContain('<div class="err" role="alert">Please type an answer first, or press Skip this question.</div>');
    expect((await post(`/c/screen/${mariaToken}`, { tap: "pay_range", min: "" })).headers.get("location")).toBe(`/c/screen/${mariaToken}?error=tap`);
    expect(await page(`/c/screen/${mariaToken}?error=tap`)).toContain("That answer does not fit this question.");
    const review = await answerAll(mariaToken, ["hard_moment"]);
    expect(review).toContain("<h1>Check your answers</h1>");
    const scr = await screenOf(mariaToken);
    expect(scr.progress.declined).toEqual(["hard_moment"]);
    expect(scr.transcript.find((t) => t.source === "skip")).toMatchObject({ role: "system", questionKey: "hard_moment" });
    expect(scr.answers.pay).toBe("I'm looking for $50 to $54 an hour.");
    // nobody on the team has heard yet: she is still applying (E6)
    expect((await container.db.select().from(notifications).where(eq(notifications.companyId, companyId))).filter((n) => n.title.includes("Maria"))).toHaveLength(0);
  });

  it("E10: check your answers lists every answer with Change, marks the skipped one with Answer it, marks a change, and Send ends it; only then does the team hear", async () => {
    const base = `/c/screen/${mariaToken}`;
    let html = await page(base);
    // honest about both things: the team sees the answers only once she sends them, and nothing sends them for her:
    // without Send the conversation closes a few days later and the application goes on without them (founder decision
    // of 9 October 2026, "hide them until they send")
    expect(html).toContain('<p class="lead">The hiring team sees your answers only once you send them. Change any answer you like, then press Send.</p>');
    expect(html).not.toContain("can see your answers as you give them");
    // what happens without Send stays in the page, word for word, one click away (founder brief, 14 October 2026)
    expect(html).toContain("<details class=\"more\"><summary>What if I don't press Send?</summary><p>If you do not press Send, the conversation closes a few days after your last answer or change, and your application goes to the hiring team without these answers. If we have not reminded you yet, we email you once before then.</p></details>");
    expect(html).not.toContain("we send your answers as they are");
    expect(html).not.toContain("Nothing is sent until you do");
    for (const q of packet.screening.questions) expect(html).toContain(`<p class="answer-q">${packet.screening.questions.indexOf(q) + 1}. ${q.question}</p>`);
    const skipped = html.slice(html.indexOf('<li class="answer" id="a-hard_moment">'));
    expect(skipped.slice(0, skipped.indexOf("</li>"))).toContain('<span class="pill">Skipped</span></div><p class="pre">You skipped this question.</p><a href="/c/screen/');
    expect(skipped.slice(0, skipped.indexOf("</li>"))).toContain("Answer it");
    expect(html).toContain(`<form method="post" action="${base}/submit"><button class="btn" type="submit">Send my answers</button></form>`);
    // answer the skipped one, in words
    const edit = await page(`${base}/answers/hard_moment`);
    expect(edit).toContain(`<h1 class="question" id="question">${question("hard_moment").question}</h1>`);
    expect(edit).toContain(`<a href="${base}#a-hard_moment">`);
    const saved = await post(`${base}/answers/hard_moment`, { message: "A nervous patient wanted to stop, so I slowed down and explained each step; she rebooked with me." });
    expect(saved.headers.get("location")).toBe(`${base}?changed=hard_moment#a-hard_moment`);
    // change a tapped one by tapping again
    expect(await page(`${base}/answers/license_confirm`)).toContain('<input type="hidden" name="tap" value="yes_no"/>');
    expect((await post(`${base}/answers/license_confirm`, { tap: "yes_no", choice: "no" })).headers.get("location")).toBe(`${base}?changed=license_confirm#a-license_confirm`);
    html = await page(`${base}?changed=license_confirm`);
    expect(html).toContain('<div class="card" role="status"><strong>Your answer is changed.</strong></div>');
    for (const key of ["hard_moment", "license_confirm"]) {
      const item = html.slice(html.indexOf(`<li class="answer" id="a-${key}">`));
      expect(item.slice(0, item.indexOf("</li>"))).toContain('<span class="pill">Changed</span>');
    }
    expect((await screenOf(mariaToken)).answers.license_confirm).toBe("No");
    // an unknown question is not found; an empty change says so
    expect((await app.request(`${base}/answers/not_a_question`)).status).toBe(404);
    expect((await post(`${base}/answers/why`, { message: "" })).headers.get("location")).toBe(`${base}/answers/why?error=empty`);
    // Send: the conversation is complete, the scorecard follows, and the team hears now
    expect((await post(`${base}/submit`)).headers.get("location")).toBe(base);
    await container.drain();
    html = await page(base);
    expect(html).toContain("<h1>Thanks, your answers are sent</h1>");
    expect(html).toContain("The hiring team at Visit Dental reads them with your application.");
    expect(html).not.toContain("<textarea");
    expect((await screenOf(mariaToken)).status).toBe("completed");
    expect((await container.db.select().from(notifications).where(eq(notifications.companyId, companyId))).some((n) => n.title.includes("Maria") || n.body.includes("Maria"))).toBe(true);
    // a finished conversation is not changed any more
    expect((await app.request(`${base}/answers/why`)).headers.get("location")).toBe(base);
  });

  it("E3, Q16: 'I'd rather talk to a person' offers two equal choices; sending without the conversation says so and closes it", async () => {
    const token = tokenOf(await apply({ first: "Ana", last: "Silva", email: "ana.silva@example.com" }));
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
    luisToken = tokenOf(await apply({ first: "Luis", last: "Ortega", email: "luis.ortega@example.com" }));
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
    // the status page says it too, without a link
    const status = await page(`/c/status/${await statusTokenFor(container, { roleId, email: "luis.ortega@example.com" })}`);
    expect(status).toContain("Your screening conversation is paused while we fix a problem on our end.");
    expect(status).not.toMatch(/<a class="btn" href="\/c\/screen\//);
    await container.db.update(screens).set({ status: "unfinished" }).where(eq(screens.id, scr.id));
    html = await page(`/c/screen/${luisToken}`);
    expect(html).toContain("<h1>This conversation has closed</h1>");
    // what they never sent stays theirs (founder decision of 9 October 2026); the application carries on without it
    expect(html).toContain("Your application has gone to the hiring team at Visit Dental and carries on; the answers you did not send were not passed on.");
    expect(html).not.toContain("What you said has gone to the hiring team");
    expect((await app.request(`/c/screen/${luisToken}/person`)).headers.get("location")).toBe(`/c/screen/${luisToken}`);
  });

  it("E7: an eligibility answer that does not match gets the neutral receipt, no conversation, and Under review on the status page", async () => {
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
    expect(await page(`/c/status/${a.statusToken}`)).toContain('<li class="current" aria-current="step">Under review</li>');
  });

  it("Q17: with the month's conversations used up the receipt says the conversation's link comes by email", async () => {
    const [ent] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "text_screens")));
    await container.db.update(entitlements).set({ limit: 5, used: 5 }).where(eq(entitlements.id, ent.id));
    try {
      const r = await apply({ first: "Rosa", last: "Diaz", email: "rosa.diaz@example.com" });
      expect(r.headers.get("location")).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
      const receipt = await page(r.headers.get("location")!, { cookie: (r.headers.get("set-cookie") ?? "").match(/ros_applied=[^;,]+/)![0] });
      expect(receipt).toContain(`<li>We email you a link to a short written conversation with Visit Dental's AI assistant (about ${packet.screening.maxMinutes} minutes). Answer it whenever suits you, or ask for a person instead.</li>`);
    } finally {
      await container.db.update(entitlements).set({ limit: ent.limit, used: ent.used }).where(eq(entitlements.id, ent.id));
    }
  });

  it("Q14 x Q15: a repeat submission sees exactly the same pages as a first one, bound to a detached copy; the owner of the address confirms by email, and opening the link changes nothing", async () => {
    const first = tokenOf(await apply({ first: "Kai", last: "Lee", email: "kai.lee@example.com" }));
    const again = await apply({ first: "Kai", last: "Lee", email: "KAI.LEE@example.com" });
    const copy = tokenOf(again);
    expect(copy).not.toBe(first);
    expect((await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.token, copy)))).toHaveLength(1);
    const same = (html: string, token: string) => html.replaceAll(token, "TOKEN").replace(/nonce="[^"]*"/g, "");
    expect(same(await page(`/c/screen/${copy}`), copy)).toBe(same(await page(`/c/screen/${first}`), first));
    // Start on both: the same first question, the same page
    await post(`/c/screen/${first}/start`);
    await post(`/c/screen/${copy}/start`);
    expect(same(await page(`/c/screen/${copy}`), copy)).toBe(same(await page(`/c/screen/${first}`), first));
    // the copy is answered and sent; the address on file is asked to confirm
    await answerAll(copy);
    expect((await post(`/c/screen/${copy}/submit`)).headers.get("location")).toBe(`/c/screen/${copy}`);
    await container.drain();
    expect(await page(`/c/screen/${copy}`)).toContain("<h1>Thanks, your answers are sent</h1>");
    const ask = mail().filter((m) => m.to === "kai.lee@example.com" && /^Please confirm/.test(m.subject)).at(-1)!;
    const raw = ask.text.match(/\/c\/confirm-answers\/([A-Za-z0-9_-]+)/)![1];
    const confirm = await page(`/c/confirm-answers/${raw}`);
    expect(confirm).toContain("<h1>Add these answers to your application?</h1>");
    expect(confirm).toContain(`answered ${packet.screening.questions.length} of the ${packet.screening.questions.length} screening questions`);
    expect(confirm).toContain('<button class="btn" type="submit">Add these answers to my application</button>');
    expect(confirm).toContain("If it was not you, you do not need to do anything");
    expect((await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.token, copy)))[0].confirmation).toBe("sent");
    // Kai's own conversation is under way, so nothing is added, and the page says so
    expect((await post(`/c/confirm-answers/${raw}`)).headers.get("location")).toBe(`/c/confirm-answers/${raw}`);
    expect(await page(`/c/confirm-answers/${raw}`)).toContain("<h1>Nothing was added</h1>");
    expect((await screenOf(first)).status).toBe("in_progress");
    expect((await app.request("/c/confirm-answers/not-a-real-link")).status).toBe(404);
  });

  it("polish list: 'Earlier in the conversation' holds the candidate's own answers, typed or tapped, beside the assistant's lines; email wording reads as the page's own way to a person", async () => {
    const token = tokenOf(await apply({ first: "Ina", last: "Park", email: "ina.park@example.com" }));
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
    const earlier = html.slice(html.indexOf('<details class="earlier">'), html.indexOf("</details>"));
    expect(earlier).toContain('<ol class="thread" aria-label="Earlier questions and your answers">');
    // both questions asked (on the left) and both answers (on the right, in the candidate's own words), in order
    const mine = [...earlier.matchAll(/<li class="msg candidate"><span class="sr-only">You said: <\/span>([^<]*)<\/li>/g)].map((m) => m[1]);
    expect(mine).toHaveLength(2);
    expect(mine).toEqual(expect.arrayContaining([typed]));
    for (const q of answered) expect(earlier).toMatch(new RegExp(`<li class="msg assistant"><span class="sr-only">The assistant said: </span>[^<]*${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(earlier.indexOf(answered[0])).toBeLessThan(earlier.indexOf(mine[0]));
    expect(earlier.indexOf(mine[0])).toBeLessThan(earlier.indexOf(answered[1]));
    expect(earlier.indexOf(answered[1])).toBeLessThan(earlier.indexOf(mine[1]));

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
    const token = tokenOf(await apply({ first: "Wes", last: "Lund", email: "wes.lund@example.com" }));
    for (const path of [`/c/screen/${token}`, `/c/screen/${token}/person`]) {
      const html = await page(path);
      expect(scriptsOf(html), path).toEqual([SCREEN_BUSY_JS]);
      expect(html, path).not.toMatch(/ on[a-z]+="/);
      for (const m of html.matchAll(/<form\b([^>]*)>/g)) expect(m[1], path).toContain('method="post"');
    }
    await post(`/c/screen/${token}/start`);
    const html = await page(`/c/screen/${token}`);
    expect(scriptsOf(html)).toEqual([SCREEN_BUSY_JS]);
    // the line that says an answer is on its way is there, empty, before anything is pressed
    expect(html).toContain('<p class="sending" id="sending" role="status"></p>');
    expect(html).not.toMatch(/ style="/);
  });
});
