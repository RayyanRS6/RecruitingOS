import { type ChipTone, Icon, IconChip, type IconName } from "@ros/ui";
import { BrandMark } from "../BrandMark";

/**
 * The public welcome page (/welcome, October 2026 redesign, screenshot 2): what Recruiting OS is, for someone who is not
 * signed in. Static and server-drawn, with no script of its own. Every way in leads to the sign-in page, where an
 * invitation is opened too; there is no sign-up or pilot request here, so the page asks for nothing. The hero comes in
 * with a short CSS rise, 30 ms apart (motion-safe only, so nothing moves for someone who asked for less motion).
 *
 * Fewer words (founder, 23 October 2026): each section is its heading, its one paragraph or list, and its way in; no
 * eyebrows over the headings, no strip of ticks, no taglines. The two-column sections line their heading up with the
 * top of the list beside it.
 *
 * The copy promises only what the product does (no applicant AI opt-in exists, so none is promised): applicants are told
 * how AI is used and can ask for a person (the ai_use notice), a person makes every decision, and a failed or missing
 * answer is held for a person, never declined on its own (application-intake's eligibility hold, triage's "hold" and
 * "review_manually").
 *
 * The plum band stays dark in both themes (plum in light, deep lavender in dark), so its text is white and its coral is a
 * fixed light coral, #f4a68e (the dark theme's --accent-ink): 5.3:1 on the light band and 7:1 on the dark one.
 */

/** The page's column: 16 px gutters on a phone, wider from a tablet up. Rules that span the column sit inside it. */
const wrap = "mx-auto w-full max-w-[1000px] px-4 sm:px-6 md:px-10";

function Arrow() {
  return <Icon name="arrow-right" size={16} className="transition-transform duration-150 ease-soft motion-safe:group-hover:translate-x-0.5" />;
}

/**
 * The guide card is a picture of the journey, not a menu: its rows end in a status mark (the first stage done, the
 * others still open), never in an arrow that would look like a link.
 */
const GUIDE: Array<{ tone: ChipTone; icon: IconName; title: string; meta: string; done: boolean }> = [
  { tone: "lavender", icon: "briefcase", title: "Define the right role", meta: "Skills, pay, location and must-haves", done: true },
  { tone: "peach", icon: "people", title: "Compare applicants", meta: "Relevant evidence, gaps and questions", done: false },
  { tone: "lavender", icon: "activity", title: "Know what to do next", meta: "From first review to final decision", done: false },
];

const STEPS: Array<{ icon: IconName; title: string; body: string }> = [
  {
    icon: "message-circle",
    title: "Tell your guide who you need",
    body: "Start with a conversation, not a blank job description. AI helps clarify the work, must-have skills, pay range and location—then shapes a role you can review and share.",
  },
  {
    icon: "people",
    title: "Check the essentials before you meet",
    body: "Approve role-specific qualification questions, pay, work location and start-date requirements. Applicants share their answers; see matches, differences and unknowns beside the source. An answer that doesn’t match is held for your decision, never declined automatically.",
  },
  {
    icon: "star",
    title: "Choose your shortlist with context",
    body: "Use transparent review groups to focus your conversations, with AI evidence notes you can check against the source. Every applicant stays visible. You choose who to shortlist and when to move them toward an interview or offer.",
  },
];

const POINTS: Array<{ icon: IconName; title: string; body: string }> = [
  {
    icon: "shield",
    title: "Understand why someone may fit",
    body: "AI organizes job-related evidence against your criteria and highlights what still needs a conversation. Check the source, not just a summary.",
  },
  {
    icon: "user",
    title: "A shortlist you can stand behind",
    body: "Use the evidence to decide whom to meet. No automatic rejection or hiring decision; every applicant stays available for your review.",
  },
  {
    icon: "file-text",
    title: "Clear expectations for applicants",
    body: "Applicants are told how AI is used, and can ask to talk to a person at any point. Missing information is something to clarify—not an automatic “no.”",
  },
];

