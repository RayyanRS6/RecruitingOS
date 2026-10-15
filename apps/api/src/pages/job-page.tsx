/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { DraftRolePacket } from "@ros/contracts";
import { candidateNotices, type Notice } from "@ros/core";
import type { ContactLine } from "../services/company-settings-profile";
import { applySteps, applyTimeLine, type ApplyFlowView } from "../services/job-preview";
import { Description } from "./description";
import { Icon } from "./icons";
import { JobFacts, publicPay } from "./job-facts";
import { Layout, type ShareTags } from "./layout";

/**
 * The job page, shared by the public pages (pages/careers-pages.tsx) and the authenticated preview (pages/preview.tsx,
 * plan D1), taking the packet, the company and, for a preview, what to say about it; the apply form, shared the same way,
 * is pages/apply-form.tsx (moved there as it was in Wave S7, S7-0). A preview carries no structured data, no share tags, no form that sends anything and no link to a public
 * address that may not exist yet; it is marked "not public yet" and kept out of search results.
 */

/** What the pages say about the company: only text a person approved, the logo we store, and who answers before applying. */
export type JobPageCompany = { name: string; slug: string; about: string | null; website: string | null; logoSrc: string | null; contact: ContactLine };

export type JobPageRole = {
  id: string;
  accepting: boolean;
  /** What the page says instead of the Apply button. */
  closedMessage: string | null;
  /** The day the role opened (roles.openedAt); null before it is public. */
  postedOn: string | null;
  /** "Apply by Friday, October 30, 2026" when the role has a closing date (plan D7). */
  applyBy: string | null;
};

/** How a preview introduces itself, and where its own links go. */
export type PreviewInfo = { notPublicYet: boolean; banner: string; gaps: string[]; jobHref: string; applyHref: string; publicHref: string | null };

