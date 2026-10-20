import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { ApplicationStage, ToldState } from "@ros/contracts";
import { applications, candidates, communications, withTenant } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { PROGRESS_STEP_LABEL, chatCounts, progressLine } from "./pages/candidate";
import { THREAD_LIMIT, ownWords, wordingOfTemplate } from "./pages/thread";
import { PERSON_BY_EMAIL, PERSON_ON_THE_WEB, forTheWeb } from "./pages/web-wording";
import { statusTokenFor } from "./test-helpers";

/**
 * The candidate's side of telling them (plan Wave G, G6 and G7; founder decisions B6, Q29, Q30): the status page reads
 * as a conversation, every message that reached them and their own replies, oldest first, with no reply box (the link
 * never expires); a decision shows only once they were told, in the words of the message that told it; "Offer made"
 * never claims the page or our emails carry the offer; and "Don't keep me for future roles", which the decision and
 * closing messages point to, lands at the choice and says it was saved.
 */
describe("the words a page uses: email lines on the web, quoted replies, the wording of a decision", () => {
  it("drops the lines written for an email or a text, putting the page's own way to a person in place of the first", () => {
    expect(forTheWeb("Reply HUMAN at any time and a person from our team will follow up.")).toBe("");
    expect(forTheWeb("This message was sent by the hiring team at Harbor Dental with help from an AI recruiting assistant. Reply HUMAN at any time to reach a person.")).toBe("");
    // what else the company wrote is kept
    expect(forTheWeb("Settings Dental uses software with artificial intelligence to organize applications. People make every hiring decision. Reply HUMAN at any time to reach a person.")).toBe("Settings Dental uses software with artificial intelligence to organize applications. People make every hiring decision.");
    // in the assistant's own lines, once, keeping the line breaks
    expect(forTheWeb("Hi Ana, this is the hiring team at Harbor Dental (about 10 minutes). Reply HUMAN at any time to reach a person.\n\nFirst question: Are you licensed?", PERSON_ON_THE_WEB)).toBe(`Hi Ana, this is the hiring team at Harbor Dental (about 10 minutes). ${PERSON_ON_THE_WEB}\n\nFirst question: Are you licensed?`);
    expect(forTheWeb("Thanks, that is everything I needed. Reply HUMAN at any time to reach a person.", PERSON_BY_EMAIL)).toBe(`Thanks, that is everything I needed. ${PERSON_BY_EMAIL}`);
    expect(forTheWeb("Reply STOP to opt out. Thanks.")).toBe("Thanks.");
    // a sentence that only mentions a person, without the keyword, stays
    expect(forTheWeb("You can ask for a person at any time.")).toBe("You can ask for a person at any time.");
  });

  it("keeps the candidate's own words of a reply and leaves out what their email program quoted under it", () => {
    expect(ownWords("Tuesday works for me.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Look Dental <hello@look.test> wrote:\n> Here are some times.")).toBe("Tuesday works for me.");
    expect(ownWords("Tuesday works.\r\nOn Mon, Oct 5, 2026 at 9:00 AM Look Dental\r\n<hello@look.test> wrote:\r\n> times")).toBe("Tuesday works.");
    expect(ownWords("Yes please.\n\n-----Original Message-----\nFrom: Look Dental")).toBe("Yes please.");
    expect(ownWords("Thanks!\n\nFrom: Look Dental <hello@look.test>\nSent: Monday, October 5, 2026 9:00 AM\nSubject: Times")).toBe("Thanks!");
    expect(ownWords("> only quoted")).toBe("> only quoted");
  });

  it("the progress line (Wave S2, K4): Applied, the AI interview only where there is one, Review, Interview, Decision; the current step read off the candidate's step", () => {
    const line = (input: Parameters<typeof progressLine>[0]) => { const p = progressLine(input); return `${p.steps.map((s) => (s === p.current ? `[${PROGRESS_STEP_LABEL[s]}]` : PROGRESS_STEP_LABEL[s])).join(" > ")}`; };
    const base = { hasChat: false, chatOpen: false, hadInterview: false };
    expect(line({ ...base, step: "received" })).toBe("[Applied] > Review > Interview > Decision");
    expect(line({ ...base, step: "under_review" })).toBe("Applied > [Review] > Interview > Decision");
    // a chat they have, open or paused, is where they are; once it closed the team reviews
    expect(line({ ...base, step: "under_review", hasChat: true, chatOpen: true })).toBe("Applied > [AI interview] > Review > Interview > Decision");
    expect(line({ ...base, step: "under_review", hasChat: true })).toBe("Applied > AI interview > [Review] > Interview > Decision");
    expect(line({ ...base, step: "received", hasChat: true, chatOpen: true })).toBe("[Applied] > AI interview > Review > Interview > Decision");
    expect(line({ ...base, step: "interview", hasChat: true })).toBe("Applied > AI interview > Review > [Interview] > Decision");
    // at the decision the interview is on the line only when there was one
    expect(line({ ...base, step: "decision" })).toBe("Applied > Review > [Decision]");
    expect(line({ ...base, step: "decision", hasChat: true, hadInterview: true })).toBe("Applied > AI interview > Review > Interview > [Decision]");
    expect(line({ ...base, step: "interview" })).toBe("Applied > Review > [Interview] > Decision");
  });

  it("ticks the screening chat only when it really happened: never for one skipped, expired unanswered, cancelled before it started, or handed to a person", () => {
    expect(chatCounts(null, false)).toBe(false);
    expect(chatCounts({ status: "invited", startedAt: null }, true)).toBe(true);
    expect(chatCounts({ status: "paused", startedAt: new Date() }, true)).toBe(true);
    expect(chatCounts({ status: "completed", startedAt: new Date() }, false)).toBe(true);
    expect(chatCounts({ status: "unfinished", startedAt: new Date() }, false)).toBe(true);
    expect(chatCounts({ status: "declined_by_candidate", startedAt: null }, false)).toBe(false);
    expect(chatCounts({ status: "declined_by_candidate", startedAt: new Date() }, false)).toBe(false);
    expect(chatCounts({ status: "expired", startedAt: null }, false)).toBe(false);
    expect(chatCounts({ status: "cancelled", startedAt: null }, false)).toBe(false);
    expect(chatCounts({ status: "human_requested", startedAt: new Date() }, false)).toBe(false);
    // a skipped chat leaves the step off the line, so nothing is ticked as done
    const p = progressLine({ step: "under_review", hasChat: chatCounts({ status: "declined_by_candidate", startedAt: null }, false), chatOpen: false, hadInterview: false });
    expect(p.steps).toEqual(["applied", "review", "interview", "decision"]);
  });

  it("reads which approved wording told a decision from the message's template", () => {
    expect(wordingOfTemplate("disposition:human")).toBe("v1");
    expect(wordingOfTemplate("disposition:human:v2")).toBe("v2");
    expect(wordingOfTemplate("disposition:position_filled")).toBe("position_filled");
    expect(wordingOfTemplate("disposition:role_closed")).toBe("role_closed");
    expect(wordingOfTemplate("disposition:eligibility")).toBe("eligibility");
    expect(wordingOfTemplate("disposition:something_older")).toBe("v1");
    expect(wordingOfTemplate("acknowledgment")).toBeNull();
    expect(wordingOfTemplate(null)).toBeNull();
  });
});