export function WelcomePage() {
  return (
    <>
      <header className="motion-safe:animate-fade">
        <div className={wrap}>
          <div className="flex h-16 items-center justify-between gap-3 border-b border-line md:grid md:grid-cols-[1fr_auto_1fr]">
            <a href="/" className="-ml-1 inline-flex min-h-10 items-center rounded-xl px-1 md:justify-self-start">
              <BrandMark />
            </a>
            <nav aria-label="On this page" className="hidden md:block">
              <ul className="flex items-center gap-1 text-[13.5px] font-medium text-ink-2">
                <li>
                  <a href="#how-it-works" className="inline-flex h-10 items-center rounded-full px-3.5 transition-colors duration-150 hover:bg-surface-2 hover:text-ink">How it works</a>
                </li>
                <li>
                  <a href="#for-owners" className="inline-flex h-10 items-center rounded-full px-3.5 transition-colors duration-150 hover:bg-surface-2 hover:text-ink">For owners</a>
                </li>
              </ul>
            </nav>
            <div className="flex items-center gap-1.5 md:justify-self-end">
              <a href="/login" className="inline-flex h-10 items-center rounded-full px-3.5 text-[14px] font-medium text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink">Sign in</a>
              <a href="/login" className="btn primary sm group hidden sm:inline-flex">
                Have an invitation?
                <Arrow />
              </a>
            </div>
          </div>
        </div>
      </header>

      <main>
        {/* Hero: the promise and its one way in on the left, a picture of the guide on the right, centred on each other */}
        <section aria-labelledby="welcome-title" className={`${wrap} grid items-center gap-12 pb-14 pt-14 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:gap-10 md:pb-20 md:pt-20`}>
          <div>
            <h1 id="welcome-title" className="font-display text-[40px] font-bold leading-[1.02] tracking-[-0.035em] text-ink sm:text-[48px] md:text-[56px] motion-safe:animate-enter">
              Hiring, made <span className="block text-primary">more manageable.</span>
            </h1>
            <p className="mt-6 max-w-[27rem] text-[15px] leading-[1.65] text-ink-2 motion-safe:animate-enter [animation-delay:30ms]">
              No dedicated recruiter? No time to become one? Recruiting OS helps you define the role, make sense of applicants, and navigate every next step with AI. Spend less time sifting through resumes and more time on the right conversations.
            </p>
            <div className="mt-8 motion-safe:animate-enter [animation-delay:60ms]">
              <a href="/login" className="btn primary group">
                Open your invitation
                <Arrow />
              </a>
            </div>
          </div>

          <div className="w-full max-w-[22rem] justify-self-center rounded-[20px] border border-line bg-surface shadow-pop md:-rotate-1 md:justify-self-end motion-safe:animate-enter [animation-delay:60ms]">
            <div className="flex items-center gap-3 px-5 py-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-primary text-on-primary" aria-hidden="true">
                <Icon name="bars" size={18} />
              </span>
              <p className="min-w-0 font-display text-[16px] font-semibold leading-tight tracking-[-0.01em] text-ink">Your AI recruiting guide</p>
            </div>
            <ul className="divide-y divide-line border-t border-line">
              {GUIDE.map((row) => (
                <li key={row.title} className="flex items-center gap-3 px-5 py-3.5">
                  <IconChip icon={row.icon} tone={row.tone} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-semibold leading-snug text-ink">{row.title}</p>
                    <p className="text-[12.5px] leading-snug text-ink-3">{row.meta}</p>
                  </div>
                  {row.done ? (
                    <Icon name="check-circle" size={16} className="shrink-0 text-ink-3" />
                  ) : (
                    <span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">
                      <span className="size-3 rounded-full border border-ink-3" />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* How it works: three numbered steps */}
        <section id="how-it-works" aria-labelledby="how-title" className={`${wrap} grid scroll-mt-6 gap-10 pb-16 pt-6 md:grid-cols-2 md:gap-12 md:pb-24 md:pt-8`}>
          <div className="md:pt-6">
            <h2 id="how-title" className="font-display text-[32px] font-bold leading-[1.04] tracking-[-0.035em] text-ink sm:text-[38px] md:text-[42px]">
              From {"“"}we need someone{"”"} <span className="block text-primary">to {"“"}I know who to call.{"”"}</span>
            </h2>
            <p className="mt-5 max-w-[25rem] text-[15px] leading-[1.65] text-ink-2">
              You don{"’"}t need to be a recruiter to make a good hire. Get help turning a hiring need into a clear role, a thoughtful shortlist, and a next step you feel confident about.
            </p>
          </div>
          <ol className="border-t border-line">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-3 border-b border-line py-6 sm:gap-4">
                <span className="w-5 shrink-0 pt-2 font-mono text-[11px] tracking-[0.08em] text-ink-3" aria-hidden="true">{`0${i + 1}`}</span>
                <IconChip icon={step.icon} tone="lavender" size="sm" />
                <div className="min-w-0">
                  <h3 className="font-display text-[18px] font-semibold leading-snug tracking-[-0.015em] text-ink">{step.title}</h3>
                  <p className="mt-1.5 text-[14px] leading-[1.6] text-ink-2">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* For owners: the plum band */}
        <section id="for-owners" aria-labelledby="owners-title" className="scroll-mt-6 bg-primary text-white dark:bg-tint-2">
          <div className={`${wrap} grid items-center gap-10 py-16 md:grid-cols-2 md:gap-12 md:py-20`}>
            <div>
              <h2 id="owners-title" className="font-display text-[34px] font-bold leading-[1.04] tracking-[-0.035em] text-white sm:text-[40px] md:text-[44px]">
                You already have <span className="sm:block">a full-time job.</span>
              </h2>
              <p className="mt-5 max-w-[26rem] text-[15px] leading-[1.65] text-white/80">
                Hiring shouldn{"’"}t become another one. Whether it falls to the owner, a manager, or whoever has a spare hour, Recruiting OS brings AI-assisted review and step-by-step guidance to the work a recruiter would help you navigate.
              </p>
              <a href="/login" className="group mt-5 inline-flex min-h-10 items-center gap-1.5 rounded-lg text-[14px] font-semibold text-[#f4a68e] focus-visible:outline-white">
                Get help with your next hire
                <Arrow />
              </a>
            </div>
            <div className="rounded-2xl border border-white/15 bg-black/20 p-6 md:p-8">
              <h3 className="font-display text-[26px] font-bold leading-[1.1] tracking-[-0.03em] text-white md:text-[30px]">You don{"’"}t have to figure out every step alone.</h3>
              <p className="mt-4 text-[14px] leading-[1.65] text-white/80">
                What really matters for this role? Which experience is relevant? What should you ask next? Talk it through with your AI hiring guide and keep the role, applicants and decisions in one place.
              </p>
            </div>
          </div>
        </section>

        {/* The owner keeps the decision */}
        <section aria-labelledby="review-title" className={`${wrap} grid gap-10 py-16 md:grid-cols-2 md:gap-12 md:py-24`}>
          <div className="md:pt-5">
            <h2 id="review-title" className="font-display text-[34px] font-bold leading-[1.04] tracking-[-0.035em] text-ink sm:text-[40px] md:text-[44px]">
              Help with the review. <span className="block text-primary">You make the hire.</span>
            </h2>
          </div>
          <ul className="border-t border-line">
            {POINTS.map((point) => (
              <li key={point.title} className="border-b border-line py-5">
                <h3 className="flex items-center gap-2.5 font-sans text-[15px] font-semibold leading-snug tracking-normal text-ink">
                  <Icon name={point.icon} size={17} className="shrink-0 text-primary" />
                  {point.title}
                </h3>
                <p className="mt-1.5 pl-[27px] text-[14px] leading-[1.6] text-ink-2">{point.body}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* Closing call to action: the same way in as the hero */}
        <section aria-labelledby="next-title" className={`${wrap} pb-16 md:pb-24`}>
          <div className="flex flex-col gap-6 rounded-[20px] border border-line bg-surface-3/50 p-6 sm:p-8 md:flex-row md:items-center md:gap-8">
            <span className="grid size-11 shrink-0 place-items-center rounded-full border border-line bg-surface text-primary shadow-xs" aria-hidden="true">
              <Icon name="sparkle" size={18} />
            </span>
            <h2 id="next-title" className="min-w-0 flex-1 font-display text-[26px] font-bold leading-[1.1] tracking-[-0.03em] text-ink md:text-[30px]">
              You run the business. <span className="block">Get help with the hiring.</span>
            </h2>
            <a href="/login" className="btn primary group self-start md:self-center">
              Open your invitation
              <Arrow />
            </a>
          </div>
        </section>
      </main>

      <footer>
        <div className={wrap}>
          <div className="flex flex-col items-center gap-4 border-t border-line py-8 text-[13px] text-ink-2 md:flex-row md:justify-between">
            <BrandMark tile="coral" />
            <div className="flex flex-wrap items-center justify-center gap-x-1 gap-y-1">
              <nav aria-label="Footer">
                <ul className="flex items-center gap-1">
                  <li>
                    <a href="/login" className="inline-flex h-10 items-center rounded-full px-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink">Sign in</a>
                  </li>
                  <li>
                    <a href="#how-it-works" className="inline-flex h-10 items-center rounded-full px-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink">How it works</a>
                  </li>
                </ul>
              </nav>
              <p className="px-3">{"©"} Recruiting OS</p>
            </div>
          </div>
        </div>
      </footer>
    </>
  );
}