/** "Harbor Dental" → "HD": what the logo square shows when the company has not uploaded one. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase();
}

/** A company website as a link: a typed "acme.com" gets its https://, and the words drop the scheme. */
function website(value: string): { href: string; text: string } {
  const href = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return { href, text: value.replace(/^https?:\/\//i, "").replace(/\/$/, "") };
}

/** The logo square (or the initials) beside the company's name; decorative, since the name is always written beside it. */
export function CompanyLine(props: { company: Pick<JobPageCompany, "name" | "logoSrc">; eyebrow: unknown }) {
  return (
    <div class="company">
      <span class="logo" aria-hidden="true">{props.company.logoSrc ? <img src={props.company.logoSrc} alt="" width="56" height="56" /> : initials(props.company.name)}</span>
      <div>
        <p class="eyebrow">{props.eyebrow}</p>
      </div>
    </div>
  );
}

/** The address a candidate writes to before applying, with the person's name when the company gave one. */
export function ContactLink(props: { contact: ContactLine }) {
  return <>{props.contact.name ? `${props.contact.name} at ` : ""}<a href={`mailto:${props.contact.email}`}>{props.contact.email}</a></>;
}

/** The pre-apply line (plan D10): help applying, or a change to how to apply because of a disability, from a person. */
export function HelpLine(props: { contact: ContactLine; class?: string }) {
  return <p class={props.class ?? "help-line"}>Need help applying, or a change to how you apply because of a disability? Email <ContactLink contact={props.contact} /> and a person will help.</p>;
}

/**
 * The inside of the Apply now button (founder decision Q2 = A, 10 October 2026): a dark circle with an arrow, then the
 * words. On a mouse's hover or a keyboard's focus the dark fill slides across the words (CSS only, layout.tsx). The fill
 * and the arrow are decoration, hidden from screen readers; the words are the button's name.
 */
function ApplyInner() {
  return <><span class="go-fill" aria-hidden="true" /><span class="go-icon"><Icon name="arrow-right" /></span><span class="go-text">Apply now</span></>;
}

/**
 * Four things that are true of every application here: how long (the conversation included, when it follows the form;
 * plan E8), what to send, who decides, how to reach a person.
 */
export function FourPoints(props: { company: Pick<JobPageCompany, "name" | "contact">; packet: Pick<DraftRolePacket, "screening">; flow: ApplyFlowView }) {
  return (
    <ul class="points">
      <li><Icon name="clock" /><span>{applyTimeLine(props.packet, { companyName: props.company.name, flow: props.flow })}</span></li>
      <li><Icon name="paperclip" /><span>A resume, or a few lines about your work. No cover letter.</span></li>
      <li><Icon name="people" /><span>People at {props.company.name} make every hiring decision.</span></li>
      <li><Icon name="mail" /><span>Questions? Email <ContactLink contact={props.company.contact} /> to reach a person.</span></li>
    </ul>
  );
}

/** The one plain line a page shows for the AI notice; the notice itself stays one click away, word for word. */
export const AI_NOTICE_LINE = "This employer uses AI to help organize applications; people make every hiring decision.";

/**
 * The AI notice, kept short on the first view (founder brief, 14 October 2026): a notice box with one plain sentence and
 * "How AI is used" under it. The full text is always in the page, as written, so nothing the notice must say is lost.
 */
export function AiNotice(props: { text: string; line: string }) {
  return (
    <div class="notice">
      <p>{props.line}</p>
      <details class="more">
        <summary>How AI is used</summary>
        <p>{props.text}</p>
      </details>
    </div>
  );
}

/** The first sentence of a step, never cut inside the company's name ("Dr. Lee Dental"). */
function firstSentence(text: string, companyName: string): string {
  const mask = "\u0000";
  const masked = companyName ? text.split(companyName).join(mask) : text;
  const first = masked.match(/^[\s\S]*?[.!?](?=\s+[A-Z]|\s*$)/)?.[0] ?? masked;
  return companyName ? first.split(mask).join(companyName) : first;
}

/**
 * "What to expect" at a glance (founder brief, 14 October 2026): at most four short lines, from the same steps every
 * page lists (services/job-preview.ts `applySteps`: applying, the conversation, each interview, the decision). Applying
 * and the conversation keep their first sentence; the interviews share one line. The full steps stay one click away.
 */
export function expectAtAGlance(steps: string[], companyName: string): string[] {
  if (steps.length < 3) return steps.map((s) => firstSentence(s, companyName));
  const rounds = steps.slice(2, -1);
  const interviews = rounds.length === 0 ? null : rounds.length === 1 ? rounds[0] : `Interviews: ${rounds.join(", ")}`;
  return [firstSentence(steps[0], companyName), firstSentence(steps[1], companyName), interviews, steps[steps.length - 1]].filter((s): s is string => !!s);
}

/** The "not public yet" note at the top of a preview, with what the page is still missing. */
export function PreviewNote(props: { preview: PreviewInfo }) {
  const p = props.preview;
  return (
    <div class="preview-note" role="note">
      <p><strong>{p.notPublicYet ? "Not public yet." : "Preview."}</strong> {p.banner} Links on this preview stay on it, and its form sends nothing.</p>
      {p.gaps.length ? <ul>{p.gaps.map((g) => <li>{g}</li>)}</ul> : null}
      {p.publicHref ? <p><a href={p.publicHref}>Open the public page</a></p> : null}
    </div>
  );
}

export type JobPageProps = {
  packet: DraftRolePacket;
  company: JobPageCompany;
  role: JobPageRole;
  /** Every notice for the job's places; the page decides which it renders. */
  notices: Notice[];
  smsEnabled: boolean;
  /** How applicants meet the screening conversation (services/job-preview.ts `applyFlowOf`): what the time and the steps say. */
  flow: ApplyFlowView;
  /** The benefits the law (or the company) has the page describe: the role's own, else the company's (Setup). */
  benefits: string | null;
  links: { careers: string | null; apply: string };
  preview?: PreviewInfo;
  jsonLd?: Record<string, unknown>;
  share?: ShareTags;
  description?: string;
};

/**
 * The job page (plan D10): the company with its logo, the title, every fact as a pill and a first Apply button; then the
 * description in headed sections, what the team is looking for, what would be nice, the benefits, the steps and the
 * notices, and what the company says about itself; beside it, an apply card that stays in view with four true points
 * and how to reach a person. On a phone the card becomes a bar held at the bottom of the screen (CSS only) and the
 * points move into the page. The steps show at a glance and the AI notice as one line (founder brief, 14 October
 * 2026); the full steps and the notice's full text are one click away, in the page.
 */
export function JobPage(props: JobPageProps) {
  const { packet, company, role, preview } = props;
  const title = packet.identity.title;
  const pay = publicPay(packet, props.notices);
  const notices = candidateNotices(props.notices).filter((n) => n.key === "ai_use" || n.key === "pay_transparency");
  const mustHaves = packet.requirements.mustHaves.map((m) => m.text.trim()).filter(Boolean);
  const niceToHaves = packet.requirements.niceToHaves.map((m) => m.text.trim()).filter(Boolean);
  const careers = props.links.careers;
  const steps = applySteps(packet, { companyName: company.name, smsEnabled: props.smsEnabled, flow: props.flow });
  return (
    <Layout title={preview ? `Preview: ${title} at ${company.name}` : `${title} at ${company.name}`} jsonLd={preview ? undefined : props.jsonLd} wide description={preview ? undefined : props.description} share={preview ? undefined : props.share} noindex={!!preview}>
      {preview ? <PreviewNote preview={preview} /> : null}
      <div class="job-head">
        <CompanyLine company={company} eyebrow={careers ? <a href={careers}>Careers at {company.name}</a> : `Careers at ${company.name}`} />
        <h1>{title}</h1>
        <JobFacts packet={packet} pay={pay} postedOn={role.postedOn} />
        {role.accepting ? (
          <div class="head-actions">
            <a class="btn go head-apply" href={props.links.apply}><ApplyInner /></a>
            {role.applyBy ? <p class="apply-by"><Icon name="calendar" />{role.applyBy}</p> : null}
          </div>
        ) : null}
      </div>
      {!role.accepting ? <div class="alert caution" role="status">{role.closedMessage}</div> : null}
      {/* The description, the steps and the notices come first in reading order; the apply panel follows them (beside them on a wide screen, held at the bottom of a phone's screen). */}
      <div class={role.accepting ? "job-layout" : "job-layout solo"}>
        <div class="job-main">
          {role.accepting ? (
            <div class="card points-card">
              <FourPoints company={company} packet={packet} flow={props.flow} />
              <HelpLine contact={company.contact} />
            </div>
          ) : null}
          <div class="card job-body">
            <h2>About the job</h2>
            <Description text={packet.description.publicJobDescription} />
            {mustHaves.length ? <h2>What we're looking for</h2> : null}
            {mustHaves.length ? <ul class="checks">{mustHaves.map((t) => <li><Icon name="check" /><span>{t}</span></li>)}</ul> : null}
            {niceToHaves.length ? <h2>Nice to have</h2> : null}
            {niceToHaves.length ? <ul class="checks">{niceToHaves.map((t) => <li><Icon name="check" /><span>{t}</span></li>)}</ul> : null}
            {props.benefits ? <h2>Benefits</h2> : null}
            {props.benefits ? <p class="pre">{props.benefits}</p> : null}
            <h2>What to expect</h2>
            <ol class="steps">
              {expectAtAGlance(steps, company.name).map((s) => <li>{s}</li>)}
            </ol>
            <details class="more">
              <summary>More about each step</summary>
              <ol class="steps">{steps.map((s) => <li>{s}</li>)}</ol>
            </details>
            {notices.map((n) => (n.key === "ai_use" ? <AiNotice text={n.text} line={AI_NOTICE_LINE} /> : <p class="notice">{n.text}</p>))}
          </div>
          {company.about ? (
            <section class="card about" aria-labelledby="about-company">
              <h2 id="about-company">About {company.name}</h2>
              <p class="pre">{company.about}</p>
              {company.website ? <a class="site" href={website(company.website).href} rel="noopener">{website(company.website).text}<Icon name="external" /></a> : null}
            </section>
          ) : null}
        </div>
        {role.accepting ? (
          <div class="apply-panel">
            <div class="card apply-card">
              <p class="apply-title">{title}</p>
              {role.applyBy ? <p class="apply-by"><Icon name="calendar" />{role.applyBy}</p> : <p class="meta">We confirm by email.</p>}
              <a class="btn go" href={props.links.apply}><ApplyInner /></a>
              <FourPoints company={company} packet={packet} flow={props.flow} />
              <HelpLine contact={company.contact} />
            </div>
          </div>
        ) : null}
      </div>
      {/* Coming back to the job (spec-s7 step 9): the application record is where they see where things stand and the
          decision once told; the link goes again to the address they applied with, never to this page. */}
      <p class="foot">{preview ? "On the public page: a link to see an application again, and how we handle information." : <><a href="/c/link-request">Already applied? See your application</a> · <a href="/privacy">How we handle your information</a></>}</p>
    </Layout>
  );
}
