import { Children, type ReactNode } from "react";
import { cn } from "./cn";
import { cx, initials, type StepState, STEP_STATE_TEXT, scoreBand, scoreLabel, type TableHead, type Tone } from "./helpers";
import { Icon, type IconName } from "./icons";

/**
 * Design system components (docs/07). The look lives in styles.css (its component layer styles every class these
 * render); these are semantic wrappers. Nothing in this file uses a React hook, because server components import it (the
 * shell's loading screen does). Components that need state or document listeners live in their own "use client"
 * modules and are re-exported at the bottom.
 */

/**
 * The kit's own classes, then a caller's `className` (joined by cn, so a later utility wins). Without one the kit's
 * string comes back untouched: tests pin those strings byte for byte.
 */
function withClass(kit: string, className: string | undefined): string {
  return className ? cn(kit, className) : kit;
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "quiet" | "destructive";

/** The tints an IconChip or a StatCell's icon can sit on. */
export type ChipTone = "lavender" | "peach" | "plum" | "good" | "caution" | "neutral";

/**
 * A button, a pill in every size. Primary is plum, secondary is outlined, ghost has no box, danger is for the few
 * actions that cannot be taken back ("quiet" and "destructive" are the earlier names for ghost and danger). `kbd` shows a
 * keyboard hint and announces it as the shortcut. `ariaPressed` makes it a toggle a screen reader hears as pressed or
 * not, for a choice shown only by its fill (left out, the button is a plain button). `block` fills the width (its class
 * is `wide`: Tailwind's `block` utility would turn the button into a plain block). `className` adds classes after the
 * kit's (spacing, a placement), never a second look.
 */
export function Button(props: { children: ReactNode; variant?: ButtonVariant; size?: "sm" | "md"; onClick?: () => void; type?: "button" | "submit"; disabled?: boolean; loading?: boolean; title?: string; icon?: IconName; iconEnd?: IconName; kbd?: string; ariaLabel?: string; ariaPressed?: boolean; block?: boolean; className?: string }) {
  const { variant = "secondary", size = "md" } = props;
  return (
    <button type={props.type ?? "button"} className={withClass(cx("btn", variant, size === "sm" && "sm", props.block && "wide"), props.className)} onClick={props.onClick} disabled={props.disabled || props.loading} title={props.title} aria-label={props.ariaLabel} aria-pressed={props.ariaPressed} aria-busy={props.loading} aria-keyshortcuts={props.kbd}>
      {props.loading ? (
        <>
          <span className="spinner" aria-hidden="true" />
          Working…
        </>
      ) : (
        <>
          {props.icon ? <Icon name={props.icon} /> : null}
          {props.children}
          {props.iconEnd ? <Icon name={props.iconEnd} /> : null}
          {props.kbd ? <Kbd decorative>{props.kbd}</Kbd> : null}
        </>
      )}
    </button>
  );
}

/** A button that is only an icon. The label is what a screen reader says and what the tooltip shows. */
export function IconButton(props: { icon: IconName; label: string; onClick?: () => void; size?: "sm" | "md"; disabled?: boolean; type?: "button" | "submit"; className?: string }) {
  return (
    <button type={props.type ?? "button"} className={withClass(cx("icon-btn", props.size === "sm" && "sm"), props.className)} aria-label={props.label} title={props.label} onClick={props.onClick} disabled={props.disabled}>
      <Icon name={props.icon} size={props.size === "sm" ? 16 : 18} />
    </button>
  );
}

/** A keyboard hint ("N"). Inside a button it is hidden from screen readers, which hear the shortcut from the button. */
export function Kbd(props: { children: ReactNode; decorative?: boolean }) {
  return <kbd className="kbd" aria-hidden={props.decorative || undefined}>{props.children}</kbd>;
}

/**
 * A card with an optional H2 title and an aside beside it. `needsYou` is the "Your next step" wash (something waits on
 * the reader); `hero` draws the title at the hero size (26px, 30px from 768px) for a page's one next step, so screens
 * never size it themselves; every other card's title, a needs-you one in a panel included, stays 19px. `lift` answers
 * the mouse.
 */
export function Card(props: { children: ReactNode; needsYou?: boolean; hero?: boolean; lift?: boolean; title?: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={cx("card", props.needsYou && "needs-you", props.hero && "hero", props.lift && "lift", props.className)}>
      {props.title || props.aside ? (
        <div className="card-title">
          {props.title ? <h2>{props.title}</h2> : <span />}
          {props.aside}
        </div>
      ) : null}
      {props.children}
    </section>
  );
}

export function Chip(props: { children: ReactNode; tone?: "neutral" | "accent" | "needs" | "good" | "caution" | "critical" | "source" | "info" | "warm"; icon?: IconName; className?: string }) {
  return (
    <span className={withClass(cx("chip", props.tone ?? "neutral"), props.className)}>
      {props.icon ? <Icon name={props.icon} size={14} /> : null}
      {props.children}
    </span>
  );
}

/**
 * A status pill: a dot and a word ("Live", "Draft", "On hold"). The word carries the meaning; the colour only helps a
 * glance. `solid` is for a finished state (Hired); `pulse` is for the one Live pill at the top of a page: a ring grows
 * from the dot and fades. Besides the five tones, `info` (lavender) and `warm` (peach, "Ready for your review").
 * `className="wrap"` lets a long status sentence wrap onto more lines (`.pill.wrap`) instead of running off a phone.
 */
export function Pill(props: { children: ReactNode; tone?: Tone | "info" | "warm"; dot?: boolean; solid?: boolean; pulse?: boolean; icon?: IconName; size?: "sm" | "md"; title?: string; className?: string }) {
  const tone = props.tone ?? "neutral";
  const mark = props.icon ? <Icon name={props.icon} size={14} /> : props.dot === false ? null : <span className={cx("dot", props.pulse && "pulse")} aria-hidden="true" />;
  return (
    <span className={withClass(cx("pill", tone, props.solid && "solid", props.size === "sm" && "sm"), props.className)} title={props.title}>
      {mark}
      {props.children}
    </span>
  );
}

/** Plain-language application status. Owner Mode never shows raw stage names. */
export function StatusChip(props: { stage: string; label: string; group?: string }) {
  const tone: Tone = props.group === "waiting_on_you" ? "caution" : props.group === "hired" ? "good" : props.group === "not_moving_forward" ? "neutral" : "accent";
  return <Pill tone={tone}>{props.label}</Pill>;
}

/** Sources whose own name would mislead: a recruiter's call notes are never the candidate's words (plan E3). */
const EVIDENCE_SOURCE_LABEL: Record<string, string> = { recruiter_note: "recruiter's call notes" };

export function EvidenceChip(props: { source: string }) {
  return <Chip tone="source">{EVIDENCE_SOURCE_LABEL[props.source] ?? props.source.replace("_", " ")}</Chip>;
}

/**
 * The match score as "91/100", green from 70, amber from 55, grey below (helpers.ts SCORE_BANDS). A screen reader hears
 * "Match score 91 out of 100". With no score yet it says so in words instead of showing a number.
 */
export function ScoreBadge(props: { score: number | null | undefined; size?: "sm" | "md" | "lg"; showBand?: boolean }) {
  const s = scoreBand(props.score);
  const size = props.size === "sm" || props.size === "lg" ? props.size : undefined;
  if (!s) return <span className={cx("score", "none", size)}>No score yet</span>;
  const label = scoreLabel(s.score);
  const badge = (
    <span className={cx("score", size !== "lg" && s.tone, size)} title={label}>
      <span className="sr-only">{label}</span>
      <span aria-hidden="true">
        {s.score}
        <span className="of">/100</span>
      </span>
    </span>
  );
  if (!props.showBand) return badge;
  return (
    <span className="score-wrap">
      {badge}
      <span className="score-band">{s.label}</span>
    </span>
  );
}

/**
 * Initials in a circle. Never a photo for a candidate (docs/07): only initials, in neutral tones. `ink` is the filled
 * dark version for the company and the signed-in person; `square` suits a company. Decorative unless `label` is given,
 * because the name is written beside it.
 */
export function Avatar(props: { name: string | null | undefined; size?: "sm" | "md" | "lg" | "xl"; tone?: "neutral" | "ink"; shape?: "circle" | "square"; letters?: 1 | 2; label?: string }) {
  const className = cx("avatar", props.size !== "md" && props.size, props.tone === "ink" && "ink", props.shape === "square" && "square");
  const text = initials(props.name, props.letters ?? 2);
  if (props.label) {
    return (
      <span className={className} role="img" aria-label={props.label}>
        {text}
      </span>
    );
  }
  return (
    <span className={className} aria-hidden="true">
      {text}
    </span>
  );
}

/**
 * The small uppercase, letter-spaced label that names a section ("AI interview"). Written in normal case; CSS raises it.
 * Not a decoration above a page's title: the founder's fewer-words rule (docs/07, "Words on screen") cut those.
 */
export function Eyebrow(props: { children: ReactNode; icon?: IconName; as?: "p" | "div" | "span"; className?: string }) {
  const Tag = props.as ?? "p";
  return (
    <Tag className={withClass("eyebrow", props.className)}>
      {props.icon ? <Icon name={props.icon} size={14} /> : null}
      {props.children}
    </Tag>
  );
}

/**
 * The top of a page: eyebrow, title, a status pill beside the title, actions on the right, and a line underneath
 * ("6 applicants · closes in 3 weeks"). `placeholderTitle` shows a title that is not chosen yet ("Untitled role") in grey.
 */
export function PageHeader(props: { title: ReactNode; eyebrow?: ReactNode; status?: ReactNode; actions?: ReactNode; sub?: ReactNode; placeholderTitle?: boolean }) {
  return (
    <header className="page-header">
      {props.eyebrow ? <Eyebrow>{props.eyebrow}</Eyebrow> : null}
      <div className="page-header-row">
        <h1 className={props.placeholderTitle ? "placeholder" : undefined}>{props.title}</h1>
        {props.status}
        {props.actions ? <div className="page-header-actions">{props.actions}</div> : null}
      </div>
      {props.sub ? <p className="page-header-sub">{props.sub}</p> : null}
    </header>
  );
}

export function Field(props: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label htmlFor={props.htmlFor}>{props.label}</label>
      {props.children}
      {props.hint ? <span className="hint">{props.hint}</span> : null}
    </div>
  );
}