describe("the candidate's status page: the conversation, the decision in its own words, the offer, future roles", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let eligibility: Array<{ key: string }> = [];

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body ? JSON.stringify(body) : undefined });
  const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const page = async (path: string) => {
    const r = await app.request(path);
    expect(r.status, path).toBe(200);
    return decode(await r.text());
  };
  const form = (path: string, fields: Record<string, string>) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

  async function applyAs(first: string, email: string) {
    const fd = new FormData();
    fd.set("firstName", first); fd.set("lastName", "Tester"); fd.set("email", email); fd.set("locationText", "Irvine, CA");
    fd.set("resume", new File([`${first} Tester, RDH\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present`], "resume.txt", { type: "text/plain" }));
    for (const rule of eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("acknowledged", "yes");
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd })).status).toBe(302);
    await container.drain();
    const token = await statusTokenFor(container, { roleId, email });
    const [a] = await container.db.select().from(applications).where(eq(applications.statusToken, token));
    return a;
  }
  /** A message in the application's thread, written the way the outbox and the reply webhook write theirs. */
  const message = (a: typeof applications.$inferSelect, m: { direction: "outbound" | "inbound"; channel?: string; subject?: string | null; text: string; status: string; templateKey?: string | null; createdAt: string }) =>
    withTenant(container.db, companyId, (tx) => tx.insert(communications).values({ companyId, candidateId: a.candidateId, applicationId: a.id, direction: m.direction, channel: m.channel ?? "email", subject: m.subject ?? null, bodyText: m.text, templateKey: m.templateKey ?? null, status: m.status, sentBy: m.direction === "inbound" ? { kind: "candidate", id: a.candidateId } : { kind: "system", id: "test" }, createdAt: m.createdAt }));
  /** A decision as the team records it, told (or not) the candidate. */
  const decide = (a: typeof applications.$inferSelect, stage: ApplicationStage, toldState: ToldState) => container.db.update(applications).set({ stage, toldState, stageChangedAt: at(-60), rejectedAt: stage === "rejected" ? at(-60) : null }).where(eq(applications.id, a.id));

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", JOBS_BASE_URL: "https://jobs.example.test", SMS_ENABLED: "false" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@thread.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Thread Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    slug = co.slug;
    const s = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json("POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    eligibility = ((await (await json("GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } }).currentPacket.packet.requirements.eligibility;
  });
  afterAll(async () => {
    await container.close();
  });

  it("G7: the messages that reached the candidate and their own replies, oldest first; nothing still waiting, withdrawn, bounced or from the screening conversation; no reply box", async () => {
    const a = await applyAs("Nora", "nora.tester@example.com");
    await message(a, { direction: "outbound", subject: "Interview times at Thread Dental", text: "Here are three times for your interview.", status: "sent", createdAt: at(10) });
    await message(a, { direction: "inbound", text: "Tuesday at 10 works for me.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Thread Dental <hello@thread.test> wrote:\n> Here are three times for your interview.", status: "received", createdAt: at(20) });
    await message(a, { direction: "outbound", subject: "Still in the outbox", text: "not sent yet", status: "queued", createdAt: at(30) });
    await message(a, { direction: "outbound", subject: "Taken back with Undo", text: "withdrawn", status: "cancelled", createdAt: at(31) });
    await message(a, { direction: "outbound", subject: "Never arrived", text: "bounced", status: "bounced", createdAt: at(32) });
    await message(a, { direction: "inbound", channel: "web", text: "An answer typed in the screening conversation", status: "received", createdAt: at(33) });
    await message(a, { direction: "inbound", channel: "sms", text: "Running five minutes late", status: "received", createdAt: at(40) });
    await message(a, { direction: "outbound", subject: "See you Tuesday", text: "Thanks Nora, see you then.", status: "delivered", createdAt: at(50) });
    const html = await page(`/c/status/${a.statusToken}`);
    expect(html).toContain('<h2 id="messages">Messages about your application</h2>');
    expect(html).toContain("What we sent you and what you wrote back, oldest first. To write to the team, reply to any of our emails.");
    const thread = html.slice(html.indexOf('<ol class="thread">'), html.indexOf("</ol>", html.indexOf('<ol class="thread">')));
    // the acknowledgment first, then the conversation in the order it happened
    const order = ["Thank you for applying: your next step", "Interview times at Thread Dental", "Tuesday at 10 works for me.", "Running five minutes late", "See you Tuesday"].map((t) => thread.indexOf(t));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    // the team's on the left with the company's name and the subject, the candidate's own on the right, said in words too
    expect(thread).toMatch(/<li class="msg team"><p class="msg-head">Thread Dental<span aria-hidden="true"> · <\/span><span class="sr-only">, <\/span><time datetime="[^"]+">[^<]+<\/time><\/p><p class="msg-subject">Interview times at Thread Dental<\/p><p class="msg-body">Here are three times for your interview.<\/p><\/li>/);
    expect(thread).toMatch(/<li class="msg candidate"><p class="msg-head">You<span aria-hidden="true"> · <\/span><span class="sr-only">, <\/span><time datetime="[^"]+">[^<]+<\/time><\/p><p class="msg-body">Tuesday at 10 works for me.<\/p><\/li>/);
    expect(thread).toContain('<p class="msg-head">You (text message)');
    // their own words only: the quoted email below them is left out
    expect(thread).not.toContain("wrote:");
    // never a message that did not reach them, nor the screening answers (they have their own page)
    for (const hidden of ["Still in the outbox", "Taken back with Undo", "Never arrived", "An answer typed in the screening conversation"]) expect(html).not.toContain(hidden);
    // no reply box: the only text box is the privacy request's
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).toContain('<textarea id="pd" name="details"');
  });

  it(`G7: a long conversation shows the latest ${THREAD_LIMIT} messages and says so`, async () => {
    const a = await applyAs("Omar", "omar.tester@example.com");
    for (let i = 1; i <= THREAD_LIMIT; i++) await message(a, { direction: "outbound", subject: `Update number ${i}`, text: `Update ${i}.`, status: "sent", createdAt: at(10 + i) });
    const html = await page(`/c/status/${a.statusToken}`);
    expect(html).toContain(`oldest first; the latest ${THREAD_LIMIT} are shown.`);
    expect(html).not.toContain("Thank you for applying");
    expect(html).toContain("Update number 1<");
    expect(html).toContain(`Update number ${THREAD_LIMIT}<`);
  });

  it("G6, B6: a decision shows only once they were told, in the words of the message that told it; a decision told in person reads the standard way", async () => {
    const a = await applyAs("Pia", "pia.tester@example.com");
    const line = async () => {
      const html = await page(`/c/status/${a.statusToken}`);
      return html.slice(html.indexOf("<h2>What happens next</h2>"), html.indexOf('<p class="meta">People on the hiring team'));
    };
    // decided, not told: nothing about it
    await decide(a, "rejected", "not_told");
    expect(await line()).not.toMatch(/position|did not work out|not moving forward|future openings/);
    await message(a, { direction: "outbound", subject: "Your application to Thread Dental", text: "The position has now been filled.", status: "sent", templateKey: "disposition:position_filled", createdAt: at(5) });
    const wordingIs = (key: string) => container.db.update(communications).set({ templateKey: key }).where(and(eq(communications.applicationId, a.id), like(communications.templateKey, "disposition:%")));
    await decide(a, "rejected", "sent");
    expect(await line()).toContain("The position has been filled, so your application for this role will not go any further. Thank you for applying. We will keep you in mind for future openings unless you ask us not to.");
    await wordingIs("disposition:after_interview");
    expect(await line()).toContain("Thank you for meeting the team. They have decided not to move forward with your application for this role.");
    await wordingIs("disposition:eligibility");
    expect(await line()).toContain("Based on your answers to the eligibility questions, this role needs something you said you do not have right now. If that has changed, or you answered in error, reply to our email and a person will take a look.");
    await wordingIs("disposition:human:v2");
    expect(await line()).toContain("Thank you for applying. This role did not work out, and we will keep you in mind for future openings unless you ask us not to.");
    // the closing message of a closed role (Q30): they stay in the talent pool
    await wordingIs("disposition:role_closed");
    await decide(a, "talent_pool", "sent");
    expect(await line()).toContain("Thread Dental has closed this position, so your application for it will not go any further. We are keeping you in mind for future openings.");
    // a message from an earlier decision does not speak for a later one told in person
    await container.db.update(communications).set({ createdAt: at(-3600) }).where(and(eq(communications.applicationId, a.id), like(communications.templateKey, "disposition:%")));
    await decide(a, "rejected", "told_in_person");
    expect(await line()).toContain("Thank you for applying. This role did not work out");
  });

  it("Q29: 'Offer made' is the Decision step, and the page never claims the offer is in our messages", async () => {
    const a = await applyAs("Quinn", "quinn.tester@example.com");
    await container.db.update(applications).set({ stage: "offer_sent", stageChangedAt: at(-60) }).where(eq(applications.id, a.id));
    const html = await page(`/c/status/${a.statusToken}`);
    // the progress line: what is behind them ticked, the decision current; no interview was booked, so none is on the line
    const track = html.slice(html.indexOf('<ol class="track"'), html.indexOf("</ol>", html.indexOf('<ol class="track"')));
    expect(track).toContain('<li class="current" aria-current="step"><span class="dot" aria-hidden="true"></span><span>Decision</span></li>');
    expect(track).toMatch(/<li class="done"><span class="dot" aria-hidden="true"><svg class="icon"[^>]*>.*?<\/svg><\/span><span>Applied<\/span><span class="sr-only"> \(done\)<\/span><\/li>/);
    expect(track).toContain("<span>Review</span><span class=\"sr-only\"> (done)</span>");
    expect(track).not.toContain("Interview");
    expect(track.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain("The team has made you an offer. They will go through it with you directly. If you have a question, reply to any of our emails.");
    expect(html).not.toContain("Check your messages for the offer");
    // an offer is not a decline: nothing about future roles is pressed on them
    expect(html).not.toContain('href="#future-roles"');
  });

  it("Q30: the decision message's link lands at the future-roles choice, and one click there is saved and says so", async () => {
    const a = await applyAs("Rae", "rae.tester@example.com");
    await message(a, { direction: "outbound", subject: "Your application to Thread Dental", text: "Thread Dental has closed this position.", status: "sent", templateKey: "disposition:role_closed", createdAt: at(5) });
    await decide(a, "talent_pool", "sent");
    let html = await page(`/c/status/${a.statusToken}`);
    // the choice has the address the message links to, and the decision points to it
    expect(html).toContain(`<form method="post" action="/c/status/${a.statusToken}/talent-pool" class="card" id="future-roles">`);
    expect(html).toContain('Would you rather we did not keep your details for future roles? <a href="#future-roles">Say so below</a>; it takes one click.');
    expect(html).not.toContain("Saved.");
    const out = await form(`/c/status/${a.statusToken}/talent-pool`, {});
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe(`/c/status/${a.statusToken}?pool=out#future-roles`);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, a.candidateId));
    expect(cand.preferences.talentPoolOptOut).toBe(true);
    html = await page(`/c/status/${a.statusToken}?pool=out`);
    expect(html).toContain('id="future-roles"><p role="status"><strong>Saved.</strong></p><p><strong>Future roles:</strong> you asked us not to keep your details for future roles');
    expect(html).toContain("Thread Dental has closed this position, so your application for it will not go any further. As you asked, nobody will contact you about future openings.");
    // once they said so, the decision no longer points to the choice
    expect(html).not.toContain('href="#future-roles"');
    // the way back is one click too, and lands at the same place
    const back = await form(`/c/status/${a.statusToken}/talent-pool`, { pref: "in" });
    expect(back.headers.get("location")).toBe(`/c/status/${a.statusToken}?pool=in#future-roles`);
    html = await page(`/c/status/${a.statusToken}?pool=in`);
    expect(html).toContain('id="future-roles"><p role="status"><strong>Saved.</strong></p><p><strong>Future roles:</strong> Thread Dental may keep your details');
    // a "saved" in the address that does not match what is saved says nothing
    expect(await page(`/c/status/${a.statusToken}?pool=out`)).not.toContain("Saved.");
  });
});
