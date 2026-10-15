/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { z } from "zod";
import type { LearnedFact, LearnedFactKind } from "@ros/contracts";
import type { Vars } from "../middleware/session";
import { POLICIES, rateLimit } from "../middleware/rate-limit";
import { confirmRepeat, repeatConfirmationView, type RepeatConfirmationView } from "../services/apply-conversation";
import { applicationForStatusToken, changeLearnedFact, learnFromConfirmedRepeat, otherRolesFor, queueReuseLink, queueReuseLinkFor, type OtherRole } from "../services/profile-facts";
import { acceptingApplications, anonymizedFor, linkGone, loadJob } from "./candidate-shared";
import { Layout } from "./layout";

/**
 * What the candidate's company-scoped record knows and reuses (Wave S7, slice S7-F): confirming by email that answers
 * typed with their address are theirs (moved as it was from pages/candidate.tsx), the facts their sent chats taught
 * their record ("What your chats added", shown on the application record, changed or removed there), and reusing their
 * details for another job at the same company ("Use the details I gave before" by email, or "Apply for another role"
 * from the record). Mounted on the candidate pages by pages/candidate.tsx. Everything here works without JavaScript.
 */
const candidatePages = new Hono<Vars>();
export { candidatePages as profilePages };

/* ------------------------------------------------------------------------------------------------------------ */
/* "What your chats added" (spec step 10), drawn on the application record by pages/application-record.tsx       */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * What the application record (pages/application-record.tsx, S7-E) passes to `LearnedFactsSection`. `saved`
 * (optional): the record's `?facts=` after a change here, so the section can say what happened.
 */
export type LearnedFactsSectionProps = { facts: LearnedFact[]; statusToken: string; companyName: string; timeZone: string; saved?: string | null };

const KIND_LABEL: Record<LearnedFactKind, string> = { skill: "Skill", project: "Project", experience: "Experience", logistics: "Getting to work", other: "About you" };

/** What a change on the record did, in the candidate's words (keys are `FactChange` in services/profile-facts.ts). */
const SAVED_LINE: Record<string, { text: string; error?: boolean }> = {
  changed: { text: "Saved. Your applications here keep your new words." },
  removed: { text: "Removed. It is no longer kept with your applications here." },
  empty: { text: "Please type something, or press Remove to take it out.", error: true },
  personal: { text: "Please keep it to your work: details about your age, family, health, religion or nationality are never kept.", error: true },
  missing: { text: "That one was already removed, so nothing changed.", error: true },
};

/** A day as the record shows it ("Oct 15, 2026"), in the company's time zone. */
function factDay(at: string, timeZone: string): string {
  return new Date(at).toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" });
}

/**
 * "What your chats added" on the application record (spec step 10): each fact the candidate said in a chat they sent,
 * "From your chat on <job>, <date>", with a way to change or remove it, and the way to apply for another role at the
 * same company with these details. The facts stay with this company only.
 */