export function Alert(props: { children: ReactNode; tone?: "info" | "caution" | "critical" | "neutral"; className?: string }) {
  return <div className={withClass(cx("alert", props.tone ?? "neutral"), props.className)} role={props.tone === "critical" ? "alert" : "status"}>{props.children}</div>;
}

/**
 * An icon that says its words only to a screen reader and as a tooltip (the eye for "Candidates see this"): the same
 * information as a chip with words, without the words on screen. The icon is hidden; the label is the text.
 */
export function IconLabel(props: { icon: IconName; label: string; className?: string }) {
  return (
    <span className={withClass("icon-label", props.className)} title={props.label}>
      <Icon name={props.icon} size={16} />
      <span className="sr-only">{props.label}</span>
    </span>
  );
}

/** Nothing here yet: one sentence on why, and at most one clear action. No illustrations. */
export function EmptyState(props: { title: string; body?: string; action?: ReactNode; icon?: IconName }) {
  return (
    <div className="empty">
      {props.icon ? (
        <span className="empty-icon">
          <Icon name={props.icon} size={20} />
        </span>
      ) : null}
      <h2>{props.title}</h2>
      {props.body ? <p>{props.body}</p> : null}
      {props.action ? <div className="empty-action">{props.action}</div> : null}
    </div>
  );
}

