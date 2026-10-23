"use client";

import { type CSSProperties, Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRefresh, useSearchParams } from "../nav";
import { Alert, Button, Card, Chip, cn, EmptyState, ErrorState, Field, Icon, IconChip, IconLabel, type IconName, PageHeader, Pill, Skeleton, type Tone } from "@ros/ui";
import type { EscalationThreadEntry } from "@ros/contracts";
import { api, ApiError, type Me, type PostingTaskDetail } from "../api/client";
import { POSTING_TASK_BEFORE_ACCEPT, isPostingTaskKind, queueKindLabel } from "../publishing";
import { CALL_NOTES_HINT, CANDIDATE_ASKED_FOR_PERSON, draftFactLines, queueThreadHeading, workspaceHref, type HandedOverDraft } from "../recruiter-requests";
import { toast } from "../toast";
import { BoardSnapshotCard } from "./board/BoardSnapshot";
import { snapshotOf } from "./board/board-model";

/** Exactly what a recruiter sees before accepting (correction 11): no customer words, nothing from a candidate record. */
type Preview = { id: string; status: string; kind: string; urgency: "low" | "normal" | "high" | "critical"; requiredExpertise: string; summary: string; companyName: string; roleTitle: string | null; slaDueAt: string | null; slaRemainingMinutes: number | null; businessMinutesRemaining: number | null; overdue: boolean; createdAt: string; claimedByMe: boolean; claimed: boolean };
/** `postingTask`: an accepted ITS posting task (plan D3), the job ad and the board only; it never opens anything about candidates. */
type Detail = Preview & { accessGranted: boolean; why?: string | null; companyId?: string; roleId?: string | null; applicationId?: string | null; question?: string; contextSnapshot?: Record<string, unknown>; resolution?: string | null; minutesSpent?: number | null; firstResponseAt?: string | null; thread?: EscalationThreadEntry[]; reopenedCount?: number; grant?: { id: string; purpose: string; expiresAt: string; scope: { roleId: string | null; applicationId: string | null } }; postingTask?: PostingTaskDetail };

const URGENCY_TONE: Record<Preview["urgency"], Tone> = { low: "neutral", normal: "accent", high: "caution", critical: "critical" };
/** Urgency in plain words (Wave S6): the API's "critical" is what the customer chose as "Urgent". */
export const URGENCY_WORD: Record<Preview["urgency"], string> = { low: "Low", normal: "Normal", high: "High", critical: "Urgent" };

/** Where a request stands, in plain words: nobody has it yet, it is yours, another recruiter has it, done, withdrawn. */
export function queueStatusWord(e: Pick<Preview, "status" | "claimedByMe">): { label: string; tone: Tone } {
  if (e.status === "resolved") return { label: "Done", tone: "good" };
  if (e.status === "cancelled") return { label: "Withdrawn", tone: "neutral" };
  if (e.claimedByMe) return { label: "Yours", tone: "accent" };
  if (e.status === "open") return { label: "Waiting for someone", tone: "caution" };
  return { label: "Another recruiter has it", tone: "neutral" };
}

/**
 * Before accepting (founder decision I11): what Accept shows, then the access it gives. The preview never names the
 * candidate or carries the customer's words, so the recruiter learns who or what it is about (one candidate, one role,
 * or all of the customer's hiring) only after accepting.
 */
const BEFORE_ACCEPT = "Accept to open the full request and see who or what it is about. Your access covers only what the request is about, ends a day after it is resolved, and every page you open is recorded for the customer.";

function remainingText(e: Preview): string {
  if (e.businessMinutesRemaining == null) return "no deadline";
  const m = Math.abs(e.businessMinutesRemaining);
  const h = Math.floor(m / 60);
  const span = h ? `${h}h ${m % 60}m` : `${m}m`;
  return e.businessMinutesRemaining < 0 ? `overdue by ${span} of business time` : `${span} of business time left`;
}

/** The pills above the queue (Wave S6, 2.3): counted from what the list already says about each request. */
export const QUEUE_FILTERS = [
  { id: "all", label: "All" },
  { id: "waiting", label: "Waiting for someone" },
  { id: "yours", label: "Yours" },
  { id: "overdue", label: "Overdue" },
  { id: "done", label: "Done" },
] as const;
export type QueueShow = (typeof QUEUE_FILTERS)[number]["id"];
export type QueueView = { show: QueueShow; q: string };

/** The view kept in the address (`?show=overdue&q=bright`), so a reload or a shared link lands on the same list. */
export function queueViewFrom(search: URLSearchParams): QueueView {
  const show = search.get("show");
  const known = QUEUE_FILTERS.find((f) => f.id === show);
  return { show: known ? known.id : "all", q: (search.get("q") ?? "").slice(0, 200) };
}

export function queueSearch(view: QueueView): string {
  const out = new URLSearchParams();
  if (view.show !== "all") out.set("show", view.show);
  if (view.q.trim()) out.set("q", view.q);
  const qs = out.toString();
  return qs ? `?${qs}` : "";
}

function byCompany(rows: readonly Preview[], q: string): Preview[] {
  const needle = q.trim().toLowerCase();
  return needle ? rows.filter((e) => e.companyName.toLowerCase().includes(needle)) : [...rows];
}

/**
 * The requests one pill shows, after the company search. `queued` is the queue as the API sends it (open, accepted and
 * being worked on); `done` the resolved ones, read only once someone picks Done (null until then).
 */
