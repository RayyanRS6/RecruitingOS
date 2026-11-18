"use client";

import { useQuery } from "@tanstack/react-query";
import { appPaths, type HomeJob, type HomeNotice, type HomeView } from "@ros/contracts";
import { Alert, Card, ErrorState, Icon, IconChip, PageHeader, Pill, SectionHeader, Skeleton } from "@ros/ui";
import { api, type Me } from "../api/client";
import { DraftRows } from "../components/DraftRows";
import { OwnRequest } from "../components/OwnRequest";
import { Upgrade } from "../components/Upgrade";
import { useIsClient } from "../components/use-is-client";
import { greeting, homeJobRow, KEEP_CURRENT, noticeAsk } from "../home";
import { Link } from "../nav";
import { useSignInWhenSessionEnds } from "../session-ended";
import { StartBox } from "./builder/StartBox";
import { LINKED_ROW, ROW_ABOVE, ROW_TITLE } from "./look";

/**
 * Home: the greeting, anything about the plan the company should know, the start-a-hire box (what is typed there opens
 * the job builder on a new draft), this person's unfinished drafts, and the company's open and paused jobs, the one
 * with the most to review first, each with how many are new to review and how many finished the AI interview.
 */
export function Home() {
  const home = useQuery({ queryKey: ["home"], queryFn: () => api.get<HomeView>("/api/v1/home"), ...KEEP_CURRENT });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  // A tab left open past the session goes to sign in instead of "Could not load".
  useSignInWhenSessionEnds([home.error, me.error]);
  // The reader's own clock once the page is theirs; until then the hour in UTC, the same on the server and in the browser.
  const isClient = useIsClient();
  const now = new Date();
  const view = home.data;
  return (
    <div className="stack gap-6 md:gap-8">
      <PageHeader hero className="mb-0" title={greeting(isClient ? now.getHours() : now.getUTCHours(), me.data?.user.name)} />
      <OwnRequest />
      {view?.notices.map((n) => <Notice key={n.kind} notice={n} />)}
      <Card
        title={<>
          <span aria-hidden="true" className="mr-3.5 inline-grid size-10 place-items-center rounded-full border border-line-2 bg-surface align-middle text-ink-2 shadow-xs">
            <Icon name="message-circle" size={18} />
          </span>
          Who are you hiring?
        </>}
        className="border-line-tint bg-linear-150 from-tint/70 via-surface via-55% to-peach/60"
      >
        <StartBox room={view?.room} />
      </Card>
      {home.isLoading ? <Skeleton lines={4} /> : home.error || !view ? <ErrorState message="Could not load your jobs." onRetry={() => home.refetch()} /> : (
        <>
          {view.drafts.length ? (
            <section className="min-w-0">
              <SectionHeader title="Drafts" />
              <DraftRows drafts={view.drafts} label="Your drafts" />
            </section>
          ) : null}
          {view.jobs.length ? (
            <section className="min-w-0">
              <SectionHeader title="Your jobs" action={<Link to={appPaths.jobs} className="text-link pointer-coarse:min-h-10">All jobs<Icon name="arrow-right" size={16} /></Link>} />
              <ul className="list-card" aria-label="Your jobs">
                {view.jobs.map((j) => <JobRow key={j.id} job={j} />)}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A line about the plan: the trial ending or ended, the AI help running low or used up, with the way to ask for more. */
function Notice({ notice }: { notice: HomeNotice }) {
  return (
    <Alert tone="caution">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0"><strong>{notice.title}</strong> {notice.body}</span>
        {notice.upgrade ? <Upgrade size="sm" reason={noticeAsk(notice.kind)} /> : null}
      </div>
    </Alert>
  );
}

/** One job: its title opens its candidates, and each count opens the people it counts. */
function JobRow({ job }: { job: HomeJob }) {
  const row = homeJobRow(job);
  return (
    <li className={LINKED_ROW}>
      <span className="list-row-lead"><IconChip icon="briefcase" size="sm" /></span>
      <span className="list-row-main">
        <Link to={row.href} className={ROW_TITLE}>{row.title}</Link>
        <span className="list-row-meta">
          {row.toReview ? <Link to={row.toReview.href} className={`link-like ${ROW_ABOVE}`}>{row.toReview.text}</Link> : null}
          {row.interviewed ? <Link to={row.interviewed.href} className={`link-like ${ROW_ABOVE}`}>{row.interviewed.text}</Link> : null}
          <span>{row.applicants}</span>
        </span>
      </span>
      {row.status ? <span className="list-row-end"><Pill size="sm" tone="caution">{row.status}</Pill></span> : null}
      <Icon name="arrow-right" className="chev max-sm:hidden" />
    </li>
  );
}