export function LearnedFactsSection(props: LearnedFactsSectionProps) {
  const { facts, statusToken, companyName } = props;
  const saved = props.saved ? SAVED_LINE[props.saved] : undefined;
  const base = `/c/status/${statusToken}`;
  return (
    <section id="learned" aria-labelledby="learned-title">
      <h2 id="learned-title">What your chats added</h2>
      {saved ? <div class={saved.error ? "err" : "card"} role={saved.error ? "alert" : "status"}><p>{saved.text}</p></div> : null}
      {facts.length ? (
        <>
          <p>Things you told us yourself in a chat you sent. {companyName} keeps them with your applications here, never with another company, for you to check. Change or remove any of them.</p>
          <ul class="roles">
            {facts.map((f) => (
              <li class="card">
                <p><strong>{f.text}</strong></p>
                <p class="meta">{KIND_LABEL[f.kind]} · From your chat on {f.from.roleTitle}, {factDay(f.from.at, props.timeZone)}{f.editedAt ? " · changed by you" : ""}</p>
                <details class="more">
                  <summary>Change or remove<span class="sr-only">: {f.text}</span></summary>
                  <form method="post" action={`${base}/facts/${encodeURIComponent(f.id)}`}>
                    <label for={`fact-${f.id}`}>In your own words</label>
                    <textarea id={`fact-${f.id}`} name="text" rows={2} maxlength={200} required>{f.text}</textarea>
                    <div class="actions">
                      <button class="btn secondary" type="submit" name="action" value="change">Save</button>
                      <button class="btn secondary" type="submit" name="action" value="remove" formnovalidate>Remove</button>
                    </div>
                  </form>
                </details>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>Nothing yet. Once you send a chat, the things you tell us about your work (a skill, a project, how you get to work) show here, kept with your applications at {companyName} for you to check.</p>
      )}
      <p><a href={`${base}/apply-another`}>Apply for another role at {companyName} with these details</a></p>
    </section>
  );
}

const FactChangeForm = z.object({ action: z.enum(["change", "remove"]), text: z.string().max(2000).optional() });

/** Changing or removing one fact, from the record's form. The record's private link is the key; the answer is the record again. */
candidatePages.post("/c/status/:token/facts/:id", rateLimit(POLICIES.screen), async (c) => {
  const container = c.get("container");
  const token = c.req.param("token") ?? "";
  const app = await applicationForStatusToken(container.db, token);
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const parsed = FactChangeForm.safeParse({ action: body.action, text: typeof body.text === "string" ? body.text : undefined });
  if (!parsed.success) return c.redirect(`/c/status/${app.statusToken}#learned`, 303);
  const out = await changeLearnedFact(container, { companyId: app.companyId, candidateId: app.candidateId, factId: c.req.param("id") ?? "", action: parsed.data.action, text: parsed.data.text ?? null });
  return c.redirect(`/c/status/${app.statusToken}?facts=${out}#learned`, 303);
});

/* ------------------------------------------------------------------------------------------------------------ */
/* "Apply for another role at <Company> with these details", from the application record                         */
/* ------------------------------------------------------------------------------------------------------------ */

function OtherRolesPage(props: { companyName: string; slug: string | null; roles: OtherRole[]; statusToken: string; sent: boolean }) {
  const { companyName } = props;
  const base = `/c/status/${props.statusToken}/apply-another`;
  return (
    <Layout title={`Apply for another role at ${companyName}`}>
      <p class="back"><a href={`/c/status/${props.statusToken}`}>Back to your application</a></p>
      <p class="eyebrow">{companyName} · Your applications</p>
      <h1>Apply for another role at {companyName}</h1>
      <p class="lead">We email a link to the address on your application. It opens that job's form with your details filled in (your name, contact details, where you are and the summary of your work), for you to check and change. What you told us in your chats stays with your applications here, for you to check. Nothing goes to another company.</p>
      {props.sent ? <div class="card" role="status"><p><strong>Check your email.</strong> The link is on its way to the address on your application. It can take a few minutes; look in your spam or promotions folder too.</p></div> : null}
      {props.roles.length ? (
        <ul class="roles">
          {props.roles.map((r) => (
            <li class="card">
              <p><strong>{r.title}</strong></p>
              <form method="post" action={`${base}/${encodeURIComponent(r.roleId)}`}>
                <button class="btn secondary" type="submit">Email me a link to apply with my details<span class="sr-only"> for {r.title}</span></button>
              </form>
            </li>
          ))}
        </ul>
      ) : (
        <div class="card" role="status"><p>There are no other open roles at {companyName} that you have not applied for right now.</p></div>
      )}
      {props.slug ? <p><a href={`/careers/${props.slug}`}>See every job at {companyName}</a></p> : null}
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
    </Layout>
  );
}

candidatePages.get("/c/status/:token/apply-another", async (c) => {
  const container = c.get("container");
  const app = await applicationForStatusToken(container.db, c.req.param("token"));
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  const view = await otherRolesFor(container, { companyId: app.companyId, candidateId: app.candidateId });
  c.header("Cache-Control", "no-store");
  return c.html(<OtherRolesPage companyName={view.companyName} slug={view.slug} roles={view.roles} statusToken={app.statusToken} sent={c.req.query("sent") === "1"} />);
});

/**
 * "Email me a link to apply with my details" for one of the roles offered: the link goes to the address on file only,
 * never to whoever holds the status link (which may have been forwarded). The page answers the same either way.
 */
candidatePages.post("/c/status/:token/apply-another/:roleId", rateLimit(POLICIES.linkRequest), async (c) => {
  const container = c.get("container");
  const app = await applicationForStatusToken(container.db, c.req.param("token") ?? "");
  if (!app) return c.notFound();
  if (await anonymizedFor(container, app.candidateId)) return linkGone(c);
  if (await queueReuseLinkFor(container, { companyId: app.companyId, candidateId: app.candidateId, roleId: c.req.param("roleId") ?? "" })) await container.kick();
  return c.redirect(`/c/status/${app.statusToken}/apply-another?sent=1`, 303);
});

/* ------------------------------------------------------------------------------------------------------------ */
/* "Applied here before? Use your details" (spec step 3): a link to the address on file, never to the page        */
/* ------------------------------------------------------------------------------------------------------------ */

const ReuseRequestForm = z.object({ email: z.email().max(254) });

function ReuseRequestPage(props: { companyName: string; roleTitle: string; formPath: string; error?: string; email?: string }) {
  return (
    <Layout title={`Use your details for ${props.roleTitle}`}>
      <p class="back"><a href={props.formPath}>Back to the form</a></p>
      <p class="eyebrow">{props.companyName} · {props.roleTitle}</p>
      <h1>Use the details you gave {props.companyName} before</h1>
      <p class="lead">Type the email address you applied with. If {props.companyName} has your details, we email you a link that opens this job's form with them filled in, for you to check. We never show them on this page.</p>
      {props.error ? <div class="err" role="alert">{props.error}</div> : null}
      <form method="post" action={`${props.formPath}/reuse`} class="card">
        <div style="position:absolute;left:-10000px" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" type="text" tabindex={-1} autocomplete="off" /></div>
        <label for="email" class="flush">Your email address</label>
        <input id="email" name="email" type="email" required autocomplete="email" value={props.email ?? ""} />
        <button class="btn" type="submit">Email me the link</button>
      </form>
      <p class="meta">Only what you gave {props.companyName} is used. Nothing is shared with another company.</p>
      <p>Rather not? <a href={props.formPath}>Fill in the form yourself</a>.</p>
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
    </Layout>
  );
}

/** What every request answers, whether or not the address is known: only the mailbox learns that. */
function ReuseRequestSent(props: { companyName: string; roleTitle: string; formPath: string }) {
  return (
    <Layout title="Check your email">
      <p class="eyebrow">{props.companyName} · {props.roleTitle}</p>
      <h1>Check your email</h1>
      <div class="card" role="status">
        <p><strong>If {props.companyName} has your details from before, a link is on its way.</strong></p>
        <p>It opens this job's form with your details filled in. It can take a few minutes; look in your spam or promotions folder too. To protect your privacy, this page looks the same whether or not we found anything.</p>
      </div>
      <p class="foot">Nothing came? You may have applied with a different address. <a href={props.formPath}>Fill in the form yourself</a>.</p>
    </Layout>
  );
}

/** The job named by a public address, while its form takes applications; otherwise the page answers as the form does (404). */
async function openJob(db: Vars["Variables"]["container"]["db"], slug: string, roleId: string) {
  const job = await loadJob(db, slug, roleId);
  return job && acceptingApplications(job.role) ? job : null;
}

candidatePages.get("/careers/:slug/jobs/:roleId/apply/reuse", async (c) => {
  const job = await openJob(c.get("container").db, c.req.param("slug"), c.req.param("roleId"));
  if (!job) return c.notFound();
  const formPath = `/careers/${job.company.slug}/jobs/${job.role.id}/apply`;
  c.header("Cache-Control", "no-store");
  const props = { companyName: job.company.name, roleTitle: job.packet.identity.title, formPath };
  return c.html(c.req.query("sent") === "1" ? <ReuseRequestSent {...props} /> : <ReuseRequestPage {...props} />);
});

candidatePages.post("/careers/:slug/jobs/:roleId/apply/reuse", rateLimit(POLICIES.linkRequest), async (c) => {
  const container = c.get("container");
  const job = await openJob(container.db, c.req.param("slug") ?? "", c.req.param("roleId") ?? "");
  if (!job) return c.notFound();
  const formPath = `/careers/${job.company.slug}/jobs/${job.role.id}/apply`;
  const sent = `${formPath}/reuse?sent=1`;
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
  // the honeypot is answered like everyone else and sends nothing
  if (str("website")) return c.redirect(sent, 303);
  const parsed = ReuseRequestForm.safeParse({ email: str("email").trim() });
  if (!parsed.success) return c.html(<ReuseRequestPage companyName={job.company.name} roleTitle={job.packet.identity.title} formPath={formPath} error="Please check the email address and send it again." email={str("email")} />, 400);
  // One queued job for every address, known or not; the worker looks it up.
  await queueReuseLink(container, { companyId: job.company.id, roleId: job.role.id, email: parsed.data.email });
  await container.kick();
  return c.redirect(sent, 303);
});

/* ------------------------------------------------------------------------------------------------------------ */
/* A repeat submission's answers, confirmed by the owner of the address on file (Q14 x Q15)                       */
/* ------------------------------------------------------------------------------------------------------------ */

/** What the emailed link opens: one button while it can still be used, otherwise what happened. Counts only, never the answers. */
function ConfirmAnswersPage(props: { view: RepeatConfirmationView; token: string }) {
  const { view } = props;
  // A person asked for, or offered because the assistant stopped working part-way (nobody asked): confirming brings one in.
  const person = view.intent === "person" || view.intent === "outage";
  const happened = view.intent === "outage" ? "started the screening questions, but our assistant stopped working before they finished" : person ? "asked for a person from the hiring team to contact them" : `answered ${view.answered} of the ${view.questions} screening questions`;
  const outcome: Record<Exclude<RepeatConfirmationView["state"], "ready">, { title: string; text: string }> = {
    added: { title: "Your answers are added", text: `They are now part of your application for ${view.roleTitle} at ${view.companyName}, and the hiring team reads them with it. Nothing else is needed from you.` },
    person: { title: "A person will be in touch", text: `We have asked the hiring team at ${view.companyName} to contact you about your application for ${view.roleTitle}. Nothing else is needed from you.` },
    not_added: { title: "Nothing was added", text: "Your application already has answers to these questions, or it has moved on, so it stays as it was. Nothing else is needed from you." },
    gone: { title: "This link has expired", text: "It was already used, or more than seven days went by and what was typed was deleted. Nothing was added to your application." },
  };
  const done = view.state === "ready" ? null : outcome[view.state];
  return (
    <Layout title={done ? done.title : "Please confirm"}>
      <p class="eyebrow">{view.companyName} · {view.roleTitle}</p>
      {done ? (
        <>
          <h1>{done.title}</h1>
          <div class="card" role="status"><p>{done.text}</p></div>
        </>
      ) : (
        <>
          <h1>{person ? "Ask a person to contact you?" : "Add these answers to your application?"}</h1>
          <p class="lead">Someone using your email address sent an application for this job and {happened}. Nothing has been added to your application yet.</p>
          <form method="post" action={`/c/confirm-answers/${props.token}`} class="card">
            <p>If that was you, press the button {person ? "and a person will be in touch" : "to add those answers to your application"}.</p>
            <button class="btn" type="submit">{person ? "Yes, ask a person to contact me" : "Add these answers to my application"}</button>
          </form>
          <p>If it was not you, you do not need to do anything: nothing is added, and what was typed is deleted after seven days.</p>
        </>
      )}
      <p class="foot"><a href="/privacy">How we handle your information</a></p>
    </Layout>
  );
}

/** Opening the link changes nothing (a mail scanner may open it); only the button does. */
candidatePages.get("/c/confirm-answers/:token", async (c) => {
  const container = c.get("container");
  const token = c.req.param("token");
  const view = await repeatConfirmationView(container.db, token, container.engine.clock());
  if (!view) return c.notFound();
  c.header("Cache-Control", "no-store");
  return c.html(<ConfirmAnswersPage view={view} token={token} />);
});

candidatePages.post("/c/confirm-answers/:token", rateLimit(POLICIES.confirmAnswers), async (c) => {
  const container = c.get("container");
  const token = c.req.param("token") ?? "";
  const view = await confirmRepeat(container, token);
  if (!view) return c.notFound();
  // The answers are the candidate's own now, sent as any chat is: their record learns from them (Wave S7, spec step 10).
  // Best effort: the answers are already added; learning is idempotent, so a later press can try again.
  if (view.state === "added") {
    try {
      await learnFromConfirmedRepeat(container, token);
    } catch (err) {
      console.warn(`[screen] learning from the confirmed answers failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return c.redirect(`/c/confirm-answers/${token}`);
});
