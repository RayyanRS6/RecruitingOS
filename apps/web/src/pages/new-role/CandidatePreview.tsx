"use client";

import { useQuery } from "@tanstack/react-query";
import type { JobPreview } from "@ros/contracts";
import { Alert, Drawer, ErrorState, Icon, Skeleton } from "@ros/ui";
import { api } from "../../api/client";
import { previewPageHref } from "../../publishing";
import { errorWords } from "./rules";

const FACT_ICON = { location: "location", workplace: "building", job_type: "briefcase", pay: "pay", schedule: "clock" } as const;

/**
 * The job as a candidate will see it (plan C9), before anyone approves it: the server builds it by the public job page's
 * own rules (the notices for the place, whether pay is shown, the steps, the apply form's questions), from the draft or
 * from one of the role's versions (`path`, the refine API's preview address). It says plainly what is still missing.
 */
export function CandidatePreview(props: { open: boolean; onClose: () => void; path: string }) {
  const q = useQuery({ queryKey: ["job-preview", props.path], queryFn: () => api.get<JobPreview>(props.path), enabled: props.open, staleTime: 0 });
  const p = q.data;
  return (
    <Drawer open={props.open} onClose={props.onClose} title="What candidates will see" sub={p?.banner ?? "A preview of the job page. Nothing is public until the role is approved."} size="lg">
      {q.isLoading ? <Skeleton lines={6} /> : q.error || !p ? <ErrorState message={errorWords(q.error, "Could not load the preview.")} onRetry={() => q.refetch()} /> : (
        <>
          {/* The real page, drawn by the public pages' own components (plan D1); never public, never indexed. */}
          <p className="small" style={{ margin: "0 0 10px" }}><a href={previewPageHref(props.path)} target="_blank" rel="noopener noreferrer"><Icon name="eye" size={14} /> Open the full job page<span className="sr-only"> (opens in a new tab)</span></a></p>
          <JobPreviewBody p={p} />
        </>
      )}
    </Drawer>
  );
}

/**
 * The job page with changes that are not saved yet (plan D1, before an approver's change to a live job goes live): the
 * page drawn from `preview`, which the editor builds from the saved version's preview and the changed words.
 */
export function UnsavedPreview(props: { open: boolean; onClose: () => void; preview: JobPreview | null; loading: boolean; error: unknown; onRetry: () => void }) {
  const p = props.preview;
  return (
    <Drawer open={props.open} onClose={props.onClose} title="What candidates will see" sub={p?.banner ?? "Your changes, not saved yet."} size="lg">
      {props.loading ? <Skeleton lines={6} /> : props.error || !p ? <ErrorState message={errorWords(props.error, "Could not load the preview.")} onRetry={props.onRetry} /> : <JobPreviewBody p={p} />}
    </Drawer>
  );
}

/** The job page and the apply form's questions, as candidates would see them, with what is still missing on top. */
export function JobPreviewBody({ p }: { p: JobPreview }) {
  return (
    <div className="stack" style={{ gap: 14 }}>
      {p.gaps.length ? (
        <Alert tone="caution">
          <ul style={{ margin: 0, paddingLeft: 18 }}>{p.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
        </Alert>
      ) : null}
      <article className="job-preview" aria-label="Job page preview">
        <p className="eyebrow">Careers at {p.company.name}</p>
        <h1>{p.job.title}</h1>
        <ul className="job-preview-facts" aria-label="About this job">
          {p.job.facts.map((f) => (
            <li key={f.key} className="chip accent">
              <Icon name={FACT_ICON[f.key]} size={14} />
              <span className="sr-only">{f.label}: </span>
              {f.text}
            </li>
          ))}
        </ul>
        <section>
          <h2>About the job</h2>
          <p className="job-preview-desc">{p.job.description}</p>
          {/* The same blocks, in the same order, as the job page (plan D10). */}
          {p.job.mustHaves?.length ? <><h2>What we're looking for</h2><ul>{p.job.mustHaves.map((m) => <li key={m}>{m}</li>)}</ul></> : null}
          {p.job.niceToHaves?.length ? <><h2>Nice to have</h2><ul>{p.job.niceToHaves.map((m) => <li key={m}>{m}</li>)}</ul></> : null}
          {p.job.benefits ? <><h2>Benefits</h2><p className="job-preview-desc">{p.job.benefits}</p></> : null}
        </section>
        <section>
          <h2>What to expect</h2>
          <ol>{p.job.steps.map((s) => <li key={s}>{s}</li>)}</ol>
        </section>
        {p.company.about ? (
          <section>
            <h2>About {p.company.name}</h2>
            <p className="job-preview-desc">{p.company.about}</p>
          </section>
        ) : null}
        {p.pay.note ? <p className="small muted">{p.pay.note}</p> : null}
        {p.job.notices.map((n) => <p key={n.key} className="small muted">{n.text}</p>)}
      </article>
      {p.apply.questions.length ? (
        <section className="job-preview" aria-label="The application form">
          <h2>A few quick questions when they apply</h2>
          <ul>{p.apply.questions.map((a) => <li key={a.key}>{a.question}{a.help ? <span className="small muted"> {a.help}</span> : null}</li>)}</ul>
          <p className="small muted">{p.apply.disclosure} {p.apply.humanAlternative}</p>
        </section>
      ) : null}
    </div>
  );
}