/**
 * A short list of steps with their state: a tick when done, a spinning ring while working, a dashed ring when waiting.
 * Each state is also spoken. `live` announces changes politely (for steps that update while the person watches).
 */
export function ProgressSteps(props: { steps: Array<{ label: string; state: StepState }>; label?: string; live?: boolean }) {
  const list = (
    <ol className="steps" aria-label={props.label}>
      {props.steps.map((s, i) => (
        <li key={`${i}-${s.label}`} data-state={s.state}>
          {s.state === "done" ? <Icon name="check" /> : s.state === "failed" ? <Icon name="alert" /> : s.state === "active" ? <span className="spinner" aria-hidden="true" /> : <span className="step-dot" aria-hidden="true" />}
          <span>
            {s.label}
            <span className="sr-only"> ({STEP_STATE_TEXT[s.state]})</span>
          </span>
        </li>
      ))}
    </ol>
  );
  return props.live ? <div role="status">{list}</div> : list;
}

/** Lines on their way: soft bars that fade (their widths vary by place, in styles.css). */
export function Skeleton(props: { lines?: number }) {
  return (
    <div className="stack" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: props.lines ?? 3 }).map((_, i) => <div key={i} className="skeleton" />)}
    </div>
  );
}

export function ErrorState(props: { message: string; onRetry?: () => void }) {
  return (
    <Alert tone="critical">
      <div className="row error-state">
        <span>{props.message}</span>
        {props.onRetry ? <Button size="sm" onClick={props.onRetry}>Try again</Button> : null}
      </div>
    </Alert>
  );
}

