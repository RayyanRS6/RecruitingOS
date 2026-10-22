/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { trialPaused, trialStanding } from "@ros/contracts";
import { CLOSING_DATE_REASON, applyByLabel, benefitsDescriptionFor, closingDayWords, noticesFor } from "@ros/core";
import { rolePackets, roles, type companies } from "@ros/db";
import { LOGO_FILE, jobPostingJsonLd } from "@ros/integrations";
import type { Vars } from "../middleware/session";
import type { Container } from "../container";
import { approvedAbout, contactLineFor, logoPublicPath, logoPublicUrl, logoResponse, profileOf } from "../services/company-settings-profile";
import { APPLY_FLOW } from "../services/job-preview";
import { jobUrls } from "../services/job-urls";
import { acceptingApplications, jobNotices, loadJob, loadPublicCompany } from "./candidate-shared";
import { descriptionExcerpt } from "./description";
import { Icon } from "./icons";
import { JobFacts, payShown, publicPay, roleValidThrough } from "./job-facts";
import { CompanyLine, HelpLine, JobPage, type JobPageCompany, type JobPageRole } from "./job-page";
import { Layout } from "./layout";

/**
 * The company's public pages (Wave S7, S7-0: moved as they were from pages/candidate.tsx): the careers page, the logo,
 * the job page and the privacy page. Mounted on the candidate pages by pages/candidate.tsx.
 */
const candidatePages = new Hono<Vars>();
export { candidatePages as careerPages };

/** What the job page says instead of the Apply button. */
function closedMessage(role: { status: string; applicationsClosedReason?: string | null; applicationsCloseOn?: string | null }): string {
  if (role.status === "closed") return "This position is closed and no longer taking applications.";
  if (role.applicationsClosedReason === CLOSING_DATE_REASON && role.applicationsCloseOn) return `Applications for this position closed at the end of ${closingDayWords(role.applicationsCloseOn)}.`;
  return "This position is not taking new applications right now.";
}

/**
 * What the public pages say about the company (plan D10): the text a person approved (never a draft, never the role
 * plans' own company line), our copy of the logo, and who answers before applying.
 */
function publicCompany(company: typeof companies.$inferSelect, env: Container["env"]): JobPageCompany {
  const logo = profileOf(company.settings).logo;
  return { name: company.name, slug: company.slug, about: approvedAbout(company.settings), website: company.settings.website ?? null, logoSrc: logo ? logoPublicPath(company.slug, logo) : null, contact: contactLineFor(company.settings, env) };
}

/** The logo's full address for search engines and link previews: our stored copy, else an address typed before uploads existed. */
function publicLogoUrl(company: typeof companies.$inferSelect, env: Container["env"]): string | null {
  const logo = profileOf(company.settings).logo;
  return logo ? logoPublicUrl(env, company.slug, logo) : company.settings.logoUrl ?? null;
}

/**
 * The job as its page shows it. `companyPaused`: the company's trial has ended (founder decision L-02 B), so the page
 * says what a job not taking applications says, in the same neutral words, and never why.
 */
function jobRoleView(role: typeof roles.$inferSelect, companyPaused: boolean): JobPageRole {
  const accepting = acceptingApplications(role) && !companyPaused;
  return { id: role.id, accepting, closedMessage: accepting ? null : closedMessage(role), postedOn: role.openedAt ?? role.createdAt, applyBy: accepting && role.applicationsCloseOn ? applyByLabel(role.applicationsCloseOn) : null };
}

/**
 * The careers page (plan D10): the company with its logo and the text it approved about itself, then every open job
 * with its places, work model, kind of job, pay, its first lines and its closing date; the jobs and the versions they
 * run on come in one query.
 */