export function queueShown(queued: readonly Preview[], done: readonly Preview[] | null, view: QueueView): Preview[] {
  if (view.show === "done") return byCompany(done ?? [], view.q);
  const rows = byCompany(queued, view.q);
  if (view.show === "waiting") return rows.filter((e) => e.status === "open" && !e.claimed);
  if (view.show === "yours") return rows.filter((e) => e.claimedByMe);
  if (view.show === "overdue") return rows.filter((e) => e.overdue);
  return rows;
}

/** Each pill's count, after the company search; Done is null until its list has been read. */
export function queueCounts(queued: readonly Preview[], done: readonly Preview[] | null, q: string): Record<QueueShow, number | null> {
  const count = (show: QueueShow) => queueShown(queued, done, { show, q }).length;
  return { all: count("all"), waiting: count("waiting"), yours: count("yours"), overdue: count("overdue"), done: done ? count("done") : null };
}

/**
 * What an empty list says: one line, and its one way back (the words on screen, 23 October: no second line explaining
 * it). A truly empty queue offers nothing.
 */
export function queueEmpty(view: QueueView, anyAtAll: boolean): { title: string; action: "all" | "clear" | null } {
  if (view.q.trim()) return { title: "No requests from a company by that name", action: "clear" };
  if (view.show === "waiting") return { title: "Nobody is waiting", action: "all" };
  if (view.show === "yours") return { title: "Nothing is yours right now", action: "all" };
  if (view.show === "overdue") return { title: "Nothing overdue", action: "all" };
  if (view.show === "done") return { title: "Nothing done yet", action: "all" };
  return anyAtAll ? { title: "Nothing to show", action: "all" } : { title: "Queue is empty", action: null };
}

/** The second line of a row: the expertise needed and the time left, or, once done, when it was asked. */
function deadlineLine(e: Preview): string {
  if (e.status === "resolved" || e.status === "cancelled") return `Needs ${e.requiredExpertise} · asked ${new Date(e.createdAt).toLocaleString()}`;
  return `Needs ${e.requiredExpertise} · ${remainingText(e)}${e.slaDueAt ? ` · respond by ${new Date(e.slaDueAt).toLocaleString()}` : ""}`;
}

/**
 * The staggered first appearance of a list's rows (styles.css `enter`): 30ms apart, the eighth and later together. Only
 * a row that is new to the page rises in; a refetch keeps the rows it already drew. Off for reduced motion. The delay
 * carries the same motion-safe: variant as the animation, so it comes after the `animation` shorthand in the CSS (an
 * unprefixed delay comes first and the shorthand resets it to 0s).
 */
const ENTER = "motion-safe:animate-enter motion-safe:[animation-delay:calc(var(--i)*30ms)]";
const stagger = (i: number) => ({ "--i": Math.min(i, 7) }) as CSSProperties;

/**
 * A queue row (the kit's .list-item): a tint under the mouse, the open request tinted with a plum bar on its left, and
 * the focus ring of its stretched link drawn round the whole row.
 */
const ROW = "list-item relative items-start hover:bg-surface-2/60 aria-[current=true]:bg-tint aria-[current=true]:shadow-[inset_3px_0_0_var(--primary)] has-[a:focus-visible]:outline-2 has-[a:focus-visible]:-outline-offset-2 has-[a:focus-visible]:outline-focus";
/**
 * The same row in the narrower list beside an open request (@3xl, see the page): its words keep the row's width and the
 * pills go to a line of their own under them, side by side and in line with the words; no arrow.
 */
const ROW_BESIDE = "@3xl:flex-wrap @3xl:gap-y-2";
const ROW_END_BESIDE = "@3xl:basis-full @3xl:flex-row @3xl:items-center @3xl:justify-start @3xl:gap-2 @3xl:pl-[46px]";

/**
 * The ITS recruiter queue (founder decision F10; correction 11). Before accepting, a recruiter sees the customer, the
 * role, the category, urgency, the expertise needed, the remaining service-level time and a generic summary. Accepting
 * creates a scoped, time-limited grant; the customer's own words and the full context open under it; every page is
 * recorded for the customer; releasing or resolving ends the access.
 *
 * ITS posting tasks (plan D3: post a job on a board, update a listing, take one down) sit in the same queue. Accepting
 * one grants nothing: it opens the job ad as the board will show it, the board's own apply link and the steps, and the
 * recruiter records the work right there. The task closes on its own once the listing is checked.
 *
 * Wave S6 (2.3): pills with counts above the list (All, Waiting for someone, Yours, Overdue, Done), a search by company,
 * plain words for urgency and status, and an empty state for each pill with one way back. The pill and the search live
 * in the address (`?show=`, `?q=`) and go with the link into a request, so reloading lands on the same view.
 *
 * The look (October 2026 redesign): the requests as the "Applications to pick up" rows of the reference desk (each row
 * opens its request; the open one is tinted), and on a wide screen the request's cards beside the list.
 */