export function Segmented<T extends string>(props: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; ariaLabel?: string }) {
  return (
    <fieldset className="segmented" aria-label={props.ariaLabel}>
      {props.options.map((o) => (
        <button key={o.value} type="button" className={o.value === props.value ? "on" : ""} onClick={() => props.onChange(o.value)} aria-pressed={o.value === props.value}>
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

export function Timeline(props: { items: Array<{ when: string; what: string; who?: string }> }) {
  return (
    <ul className="timeline">
      {props.items.map((it, i) => (
        <li key={i}>
          <span className="when">{new Date(it.when).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
          <span>{it.what}{it.who ? <span className="muted"> · {it.who}</span> : null}</span>
        </li>
      ))}
    </ul>
  );
}

export function PipelineBar(props: { counts: Record<string, number>; total: number }) {
  // `waiting_on_candidate`: an offer made outside the app, waiting on the candidate's answer (plan H2)
  const parts: Array<[string, string]> = [["in_process", "var(--ink-2)"], ["waiting_on_you", "var(--caution-dot)"], ["waiting_on_candidate", "var(--ink-3)"], ["hired", "var(--good-dot)"], ["not_moving_forward", "var(--line-2)"]];
  return (
    <div className="pipeline" role="img" aria-label={`Pipeline: ${parts.map(([k]) => `${k.replace(/_/g, " ")} ${props.counts[k] ?? 0}`).join(", ")}`}>
      {parts.map(([k, color]) => {
        const n = props.counts[k] ?? 0;
        return n ? <span key={k} style={{ width: `${(n / Math.max(1, props.total)) * 100}%`, background: color }} title={`${k.replace(/_/g, " ")}: ${n}`} /> : null;
      })}
    </div>
  );
}

/** One message in a conversation; `from` says who wrote it (the name avoids the `role` ARIA attribute). */
export function Bubble(props: { from: "assistant" | "user" | "system"; children: ReactNode }) {
  return <div className={`bubble ${props.from}`}>{props.children}</div>;
}

/**
 * A table in a box that scrolls sideways when it must (docs/07). `head` takes words, or a TableHead: `num` for a column
 * of figures (right-aligned, heading included; give the cells className="num"), or `sort` and `onSort` for a heading
 * that sorts (from useTableSort). aria-sort is set on the sorted column only, and `announce` says a new order once,
 * politely. `scroll` keeps the headings in view in a long list on a wide screen; `pinFirst` keeps the first column in
 * view while a wide table scrolls sideways. `loading` shows that many quiet rows under the headings while the rows are
 * on their way; `empty` is the one row shown when there are none (a filter that found nothing), the headings kept.
 * Hook-free: server components import it.
 */
export function Table(props: { head: Array<string | TableHead>; children?: ReactNode; label?: string; scroll?: boolean; pinFirst?: boolean; loading?: number; empty?: ReactNode; announce?: string }) {
  const cols: TableHead[] = props.head.map((h) => (typeof h === "string" ? { label: h } : h));
  const loading = props.loading && props.loading > 0 ? props.loading : 0;
  const showEmpty = !loading && props.empty !== undefined && Children.toArray(props.children).length === 0;
  const live = loading > 0 || props.empty !== undefined || cols.some((c) => c.onSort);
  const status = loading ? "Loading…" : props.announce || (showEmpty && typeof props.empty === "string" ? props.empty : "");
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard (axe scrollable-region-focusable); the label names it for screen readers
    <section className={cx("table-wrap", props.scroll && "scroll", props.pinFirst && "pin-first")} tabIndex={0} aria-label={props.label ?? `Table: ${cols.map((c) => c.label).filter(Boolean).join(", ")}`}>
      <table className="table">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={`${i}-${c.label}`} scope="col" className={c.num ? "num" : undefined} aria-sort={c.onSort && c.sort ? c.sort : undefined}>
                {c.onSort ? (
                  <button type="button" className="th-sort" onClick={c.onSort}>
                    {c.label}
                    <Icon name={c.sort === "ascending" ? "chevron-up" : c.sort === "descending" ? "chevron-down" : "sort"} size={14} />
                  </button>
                ) : c.label || <span className="sr-only">Actions</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody aria-busy={loading ? true : undefined}>
          {loading
            ? Array.from({ length: loading }, (_, r) => (
                // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a placeholder row in a plain table is not focusable; it is hidden while the status line says "Loading…"
                <tr key={`loading-${r}`} aria-hidden="true">
                  {cols.map((c, i) => <td key={`${i}-${c.label}`} className={c.num ? "num" : undefined}><span className="skeleton" /></td>)}
                </tr>
              ))
            : showEmpty
              ? <tr><td colSpan={cols.length} className="table-empty">{props.empty}</td></tr>
              : props.children}
        </tbody>
      </table>
      {live ? <span className="sr-only" role="status">{status}</span> : null}
    </section>
  );
}

/** A figure and what it counts, for a report ("12" over "applicants in total"): the number large and tabular, the words under it. Not on Today (founder decision Q4). */
export function Stat(props: { n: number | string; label: string }) {
  return (
    <div className="stat">
      <span className="stat-n">{props.n}</span>
      <span className="stat-label">{props.label}</span>
    </div>
  );
}

/**
 * An icon on a soft rounded square (the briefcase beside a job, the sparkle in a message cell): lavender by default,
 * peach, plum or a signal tint; 32, 40 or 48 pixels. Decorative: the words beside it say what it stands for.
 */
export function IconChip(props: { icon: IconName; tone?: ChipTone; size?: "sm" | "md" | "lg"; className?: string }) {
  const size = props.size ?? "md";
  return (
    <span className={withClass(cx("icon-chip", props.tone ?? "lavender", size), props.className)} aria-hidden="true">
      <Icon name={props.icon} size={size === "sm" ? 16 : size === "lg" ? 22 : 18} />
    </span>
  );
}

/**
 * One card split into cells of figures (screenshots 1 and 4): put StatCells inside. `label` names the group for screen
 * readers. Only for numbers the page already shows; Today has none (founder decision Q4).
 */
export function StatStrip(props: { children: ReactNode; label?: string }) {
  return (
    <div className="stat-strip" role="group" aria-label={props.label}>
      {props.children}
    </div>
  );
}

/**
 * Draws a link with the app's own router Link instead of a plain <a>, so following it is no full page load (the page's
 * data stays): `(cell) => <Link to={cell.href} className={cell.className}>{cell.children}</Link>`.
 */
export type LinkRender = (cell: { href: string; className: string; children: ReactNode }) => ReactNode;

/**
 * One cell of a StatStrip: what it counts (small) over the figure (large, tabular), an optional icon chip on the left
 * and a line under the figure (`note`). `highlight` is the tinted cell for a message at the end of the strip. With
 * `href` the cell is a link with an arrow on the right: a plain <a>, or, for an address inside the app, the app's own
 * Link drawn by `link` (a LinkRender), so following it does not load the whole app again.
 */
export function StatCell(props: { label: ReactNode; value: ReactNode; icon?: IconName; tone?: "lavender" | "peach" | "plum"; note?: ReactNode; highlight?: boolean; href?: string; link?: LinkRender }) {
  const body = (
    <>
      {props.icon ? <IconChip icon={props.icon} tone={props.tone} /> : null}
      <span className="stat-cell-text">
        <span className="stat-cell-label">{props.label}</span>
        {props.value !== undefined && props.value !== null ? <span className="stat-cell-value">{props.value}</span> : null}
        {props.note ? <span className="stat-cell-note">{props.note}</span> : null}
      </span>
      {props.href ? (
        <span className="stat-cell-go" aria-hidden="true">
          <Icon name="arrow-right" size={16} />
        </span>
      ) : null}
    </>
  );
  const className = cx("stat-cell", props.highlight && "highlight");
  if (!props.href) return <div className={className}>{body}</div>;
  if (props.link) return props.link({ href: props.href, className, children: body });
  return (
    <a className={className} href={props.href}>
      {body}
    </a>
  );
}

/**
 * The head of a section on a page: an optional eyebrow, the heading (an H2 by default, display 24px; an H3 at 19px)
 * with a line under it, and an action on the right (a TextLink such as "All applicants"). `id` goes on the heading, for
 * aria-labelledby or a link to it.
 */
export function SectionHeader(props: { title: ReactNode; sub?: ReactNode; eyebrow?: ReactNode; action?: ReactNode; id?: string; level?: 2 | 3 }) {
  const Heading = props.level === 3 ? "h3" : "h2";
  return (
    <div className="section-header">
      <div className="section-header-text">
        {props.eyebrow ? <Eyebrow>{props.eyebrow}</Eyebrow> : null}
        <Heading id={props.id}>{props.title}</Heading>
        {props.sub ? <p className="section-header-sub">{props.sub}</p> : null}
      </div>
      {props.action ? <div className="section-header-action">{props.action}</div> : null}
    </div>
  );
}

export { cn } from "./cn";
export { Icon, ICON_NAMES, type IconName } from "./icons";
// The match score's breakdown (Wave F): bars per requirement, no hooks.
export { barFigures, barTone, ScoreBar, type ScoreBarItem, ScoreBars } from "./score-bars";
export { compareValues, cx, initials, nextSort, normalizeToast, numHead, OWNER_STAGES, type OwnerStage, ownerStage, SCORE_BANDS, type ScoreBand, scoreBand, scoreLabel, type SortDir, type SortKind, type SortValue, sortAnnouncement, sortRows, type StageChoice, stageMenuItems, type StepState, type TableHead, type TabOrientation, TOAST_ACTION_MAX_MS, TOAST_EVENT, type ToastAction, type ToastMessage, type ToastTone, type Tone, toastArrives, toastDuration, toastPayload } from "./helpers";

// The pieces below listen to the keyboard or keep state, which needs React hooks, so each lives in its own client
// module: the rest of this file stays usable from server components.
export { Dialog, Drawer, Sheet } from "./sheet";
export { type TabItem, TabPanel, Tabs } from "./tabs";
export { useTableSort } from "./table-sort";
export { SplitView } from "./split-view";
export { AutoTextarea } from "./auto-textarea";
export { Menu, type MenuItem, StageButton } from "./menu";
export { Toast, Toaster } from "./toast";
// Motion's provider (LazyMotion with domMax, strict, and MotionConfig reducedMotion="user"), mounted once by the shell.
export { MotionProvider } from "./motion-provider";
