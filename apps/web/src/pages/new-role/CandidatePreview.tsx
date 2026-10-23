"use client";

import { useQuery } from "@tanstack/react-query";
import type { JobPreview } from "@ros/contracts";
import { Alert, Drawer, ErrorState, Eyebrow, Icon, Skeleton } from "@ros/ui";
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
    // the server's banner says which version this is and that it is not public; nothing stands in for it while loading
    <Drawer open={props.open} onClose={props.onClose} title="What candidates will see" sub={p?.banner} size="lg">
      {q.isLoading ? <Skeleton lines={6} /> : q.error || !p ? <ErrorState message={errorWords(q.error, "Could not load the preview.")} onRetry={() => q.refetch()} /> : (
        <>
          {/* The real page, drawn by the public pages' own components (plan D1); never public, never indexed. */}
          <p className="mb-5"><a href={previewPageHref(props.path)} target="_blank" rel="noopener noreferrer" className="text-link"><Icon name="eye" size={14} /> Open the full job page<span className="sr-only"> (opens in a new tab)</span></a></p>
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

/** A heading inside the job page, and its words (screenshot 5's left column: "About the work"). */
const JOB_H2 = "font-display text-[21px] font-bold leading-tight tracking-[-0.02em] text-ink";
/** A smaller heading under it (What we're looking for, Nice to have, Benefits). */
const JOB_SUB = "mt-3 font-display text-[17px] font-bold leading-tight tracking-[-0.015em] text-ink";
const JOB_TEXT ="whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink-2";
const JOB_LIST = "grid list-disc gap-1.5 pl-5 text-[14.5px] leading-relaxed text-ink-2 marker:text-ink-3";
/** A notice on the job page (pay, the law of the place): a soft lavender note with a shield, as the job page shows them. */
const JOB_NOTICE = "flex items-start gap-2.5 rounded-xl border border-line-tint bg-tint px-4 py-3 text-[13px] leading-snug text-ink-2";

/** The job page and the apply form's questions, as candidates would see them, with what is still missing on top. */
export function JobPreviewBody({ p }: { p: JobPreview }) {
  return (
    <div className="grid min-w-0 gap-6">
      {p.gaps.length ? (
        <Alert tone="caution">
          <ul className="grid list-disc gap-0.5 pl-[18px]">{p.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
        </Alert>
      ) : null}
      <article className="grid min-w-0 gap-7" aria-label="Job page preview">
        <header className="grid gap-3">
          <Eyebrow>Careers at {p.company.name}</Eyebrow>
          <h1 className="font-display text-[34px] font-bold leading-[1.02] tracking-[-0.04em] text-ink wrap-anywhere sm:text-[42px]">{p.job.title}</h1>
          {/* the facts in one row between two hairlines */}
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-2 border-y border-line py-3 text-[13.5px] text-ink-2" aria-label="About this job">
            {p.job.facts.map((f) => (
              <li key={f.key} className="inline-flex min-w-0 items-center gap-1.5 [&>.icon]:text-ink-3">
                <Icon name={FACT_ICON[f.key]} size={15} />
                <span className="sr-only">{f.label}: </span>
                {f.text}
              </li>
            ))}
          </ul>
        </header>
        <section className="grid gap-3">
          <h2 className={JOB_H2}>About the job</h2>
          <p className={JOB_TEXT}>{p.job.description}</p>
          {/* The same blocks, in the same order, as the job page (plan D10). */}
          {p.job.mustHaves?.length ? <><h2 className={JOB_SUB}>What we're looking for</h2><ul className={JOB_LIST}>{p.job.mustHaves.map((m) => <li key={m}>{m}</li>)}</ul></> : null}
          {p.job.niceToHaves?.length ? <><h2 className={JOB_SUB}>Nice to have</h2><ul className={JOB_LIST}>{p.job.niceToHaves.map((m) => <li key={m}>{m}</li>)}</ul></> : null}
          {p.job.benefits ? <><h2 className={JOB_SUB}>Benefits</h2><p className={JOB_TEXT}>{p.job.benefits}</p></> : null}
        </section>
        <section className="grid gap-3">
          <h2 className={JOB_H2}>What to expect</h2>
          <ol className="grid list-decimal gap-1.5 pl-5 text-[14.5px] leading-relaxed text-ink-2 marker:text-ink-3">{p.job.steps.map((s) => <li key={s}>{s}</li>)}</ol>
        </section>
        {p.company.about ? (
          <section className="grid gap-3">
            <h2 className={JOB_H2}>About {p.company.name}</h2>
            <p className={JOB_TEXT}>{p.company.about}</p>
          </section>
        ) : null}
        {p.pay.note || p.job.notices.length ? (
          <div className="grid gap-2">
            {p.pay.note ? <p className={JOB_NOTICE}><Icon name="shield" size={16} className="mt-px shrink-0 text-primary" />{p.pay.note}</p> : null}
            {p.job.notices.map((n) => <p key={n.key} className={JOB_NOTICE}><Icon name="shield" size={16} className="mt-px shrink-0 text-primary" />{n.text}</p>)}
          </div>
        ) : null}
      </article>
      {p.apply.questions.length || p.apply.quickQuestions?.length || p.apply.writtenQuestions ? (
        // the application form's questions, as screenshot 5's form card
        <section className="grid min-w-0 gap-3 rounded-2xl border border-line bg-surface p-5 shadow-xs" aria-label="The application form">
          <h2 className={JOB_H2}>Questions from {p.company.name}</h2>
          {p.apply.questions.length || p.apply.quickQuestions?.length ? (
            <ul className="divide-y divide-line text-[14.5px] text-ink [&>li]:py-2.5">
              {p.apply.questions.map((a) => <li key={a.key}>{a.question}{a.help ? <span className="small muted"> {a.help}</span> : null}</li>)}
              {(p.apply.quickQuestions ?? []).map((q) => (
                <li key={q.key}>
                  {q.question}{q.required ? null : <span className="small muted"> (optional)</span>}
                  {q.kind === "choice" && q.options.length ? <span className="small muted"> {q.options.join(" · ")}</span> : null}
                  {q.kind === "number" && q.unit ? <span className="small muted"> A number ({q.unit})</span> : null}
                  {q.help ? <span className="small muted"> {q.help}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {p.apply.writtenQuestions ? <p className="small">{p.apply.writtenQuestions} written {p.apply.writtenQuestions === 1 ? "question" : "questions"} in the chat.</p> : null}
          <p className="small muted">{p.apply.disclosure} {p.apply.humanAlternative}</p>
        </section>
      ) : null}
    </div>
  );
}