export function RecruiterQueue() {
  const { id } = useParams();
  const list = useQuery({ queryKey: ["escalations"], queryFn: () => api.get<Preview[]>("/api/v1/escalations") });

  // The view (pill, search) lives in the address. Typing writes it with history.replaceState, which the router follows
  // without fetching the page again; a link that changes the address (the rail's Queue) resets the view.
  const [search] = useSearchParams();
  const urlKey = queueSearch(queueViewFrom(search));
  const [view, setViewState] = useState<QueueView>(() => queueViewFrom(search));
  const wrote = useRef(urlKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of the address's view re-reads it
  useEffect(() => {
    if (urlKey === wrote.current) return;
    wrote.current = urlKey;
    setViewState(queueViewFrom(search));
  }, [urlKey]);
  const setView = (patch: Partial<QueueView>) => {
    const next = { ...view, ...patch };
    setViewState(next);
    const qs = queueSearch(next);
    wrote.current = qs;
    try {
      window.history.replaceState(null, "", `${window.location.pathname}${qs}${window.location.hash}`);
    } catch {
      // the view still changes on screen; only the address is not updated
    }
  };

  // Done requests are not in the queue's list; they are read only when someone asks to see them.
  const done = useQuery({ queryKey: ["escalations", "done"], queryFn: () => api.get<Preview[]>("/api/v1/escalations?status=resolved"), enabled: view.show === "done" });
  const queued = list.data ?? [];
  const finished = done.data ?? null;
  const counts = queueCounts(queued, finished, view.q);
  const shown = queueShown(queued, finished, view);
  const empty = queueEmpty(view, queued.length > 0);
  const qs = queueSearch(view);
  const current = view.show === "done" ? done : list;
  const emptyAction = empty.action === "clear" ? <Button onClick={() => setView({ q: "" })}>Clear search</Button> : empty.action === "all" ? <Button onClick={() => setView({ show: "all" })}>Show all requests</Button> : undefined;

  return (
    <div>
      {/* the title alone (23 October: no eyebrow, no line describing the page); the queue's rules stay folded below */}
      <PageHeader title="Recruiter queue" />
      {/* a size container: the list and the open request go side by side from 48rem of room (@3xl), as the old wrapping
          layout did (a 300px list beside a 440px request), whether the rail is open or folded */}
      <div className="stack gap-5 @container">
        <details className="more">
          <summary>How the queue works</summary>
          <p className="small max-w-[70ch] text-ink-2">Urgency changes the order, never the reply-by time. Accept one to open the request itself; your access is limited to that request and ends a day after it is resolved.</p>
        </details>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <fieldset aria-label="Show requests" className="flex min-w-0 flex-wrap items-center gap-1.5">
            {QUEUE_FILTERS.map((f) => (
              <button key={f.id} type="button" className="toggle-chip" aria-pressed={view.show === f.id} onClick={() => setView({ show: f.id })}>
                {f.label}{counts[f.id] != null ? <> <span className="count">{counts[f.id]}</span></> : null}
              </button>
            ))}
          </fieldset>
          <div className="relative w-full sm:w-[260px]">
            <Icon name="search" size={16} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-ink-3" />
            <input className="input rounded-full pl-10" type="search" value={view.q} onChange={(ev) => setView({ q: ev.target.value })} placeholder="Search by company" maxLength={200} aria-label="Search requests by company" />
          </div>
        </div>
        {/* the list, and with the room for both the open request beside it (one under the other below that) */}
        <div className={cn("grid items-start gap-5", id && "@3xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]")}>
          <div className="stack min-w-0">
            {current.isLoading ? <Skeleton lines={4} /> : current.error ? <ErrorState message={view.show === "done" ? "Could not load the requests that are done." : "Could not load the queue."} onRetry={() => current.refetch()} /> : shown.length === 0 ? <EmptyState icon="inbox" title={empty.title} action={emptyAction} /> : (
              <ul className="list" aria-label="Requests">
                {shown.map((e, i) => {
                  const st = queueStatusWord(e);
                  const selected = e.id === id;
                  return (
                    // the request's link covers the whole row (its ::after), so the row opens it wherever it is pressed,
                    // and the row wears the keyboard focus ring the link would have drawn round its words only
                    <li key={e.id} className={cn(ROW, id && ROW_BESIDE, ENTER)} style={stagger(i)} aria-current={selected ? "true" : undefined}>
                      <IconChip icon={isPostingTaskKind(e.kind) ? "briefcase" : "message-circle"} tone={selected ? "plum" : "lavender"} size="sm" />
                      <span className="list-item-main">
                        <Link to={`/recruiter/queue/${e.id}${qs}`} className="text-[15px] leading-snug text-ink after:absolute after:inset-0 focus-visible:outline-none"><strong>{queueKindLabel(e.kind)} · {e.companyName}</strong></Link>
                        <span className="sub">{e.roleTitle ? `${e.roleTitle} · ` : ""}{e.summary}</span>
                        <span className={cn("sub", e.overdue && "font-medium text-critical")}>{deadlineLine(e)}</span>
                      </span>
                      <span className={cn("list-item-end sm:flex-col sm:items-end sm:gap-1.5", id && ROW_END_BESIDE)}>
                        <Pill size="sm" tone={URGENCY_TONE[e.urgency]}>{URGENCY_WORD[e.urgency]}</Pill>
                        <Pill size="sm" tone={st.tone}>{st.label}</Pill>
                      </span>
                      <Icon name="chevron-right" size={16} className={cn("chev mt-2 max-sm:hidden", id && "@3xl:hidden")} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {id ? <div className="min-w-0"><EscalationDetail id={id} /></div> : null}
        </div>
      </div>
    </div>
  );
}

const SPEAKER: Record<string, string> = { owner: "The customer", assistant: "The assistant", system: "Note" };

/** Which side of a conversation a message sits on: theirs on the left, ours (the person writing) on the right, a note in the middle. */
type Side = "left" | "right" | "note";
const BUBBLE: Record<Side, string> = { left: "bubble assistant", right: "bubble user", note: "bubble system" };

/**
 * One message of a conversation the recruiter reads (the guided chat's look, screenshot 3): who wrote it and when over
 * its bubble, with a small mark beside the other side's messages. New messages rise in; the words are the page's own.
 */
function Message(props: { side: Side; label: ReactNode; mark?: { icon: IconName; tone: "peach" | "lavender" }; children: ReactNode }) {
  return (
    <li className={cn("flex min-w-0 items-start gap-2.5 motion-safe:animate-enter", props.side === "right" && "flex-row-reverse", props.side === "note" && "justify-center")}>
      {/* the kit's icon chip, a little smaller than its sm size, level with the bubble under the label */}
      {props.mark ? <IconChip icon={props.mark.icon} tone={props.mark.tone} size="sm" className="mt-[22px] size-7 rounded-lg" /> : null}
      <div className={cn("grid min-w-0 gap-1", props.side === "right" ? "justify-items-end" : props.side === "note" ? "justify-items-center text-center" : "justify-items-start")}>
        <p className="text-[12px] text-ink-3">{props.label}</p>
        {props.children}
      </div>
    </li>
  );
}

/** The conversation's box: the page's paper behind the bubbles, as in the guided chat. */
const THREAD = "grid gap-4 rounded-2xl border border-line bg-ground p-3 sm:p-4";

/**
 * The draft a request is about (plan C12), as the customer was promised: who started it, what is known so far, the whole
 * conversation with the assistant (a pasted job ad folded away), and the draft written beside it. "Open the draft" goes
 * into the customer's workspace on that draft, where the recruiter can carry on.
 */
function DraftHandover({ draft, onOpen, opening }: { draft: HandedOverDraft; onOpen: (() => void) | null; opening: boolean }) {
  const facts = draftFactLines(draft.facts);
  const title = draft.draftPacket?.identity?.title ?? (typeof draft.facts.title === "string" ? draft.facts.title : null);
  return (
    <Card title={`The draft they asked about: ${title ?? "Untitled role"}`} aside={onOpen ? <Button size="sm" variant="primary" loading={opening} onClick={onOpen}>Open the draft</Button> : null}>
      <p className="small muted">Started by {draft.startedBy ?? "someone on their team"} · {draft.status === "active" ? "still being drafted" : draft.status === "compiled" ? "now a role" : "set aside"}. This is how it stood when they asked.</p>
      {facts.length ? <dl className="kv mt-3">{facts.map((f) => <Fragment key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></Fragment>)}</dl> : <p className="small muted mt-2">Nothing settled yet.</p>}
      {draft.missingFacts.length ? <p className="small mt-3 text-caution">Still missing: {draft.missingFacts.map((m) => m.replace(/_/g, " ")).join(", ")}</p> : null}
      <details className="more mt-4" open>
        <summary>The conversation with the assistant ({draft.messages.length})</summary>
        <ol aria-label="The conversation with the assistant" className={THREAD}>
          {draft.messages.map((m, i) => {
            // the customer wrote on the right, as they saw it in the job builder; the assistant answered on the left
            const side: Side = m.role === "owner" ? "right" : m.role === "system" ? "note" : "left";
            return (
              <Message key={`${i}-${m.at}`} side={side} mark={side === "left" ? { icon: "sparkles", tone: "peach" } : undefined} label={<>{SPEAKER[m.role] ?? m.role}{m.kind === "answers" ? " (tapped answers)" : ""} · {new Date(m.at).toLocaleString()}</>}>
                {m.kind === "pasted_ad" ? (
                  <div className={BUBBLE[side]}>
                    <details className="more">
                      <summary>A pasted job ad ({m.content.length.toLocaleString("en-US")} characters)</summary>
                      <p className="small whitespace-pre-wrap">{m.content}</p>
                    </details>
                  </div>
                ) : <p className={cn(BUBBLE[side], m.kind === "answers" && side !== "note" && "answers")}>{m.content}</p>}
              </Message>
            );
          })}
        </ol>
      </details>
      {draft.draftPacket?.description?.publicJobDescription ? <details className="more mt-4"><summary>The draft's job description</summary><p className="small whitespace-pre-wrap">{draft.draftPacket.description.publicJobDescription}</p></details> : <p className="small muted mt-4">No draft was written yet.</p>}
    </Card>
  );
}

const POSTING_STATE_TONE: Record<string, Tone> = { ready_to_post: "caution", posted_manually: "accent", live_verified: "good", failed: "critical", paused: "caution", closed: "neutral" };

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}.`), () => toast("Could not copy. Select the text and copy it by hand."));
}

/** A field and its button on one line, the button level with the field's box (they stack on a phone). */
const FIELD_ROW = "flex flex-wrap items-end gap-3";
const FIELD_GROW = "min-w-0 flex-[1_1_320px]";

/**
 * An accepted ITS posting task (plan D3): what to do, the job ad as the board will show it (the posting package, to
 * paste), the board's own apply link, the steps, and where the listing stands. The recruiter records the listing's
 * public address (the worker checks it, and the task closes once it is found), says they checked it themselves, says
 * the listing now shows the approved version, or that it is taken down. Nothing about candidates is on this card.
 */
function PostingTaskPanel({ id, task, status, onChanged }: { id: string; task: PostingTaskDetail; status: string; onChanged: () => void }) {
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const step = useMutation({
    mutationFn: (input: { path: "url" | "verify" | "updated" | "removed"; body?: Record<string, unknown>; done: string }) => api.post<{ status: string }>(`/api/v1/escalations/${id}/posting/${input.path}`, input.body ?? {}),
    onSuccess: (r, input) => { toast(input.done, r.status === "resolved" ? "The task is done and closed." : undefined); setUrl(""); setNote(""); onChanged(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "That did not go through. Try again."),
  });
  const p = task.posting;
  const open = status !== "resolved" && status !== "cancelled";
  const board = task.board.name;
  return (
    // the company and the job are in the request's title above; the ad's version goes with the package it versions
    <Card title={task.label} aside={<Pill size="sm" tone={POSTING_STATE_TONE[p.status] ?? "neutral"}>{p.stateLabel}</Pill>}>
      <p className="whitespace-pre-wrap">{task.whatToDo}</p>
      {p.externalUrl ? <p className="small mt-2 [overflow-wrap:anywhere]">On {board}: <a href={p.externalUrl} target="_blank" rel="noreferrer">{p.externalUrl}</a></p> : null}
      {p.verificationError ? <p className="small mt-2 text-critical">The last check of the address did not pass: {p.verificationError}</p> : null}
      {p.showsOldVersion ? <p className="small mt-2 text-caution">The listing shows an earlier version{p.boardVersion ? ` (version ${p.boardVersion})` : ""}.</p> : null}
      {task.applyUrl ? (
        <div className="row mt-3">
          <span className="small min-w-0 [overflow-wrap:anywhere]">{board}'s own apply link: <code className="rounded-md bg-surface-2 px-1.5 py-0.5">{task.applyUrl}</code></span>
          <Button size="sm" icon="copy" onClick={() => copy(task.applyUrl!, "the apply link")}>Copy</Button>
        </div>
      ) : null}
      {task.package ? (
        <details className="more mt-4" open={task.kind !== "take_down_job"}>
          <summary>The posting package (the job ad to paste){task.role.currentPacketVersion ? ` · version ${task.role.currentPacketVersion}` : ""}</summary>
          <pre className="mb-3">{task.package.text}</pre>
          <Button size="sm" icon="copy" onClick={() => copy(task.package!.text, "the posting package")}>Copy the package</Button>
        </details>
      ) : null}
      {task.steps.length ? <ol className="small mt-4 list-decimal space-y-1 pl-5 marker:text-ink-3">{task.steps.map((s, i) => <li key={`${id}-step-${i}`}>{s}</li>)}</ol> : null}
      {!open ? <div className="mt-4"><Alert tone="info">This task is {status === "cancelled" ? "withdrawn: the work no longer applies" : "done"}.</Alert></div> : (
        <div className="stack mt-5 gap-4 border-t border-line pt-5">
          {task.kind === "post_job" || task.kind === "update_job" ? (
            <div className={FIELD_ROW}>
              <div className={FIELD_GROW}>
                <Field label={p.externalUrl ? "A different public address for the listing" : "The listing's public address"} htmlFor={`task-url-${id}`}>
                  <input id={`task-url-${id}`} className="input" inputMode="url" value={url} onChange={(ev) => setUrl(ev.target.value)} placeholder="https://" />
                </Field>
              </div>
              <Button variant="primary" disabled={!url.trim()} loading={step.isPending && step.variables?.path === "url"} onClick={() => step.mutate({ path: "url", body: { url: url.trim() }, done: "Address recorded. Checking the link now." })}>Record the address</Button>
            </div>
          ) : null}
          {task.kind === "post_job" && p.externalUrl && ["posted_manually", "failed"].includes(p.status) ? (
            <div className={FIELD_ROW}>
              <div className={FIELD_GROW}>
                <Field label="Seen it live yourself? Say what you checked" htmlFor={`task-note-${id}`}><input id={`task-note-${id}`} className="input" value={note} onChange={(ev) => setNote(ev.target.value)} placeholder={`e.g. Opened the listing on ${board}; the title and apply link are right`} /></Field>
              </div>
              <Button disabled={note.trim().length < 3} loading={step.isPending && step.variables?.path === "verify"} onClick={() => step.mutate({ path: "verify", body: { note: note.trim() }, done: `${board} listing confirmed live, with your note.` })}>I checked it myself</Button>
            </div>
          ) : null}
          {task.kind === "update_job" ? (
            <div className={FIELD_ROW}>
              <div className={FIELD_GROW}>
                <Field label="What you updated (optional)" htmlFor={`task-upd-${id}`}><input id={`task-upd-${id}`} className="input" value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="e.g. Pasted the new package" /></Field>
              </div>
              <Button variant="primary" loading={step.isPending && step.variables?.path === "updated"} onClick={() => step.mutate({ path: "updated", body: note.trim() ? { note: note.trim() } : {}, done: `${board} listing shows the new version. Checking the link again.` })}>It shows the new version</Button>
            </div>
          ) : null}
          {task.kind === "take_down_job" ? (
            <div className="row">
              <Button variant="primary" loading={step.isPending && step.variables?.path === "removed"} onClick={() => step.mutate({ path: "removed", done: `Recorded: the job is off ${board}.` })}>It is taken down</Button>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/** The mark beside the customer's side of a request's conversation: the company, Recruiting OS itself, or a candidate. */
function customerMark(m: EscalationThreadEntry): IconName {
  return m.raisedBy === "system" ? "sparkles" : m.raisedBy === "candidate" ? "user" : "building";
}

function EscalationDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["escalation", id], queryFn: () => api.get<Detail>(`/api/v1/escalations/${id}`) });
  const [resolution, setResolution] = useState("");
  const [minutes, setMinutes] = useState("");
  const [reply, setReply] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["escalation", id] }); qc.invalidateQueries({ queryKey: ["escalations"] }); qc.invalidateQueries({ queryKey: ["me"] }); };
  // A posting task grants nothing (plan D3): accepting it opens the job ad and the board's link only.
  const claim = useMutation({ mutationFn: () => api.post(`/api/v1/escalations/${id}/claim`), onSuccess: () => { toast(isPostingTaskKind(q.data?.kind ?? "") ? "Accepted. The job ad and the board's apply link are open; nothing about candidates is." : "Accepted. Your access to this customer is now active."); refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not accept.") });
  const task = isPostingTaskKind(q.data?.kind ?? "");
  const release = useMutation({ mutationFn: () => api.post(`/api/v1/escalations/${id}/release`), onSuccess: () => { toast(task ? "Given back to the queue for another recruiter." : "Released. Your access ended."); refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not release.") });
  // Platform administrators can also open the customer in the console (Wave S6); ITS recruiters cannot open the console.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const isAdmin = me.data?.user.platformRole === "platform_admin";
  const resolve = useMutation({ mutationFn: () => api.post(`/api/v1/escalations/${id}/resolve`, { resolution, minutesSpent: minutes ? Number(minutes) : undefined }), onSuccess: () => { toast(task ? "Task closed with your note. The customer sees it on the job's Share tab." : "Resolved. The customer has your answer in full; your access ends in 24 hours."); setResolution(""); refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not resolve.") });
  // A message without resolving (plan B5): a question back, or progress. The person who asked and the owners read it in full.
  const write = useMutation({ mutationFn: () => api.post(`/api/v1/escalations/${id}/messages`, { body: reply.trim() }), onSuccess: () => { toast("Sent to the customer."); setReply(""); refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send.") });
  const refreshFrame = useRefresh();
  const enter = useMutation({
    mutationFn: async (e: Detail) => { await api.post("/api/v1/auth/switch", { companyId: e.companyId }); return e; },
    // Another company now: nothing read for the previous one may show (the cache is emptied), and the frame around the
    // page (the access notice, the company chip) is drawn again from the new session. A request about a draft opens that
    // draft in the job builder (C12); one about a role opens its candidates.
    onSuccess: (e) => { qc.clear(); nav(workspaceHref(e)); refreshFrame(); },
    onError: (err) => toast(err instanceof ApiError ? err.message : "Could not open the customer."),
  });
  if (q.isLoading) return <Skeleton lines={8} />;
  if (q.error || !q.data) return <ErrorState message="Could not load this request." onRetry={() => q.refetch()} />;
  const e = q.data;
  const ctx = (e.contextSnapshot ?? {}) as { company?: { name: string; vertical: string; sizeBand: string }; role?: { title: string; status: string }; packet?: { version: number; packet: { compensation: { basis: string; min: number; max: number; ceiling: number }; requirements: { mustHaves: Array<{ text: string }>; eligibility: Array<{ question: string }> }; description: { publicJobDescription: string } } }; candidate?: { name: string; email: string | null; phone: string | null }; application?: { stage: string }; resumeText?: string | null; assessments?: Array<{ kind: string; overall: string; result: { summary: string } }>; hiddenTextNote?: string | null; communications?: Array<{ direction: string; subject: string | null; at: string }>; timeline?: Array<{ type: string; at: string }>; intakeSession?: HandedOverDraft | null };
  const st = queueStatusWord(e);
  // The customer drawer in the console (Wave S6, 2.3): only once the request is accepted, and only for administrators.
  const consoleHref = isAdmin && e.companyId ? `/admin/customers?open=${encodeURIComponent(e.companyId)}` : null;
  // One action strip at the top (Wave S6, 2.3): Accept, then Open in the customer's workspace and Release under a grant.
  const hasActions = e.status === "open" || !!e.grant || !!consoleHref;
  // "What the request is about": the context cards, folded, with how many there are.
  const aboutCount = [ctx.company, ctx.intakeSession, ctx.role && ctx.packet, snapshotOf(e.contextSnapshot), ctx.candidate].filter(Boolean).length;
  const stillOpen = e.status !== "resolved" && e.status !== "cancelled";
  // Who the request is about, once accepted: the candidate's name opens only under the grant (founder decision I11).
  const aboutRole = ctx.role?.title ?? e.roleTitle;
  return (
    <div className="stack gap-4">
      <Card title={`${queueKindLabel(e.kind)} · ${e.companyName}${e.roleTitle ? ` · ${e.roleTitle}` : ""}`} aside={<div className="row justify-end gap-1.5"><Pill size="sm" tone={URGENCY_TONE[e.urgency]}>{URGENCY_WORD[e.urgency]}</Pill><Pill size="sm" tone={st.tone}>{st.label}</Pill></div>}>
        {e.accessGranted && ctx.candidate?.name ? <p className="mb-2"><strong>About:</strong> {ctx.candidate.name}{aboutRole ? ` · ${aboutRole}` : ""}</p> : null}
        {hasActions ? (
          <div className="row mb-4">
            {e.status === "open" ? <Button size="sm" variant="primary" loading={claim.isPending} onClick={() => claim.mutate()}>{isPostingTaskKind(e.kind) ? "Accept this task" : "Accept this request"}</Button> : null}
            {e.grant ? <Button size="sm" variant="secondary" loading={enter.isPending} onClick={() => enter.mutate(e)}>Open in the customer's workspace</Button> : null}
            {e.grant ? <Button size="sm" variant="quiet" loading={release.isPending} onClick={() => release.mutate()}>Release</Button> : null}
            {consoleHref ? <Link to={consoleHref} className="btn ghost sm">See this customer in the console</Link> : null}
          </div>
        ) : null}
        <p>{e.summary}</p>
        <p className="small muted mt-1.5">Needs {e.requiredExpertise} · {remainingText(e)}{e.slaDueAt ? ` · respond by ${new Date(e.slaDueAt).toLocaleString()}` : ""}{e.firstResponseAt ? ` · first response ${new Date(e.firstResponseAt).toLocaleString()}` : ""}</p>
        {e.grant ? <p className="small mt-2 text-ink-2">Your access covers {e.grant.scope.applicationId ? "this candidate" : e.grant.scope.roleId ? "this role" : "this customer"} and ends {new Date(e.grant.expiresAt).toLocaleString()}.</p> : null}
        {/* their reason is the "reopened it" message in the conversation below */}
        {e.reopenedCount ? <div className="mt-2"><Chip tone="caution">Reopened{e.reopenedCount > 1 ? ` ${e.reopenedCount} times` : ""}</Chip></div> : null}
        {e.accessGranted && e.thread?.length ? (
          <div className="mt-5 grid gap-2">
            <p className="eyebrow">The conversation</p>
            {/* the customer's side on the left, the ITS recruiters' (the reader's side) on the right */}
            <ol aria-label="The conversation" className={THREAD}>
              {e.thread.map((m) => (
                <Message key={m.id} side={m.side === "recruiter" ? "right" : "left"} mark={m.side === "recruiter" ? undefined : { icon: customerMark(m), tone: "lavender" }} label={<>{queueThreadHeading(m)} · {new Date(m.at).toLocaleString()}</>}>
                  <p className={BUBBLE[m.side === "recruiter" ? "right" : "left"]}>{m.body}</p>
                </Message>
              ))}
            </ol>
          </div>
        ) : e.accessGranted && e.question ? <div className="mt-5 grid gap-2"><p className="eyebrow">The request</p><p className="bubble assistant">{e.question}</p></div> : null}
        {e.resolution ? <div className="mt-4"><Alert tone="info">Resolved: {e.resolution}{e.minutesSpent != null ? ` (${e.minutesSpent} min)` : ""}</Alert></div> : null}
      </Card>
      {e.postingTask ? (
        <>
          <PostingTaskPanel id={e.id} task={e.postingTask} status={e.status} onChanged={refresh} />
          {stillOpen ? (
            <Card title="Cannot do it?" aside={<IconLabel icon="eye" label="The customer's owners and admins read this in full, on the job's Share tab and in their updates." />}>
              <Field label="Say why, and what the customer should know" htmlFor="task-res"><textarea id="task-res" className="textarea" value={resolution} onChange={(ev) => setResolution(ev.target.value)} placeholder="e.g. The company's LinkedIn page has no job slots left; they need to buy one first." /></Field>
              <div className="row mt-4">
                <Button loading={resolve.isPending} disabled={!resolution.trim()} onClick={() => resolve.mutate()}>Close the task with this note</Button>
                <Button variant="quiet" loading={release.isPending} onClick={() => release.mutate()}>Give it back to the queue</Button>
              </div>
            </Card>
          ) : null}
        </>
      ) : !e.accessGranted ? (
        <Alert tone="neutral">{isPostingTaskKind(e.kind) ? POSTING_TASK_BEFORE_ACCEPT : e.why === "claim it to open the full context" ? BEFORE_ACCEPT : e.why}</Alert>
      ) : (
        <>
          {/* A candidate who chose a person over the assistant (plan E3, Q16): the call, then the notes on their AI interview tab. */}
          {e.kind === CANDIDATE_ASKED_FOR_PERSON && e.applicationId && e.status !== "resolved" ? (
            <Card needsYou title="After you talk with them">
              <p className="small text-ink-2">{CALL_NOTES_HINT}</p>
              {e.grant ? <div className="row mt-4"><Button size="sm" variant="primary" loading={enter.isPending} onClick={() => enter.mutate(e)}>Open the candidate's AI interview tab</Button></div> : null}
            </Card>
          ) : null}
          {aboutCount ? (
            <details className="more">
              <summary>What the request is about ({aboutCount})</summary>
              <div className="stack gap-4">
                {ctx.company ? <Card title="Company"><dl className="kv"><dt>Name</dt><dd>{ctx.company.name}</dd><dt>Vertical</dt><dd>{ctx.company.vertical}</dd><dt>Size</dt><dd>{ctx.company.sizeBand}</dd></dl></Card> : null}
                {ctx.intakeSession ? <DraftHandover draft={ctx.intakeSession} onOpen={e.grant ? () => enter.mutate(e) : null} opening={enter.isPending} /> : null}
                {ctx.role && ctx.packet ? (
                  <Card title={`Role: ${ctx.role.title} (packet v${ctx.packet.version})`}>
                    <dl className="kv">
                      <dt>Status</dt><dd>{ctx.role.status}</dd>
                      <dt>Pay</dt><dd>{ctx.packet.packet.compensation.min}–{ctx.packet.packet.compensation.max} {ctx.packet.packet.compensation.basis}, ceiling {ctx.packet.packet.compensation.ceiling}</dd>
                      <dt>Must-haves</dt><dd>{ctx.packet.packet.requirements.mustHaves.map((m) => m.text).join("; ")}</dd>
                      <dt>Eligibility</dt><dd>{ctx.packet.packet.requirements.eligibility.map((m) => m.question).join("; ")}</dd>
                    </dl>
                    <details className="more mt-4"><summary>Public description</summary><p className="small whitespace-pre-wrap">{ctx.packet.packet.description.publicJobDescription}</p></details>
                  </Card>
                ) : null}
                {/* "Have a recruiter check this" from the pool board (plan F9): the board as it stood when they asked. */}
                {snapshotOf(e.contextSnapshot) ? <BoardSnapshotCard snapshot={snapshotOf(e.contextSnapshot)!} /> : null}
                {ctx.candidate ? (
                  <Card title={`Candidate: ${ctx.candidate.name}`}>
                    <dl className="kv"><dt>Email</dt><dd>{ctx.candidate.email ?? "none"}</dd><dt>Phone</dt><dd>{ctx.candidate.phone ?? "none"}</dd><dt>Stage</dt><dd>{ctx.application?.stage}</dd></dl>
                    {ctx.assessments?.length ? <div className="mt-4 grid gap-2">{ctx.assessments.map((a, i) => <p key={i} className="small"><Chip>{a.kind}</Chip> {a.overall}: {a.result.summary}</p>)}</div> : null}
                    {/* L-08 B: the same neutral line the team sees on the candidate panel */}
                    {ctx.hiddenTextNote ? <p className="small muted mt-3">{ctx.hiddenTextNote}</p> : null}
                    {ctx.resumeText ? <details className="more mt-4"><summary>Resume text</summary><pre>{ctx.resumeText}</pre></details> : null}
                    {ctx.communications?.length ? <details className="more mt-4"><summary>Messages ({ctx.communications.length})</summary><div className="grid gap-2.5">{ctx.communications.map((m, i) => <div key={i} className="small"><strong>{m.direction}: {m.subject}</strong><br /><span className="muted">{new Date(m.at).toLocaleString()}</span></div>)}</div></details> : null}
                    {ctx.timeline?.length ? <details className="more mt-4"><summary>Timeline ({ctx.timeline.length})</summary><ul className="small list-disc space-y-1 pl-5 marker:text-ink-3">{ctx.timeline.map((t, i) => <li key={i}>{new Date(t.at).toLocaleString()} · {t.type}</li>)}</ul></details> : null}
                  </Card>
                ) : null}
              </div>
            </details>
          ) : null}
          {/* "Your answer" (Wave S6, 2.3): a message without resolving, and the resolution, under one heading. */}
          {e.status !== "resolved" ? (
            <Card title="Your answer">
              <div className="stack gap-6">
                {stillOpen ? (
                  <section aria-labelledby="answer-write" className="stack gap-3">
                    {/* who reads it: an eye with the words as its name and tooltip, beside the heading */}
                    <div className="flex items-center gap-2">
                      <h3 id="answer-write" className="text-[15px]">Write to the customer</h3>
                      <IconLabel icon="eye" label="The person who asked and the owners read it in full on Today." />
                    </div>
                    <Field label="A question or an update, without resolving the request" htmlFor="reply"><textarea id="reply" className="textarea" value={reply} onChange={(ev) => setReply(ev.target.value)} /></Field>
                    <div><Button variant="secondary" loading={write.isPending} disabled={!reply.trim()} onClick={() => write.mutate()}>Send</Button></div>
                  </section>
                ) : null}
                <section aria-labelledby="answer-resolve" className={cn("stack gap-3", stillOpen && "border-t border-line pt-6")}>
                  <h3 id="answer-resolve" className="text-[15px]">Resolve</h3>
                  <Field label="What you did or advised (the customer reads this in full)" htmlFor="res"><textarea id="res" className="textarea" value={resolution} onChange={(ev) => setResolution(ev.target.value)} /></Field>
                  <Field label="Minutes spent" htmlFor="mins"><input id="mins" className="input max-w-[160px]" type="number" min={0} max={1440} value={minutes} onChange={(ev) => setMinutes(ev.target.value)} /></Field>
                  <div><Button variant="primary" loading={resolve.isPending} disabled={!resolution.trim()} onClick={() => resolve.mutate()}>Mark resolved</Button></div>
                </section>
              </div>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