candidatePages.get("/careers/:slug", async (c) => {
  const container = c.get("container");
  const company = await loadPublicCompany(container.db, c.req.param("slug"));
  if (!company) return c.notFound();
  const open = await container.db
    .select({ role: roles, packet: rolePackets.packet })
    .from(roles)
    .innerJoin(rolePackets, and(eq(rolePackets.roleId, roles.id), eq(rolePackets.version, roles.currentPacketVersion)))
    .where(and(eq(roles.companyId, company.id), eq(roles.status, "open")))
    .orderBy(desc(roles.openedAt));
  const view = publicCompany(company, container.env);
  // A trial that ended (L-02 B) shows every job as not taking new applications, in the words a job's own stop uses.
  const paused = trialPaused(company, container.engine.clock());
  const intro = company.settings.careersPage?.intro ?? "We respond to every applicant and keep the process short.";
  const summary = `${open.length ? `${open.length} open ${open.length === 1 ? "job" : "jobs"} at ${company.name}.` : `Jobs at ${company.name}.`} ${view.about ?? intro}`.slice(0, 300);
  return c.html(
    <Layout title={`Careers at ${company.name}`} wide description={summary} share={{ title: `Careers at ${company.name}`, description: summary, url: jobUrls(container.env, { slug: company.slug, roleId: "-" }).careers, siteName: company.name, image: publicLogoUrl(company, container.env) }}>
      <div class="careers">
        <div class="careers-head">
          <CompanyLine company={view} eyebrow="Careers" />
          {/* The name in plum: the two-tone heading of the redesign (the words are unchanged). */}
          <h1>Work with <span>{company.name}</span></h1>
          <p class="lead">{intro}</p>
        </div>
        {view.about ? (
          <section class="card about" aria-labelledby="about-company">
            <h2 id="about-company">About {company.name}</h2>
            <p class="pre">{view.about}</p>
          </section>
        ) : null}
        <h2>Open positions</h2>
        {open.length === 0 ? <div class="card">No open positions right now. Check back soon.</div> : null}
        {open.length ? (
          <ul class="roles">
            {open.map(({ role: r, packet }) => {
              const title = packet.identity.title;
              const accepting = r.acceptingApplications && !paused;
              return (
                <li class="card role">
                  <span class="role-icon" aria-hidden="true"><Icon name="briefcase" /></span>
                  <div class="role-main">
                    <h3>{title}</h3>
                    <JobFacts packet={packet} pay={publicPay(packet, jobNotices(packet, company))} small schedule={false} />
                    <p class="excerpt">{descriptionExcerpt(packet.description.publicJobDescription)}</p>
                    {accepting ? (r.applicationsCloseOn ? <p class="meta">{applyByLabel(r.applicationsCloseOn)}</p> : null) : <p class="meta">{r.applicationsClosedReason === CLOSING_DATE_REASON && r.applicationsCloseOn ? `Applications closed at the end of ${closingDayWords(r.applicationsCloseOn)}.` : "Not taking new applications right now."}</p>}
                  </div>
                  <a class="btn secondary" href={`/careers/${company.slug}/jobs/${r.id}`}>{accepting ? "View and apply" : "View details"}<span class="sr-only">: {title}</span><Icon name="arrow-right" /></a>
                </li>
              );
            })}
          </ul>
        ) : null}
        <HelpLine contact={view.contact} />
        <p class="foot"><a href="/c/link-request">Already applied? See your application</a> · <a href="/privacy">How we handle your information</a></p>
      </div>
    </Layout>,
  );
});

/**
 * The company's logo, from our own storage (plan D10): only the file the company has now, only once ITS has confirmed
 * the company. The name is a fresh id per upload, so the copy may be cached for good.
 */
candidatePages.get("/careers/:slug/logo/:file", async (c) => {
  const container = c.get("container");
  const file = c.req.param("file");
  if (!LOGO_FILE.test(file)) return c.notFound();
  const company = await loadPublicCompany(container.db, c.req.param("slug"));
  const logo = company ? profileOf(company.settings).logo : undefined;
  if (!logo || logo.file !== file) return c.notFound();
  const bytes = await container.integrations.storage.get(logo.key);
  if (!bytes) return c.notFound();
  return logoResponse(bytes, logo.contentType, "public, max-age=31536000, immutable");
});

