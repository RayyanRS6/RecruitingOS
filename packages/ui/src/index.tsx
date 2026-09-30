import type { ReactNode } from "react";

/** Design system components (docs/07). Styling lives in tokens.css; these are semantic wrappers. */

export function Button(props: { children: ReactNode; variant?: "primary" | "secondary" | "quiet" | "destructive"; size?: "sm" | "md"; onClick?: () => void; type?: "button" | "submit"; disabled?: boolean; loading?: boolean; title?: string }) {
  const { variant = "secondary", size = "md" } = props;
  return (
    <button type={props.type ?? "button"} className={`btn ${variant} ${size === "sm" ? "sm" : ""}`} onClick={props.onClick} disabled={props.disabled || props.loading} title={props.title} aria-busy={props.loading}>
      {props.loading ? "Working…" : props.children}
    </button>
  );
}

export function Card(props: { children: ReactNode; needsYou?: boolean; lift?: boolean; title?: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <section className={`card ${props.needsYou ? "needs-you" : ""} ${props.lift ? "lift" : ""} ${props.className ?? ""}`}>
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

export function Chip(props: { children: ReactNode; tone?: "neutral" | "accent" | "needs" | "good" | "caution" | "critical" | "source" }) {
  return <span className={`chip ${props.tone ?? "neutral"}`}>{props.children}</span>;
}

/** Plain-language application status. Owner Mode never shows raw stage names. */
export function StatusChip(props: { stage: string; label: string; group?: string }) {
  const tone = props.group === "waiting_on_you" ? "needs" : props.group === "hired" ? "good" : props.group === "not_moving_forward" ? "neutral" : "accent";
  return <Chip tone={tone}>{props.label}</Chip>;
}

export function EvidenceChip(props: { source: string }) {
  return <Chip tone="source">{props.source.replace("_", " ")}</Chip>;
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

export function EmptyState(props: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{props.title}</h2>
      {props.body ? <p style={{ marginTop: 6 }}>{props.body}</p> : null}
      {props.action ? <div style={{ marginTop: 14 }}>{props.action}</div> : null}
    </div>
  );
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
    <fieldset className="segmented" aria-label={props.ariaLabel} style={{ border: 0, padding: 0, margin: 0 }}>
      {props.options.map((o) => (
        <button key={o.value} type="button" className={o.value === props.value ? "on" : ""} onClick={() => props.onChange(o.value)} aria-pressed={o.value === props.value}>
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

// The sheet listens for Escape on the document, which needs a React hook, so it lives in its own client module: the
// rest of this file stays usable from server components (the shell's loading screen imports it).
export { Sheet } from "./sheet";

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
  const parts: Array<[string, string]> = [["in_process", "var(--accent)"], ["waiting_on_you", "var(--needs-you)"], ["hired", "var(--good)"], ["not_moving_forward", "var(--line)"]];
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
