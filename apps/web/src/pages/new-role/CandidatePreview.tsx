"use client";

import { useQuery } from "@tanstack/react-query";
import type { JobPreview } from "@ros/contracts";
import { Alert, Drawer, ErrorState, Icon, Skeleton } from "@ros/ui";
import { api } from "../../api/client";
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
            </section>
            <section>
              <h2>What to expect</h2>
              <ol>{p.job.steps.map((s) => <li key={s}>{s}</li>)}</ol>
            </section>
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
      )}
    </Drawer>
  );
}