candidatePages.get("/careers/:slug/jobs/:roleId", async (c) => {
  const container = c.get("container");
  const job = await loadJob(container.db, c.req.param("slug"), c.req.param("roleId"));
  if (!job) return c.notFound();
  const { company, role, packet } = job;
  const urls = jobUrls(container.env, { slug: company.slug, roleId: role.id });
  const allNotices = jobNotices(packet, company);
  const logoUrl = publicLogoUrl(company, container.env);
  const trial = trialStanding(company, container.engine.clock());
  const trialEnded = trial?.ended === true;
  // A trial that ended (L-02 B) stops the job taking applications on the day it ended, so search engines stop listing it
  // as the feeds and the sitemap already do.
  const datedRole = trialEnded && trial?.endsAt && role.acceptingApplications ? { ...role, acceptingApplications: false, applicationsClosedAt: trial.endsAt } : role;
  // The JobPosting block stays on paused and closed pages (docs/spec/20 item 4). validThrough is a real date only: the
  // closing day, the day the role stopped taking applications, or its closing date; an open role with none carries none.
  const jsonLd = jobPostingJsonLd({
    roleId: role.id,
    companyName: company.name,
    companySlug: company.slug,
    packet,
    jobUrl: urls.job,
    applyUrl: urls.apply,
    datePosted: (role.openedAt ?? role.createdAt).slice(0, 10),
    validThrough: roleValidThrough(datedRole) ?? null,
    showPay: payShown(packet, allNotices),
    companyWebsite: company.settings.website ?? null,
    companyLogoUrl: logoUrl,
  });
  const excerpt = descriptionExcerpt(packet.description.publicJobDescription, 155);
  return c.html(
    <JobPage
      packet={packet}
      company={publicCompany(company, container.env)}
      role={jobRoleView(role, trialEnded)}
      notices={allNotices}
      smsEnabled={container.env.SMS_ENABLED}
      flow={APPLY_FLOW}
      benefits={benefitsDescriptionFor(packet.compensation, company.settings)}
      links={{ careers: `/careers/${company.slug}`, apply: `/careers/${company.slug}/jobs/${role.id}/apply` }}
      jsonLd={jsonLd}
      description={excerpt}
      share={{ title: `${packet.identity.title} at ${company.name}`, description: excerpt, url: urls.job, siteName: company.name, image: logoUrl }}
    />,
  );
});

candidatePages.get("/privacy", async (c) => {
  const n = noticesFor(["*"]).find((x) => x.key === "privacy");
  const privacyEmail = c.get("container").env.PRIVACY_EMAIL;
  const smsEnabled = c.get("container").env.SMS_ENABLED;
  return c.html(
    <Layout title="How we handle your information">
      <p class="eyebrow">Privacy</p>
      <h1>How we handle your information</h1>
      <p>{n?.text}</p>
      {/* The apply form's "Who can see it" points here (docs/readiness/20 section D, item 6): every kind of service provider that touches an application, and what each one does. */}
      <h2 id="who-can-see">Who can see your information</h2>
      <ul class="steps">
        <li>The hiring team at the company you applied to. People there make every hiring decision.</li>
        <li>An Identified Talent Solutions recruiter, only if the company brings one in to help. Their access is limited to what they were brought in for, and every access is recorded.</li>
        <li>The companies that run this service for us, each only for its own job:
          <ul>
            <li>Hosting: runs this website and the work behind it.</li>
            <li>Database and file storage: keeps your application and your resume, privately.</li>
            <li>Email delivery: sends the emails about your application and receives your replies.</li>
            <li>An AI service: reads applications and screening answers to help organize and summarize them for the hiring team. It does not decide anything.</li>
            {smsEnabled ? <li>Text messages: sends and receives texts, only if you agreed to them.</li> : null}
            <li>Calendars (Google or Microsoft): only the interviewers' own calendars, to book an interview time with you.</li>
          </ul>
        </li>
      </ul>
      <p>These companies may use your information only to provide that service to us. We do not sell your information.</p>
      <h2>Your choices</h2>
      <ul class="steps">
        <li>Ask what we hold about you, correct it, or delete it: <a href="/c/privacy-request">use the request form</a> with the address you applied with (we confirm it is you by email), or write to <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a> from that address. A person records the request, confirms receipt within one business day, and completes it within the legal deadline.</li>
        <li>Stop text messages any time by replying STOP.</li>
        <li>Talk to a person instead of the AI assistant: press "I'd rather talk to a person" on the conversation's page, or reply HUMAN to any of our emails.</li>
        <li>Ask not to be kept for future roles: use the button on your status page, or reply "no thanks" to any of our emails.</li>
        <li>Lost the link to your status page? <a href="/c/link-request">We can email it to you again</a>, only ever to the address you applied with.</li>
      </ul>
      <h2>Automated tools</h2>
      <p>{noticesFor(["*"]).find((x) => x.key === "ai_use")?.text}</p>
      <a class="btn" href="/c/privacy-request">Request, correct or delete my information</a>
    </Layout>,
  );
});
