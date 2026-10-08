import type { ReactNode } from "react";
import { cx, initials, type StepState, STEP_STATE_TEXT, scoreBand, scoreLabel, type Tone } from "./helpers";
import { Icon, type IconName } from "./icons";

/**
 * Design system components (docs/07). Styling lives in tokens.css; these are semantic wrappers. Nothing in this file uses
 * a React hook, because server components import it (the shell's loading screen does). Components that need state or
 * document listeners live in their own "use client" modules and are re-exported at the bottom.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "quiet" | "destructive";

/**
 * A button. Primary is near-black, secondary is outlined, ghost has no box, danger is for the few actions that cannot be
 * taken back ("quiet" and "destructive" are the earlier names for ghost and danger). `kbd` shows a keyboard hint and
 * announces it as the shortcut.
 */
export function Button(props: { children: ReactNode; variant?: ButtonVariant; size?: "sm" | "md"; onClick?: () => void; type?: "button" | "submit"; disabled?: boolean; loading?: boolean; title?: string; icon?: IconName; iconEnd?: IconName; kbd?: string; ariaLabel?: string; block?: boolean }) {
  const { variant = "secondary", size = "md" } = props;
  return (
    <button type={props.type ?? "button"} className={cx("btn", variant, size === "sm" && "sm", props.block && "block")} onClick={props.onClick} disabled={props.disabled || props.loading} title={props.title} aria-label={props.ariaLabel} aria-busy={props.loading} aria-keyshortcuts={props.kbd}>
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
export function IconButton(props: { icon: IconName; label: string; onClick?: () => void; size?: "sm" | "md"; disabled?: boolean; type?: "button" | "submit" }) {
  return (
    <button type={props.type ?? "button"} className={cx("icon-btn", props.size === "sm" && "sm")} aria-label={props.label} title={props.label} onClick={props.onClick} disabled={props.disabled}>
      <Icon name={props.icon} size={props.size === "sm" ? 16 : 18} />
    </button>
  );
}

/** A keyboard hint ("N"). Inside a button it is hidden from screen readers, which hear the shortcut from the button. */
export function Kbd(props: { children: ReactNode; decorative?: boolean }) {
  return <kbd className="kbd" aria-hidden={props.decorative || undefined}>{props.children}</kbd>;
}

export function Card(props: { children: ReactNode; needsYou?: boolean; lift?: boolean; title?: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={cx("card", props.needsYou && "needs-you", props.lift && "lift", props.className)}>
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

export function Chip(props: { children: ReactNode; tone?: "neutral" | "accent" | "needs" | "good" | "caution" | "critical" | "source"; icon?: IconName }) {
  return (
    <span className={`chip ${props.tone ?? "neutral"}`}>
      {props.icon ? <Icon name={props.icon} size={14} /> : null}
      {props.children}
    </span>
  );
}

/**
 * A status pill: a dot and a word ("Live", "Draft", "On hold"). The word carries the meaning; the colour only helps a
 * glance. `solid` is for a finished state (Hired); `pulse` is for something live right now.
 */
export function Pill(props: { children: ReactNode; tone?: Tone; dot?: boolean; solid?: boolean; pulse?: boolean; icon?: IconName; size?: "sm" | "md"; title?: string }) {
  const tone = props.tone ?? "neutral";
  const mark = props.icon ? <Icon name={props.icon} size={14} /> : props.dot === false ? null : <span className={cx("dot", props.pulse && "pulse")} aria-hidden="true" />;
  return (
    <span className={cx("pill", tone, props.solid && "solid", props.size === "sm" && "sm")} title={props.title}>
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

/** The small uppercase, letter-spaced label above a title ("Role · Bright Dental"). Written in normal case; CSS raises it. */
export function Eyebrow(props: { children: ReactNode; icon?: IconName; as?: "p" | "div" | "span" }) {
  const Tag = props.as ?? "p";
  return (
    <Tag className="eyebrow">
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

export function Alert(props: { children: ReactNode; tone?: "info" | "caution" | "critical" | "neutral" }) {
  return <div className={`alert ${props.tone ?? "neutral"}`} role={props.tone === "critical" ? "alert" : "status"}>{props.children}</div>;
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
      {props.action ? <div style={{ marginTop: 10 }}>{props.action}</div> : null}
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

export function Skeleton(props: { lines?: number }) {
  return (
    <div className="stack" role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: props.lines ?? 3 }).map((_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 12}%`, height: 14 }} />)}
    </div>
  );
}

export function ErrorState(props: { message: string; onRetry?: () => void }) {
  return (
    <Alert tone="critical">
      <div className="row" style={{ justifyContent: "space-between" }}>
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
  const parts: Array<[string, string]> = [["in_process", "var(--ink-2)"], ["waiting_on_you", "var(--caution-dot)"], ["hired", "var(--good-dot)"], ["not_moving_forward", "var(--line-2)"]];
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

export function Table(props: { head: string[]; children: ReactNode; label?: string }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard (axe scrollable-region-focusable); the label names it for screen readers
    <section className="table-wrap" tabIndex={0} aria-label={props.label ?? `Table: ${props.head.filter(Boolean).join(", ")}`}>
      <table className="table">
        <thead>
          <tr>{props.head.map((h, i) => <th key={`${i}-${h}`}>{h || <span className="sr-only">Actions</span>}</th>)}</tr>
        </thead>
        <tbody>{props.children}</tbody>
      </table>
    </section>
  );
}

export { Icon, ICON_NAMES, type IconName } from "./icons";
export { cx, initials, normalizeToast, OWNER_STAGES, type OwnerStage, ownerStage, SCORE_BANDS, type ScoreBand, scoreBand, scoreLabel, type StageChoice, stageMenuItems, type StepState, TOAST_EVENT, type ToastMessage, type ToastTone, type Tone, toastDuration, toastPayload } from "./helpers";

// The pieces below listen to the keyboard or keep state, which needs React hooks, so each lives in its own client
// module: the rest of this file stays usable from server components.
export { Dialog, Drawer, Sheet } from "./sheet";
export { type TabItem, TabPanel, Tabs } from "./tabs";
export { SplitView } from "./split-view";
export { AutoTextarea } from "./auto-textarea";
export { Menu, type MenuItem, StageButton } from "./menu";
export { Toast, Toaster } from "./toast";
