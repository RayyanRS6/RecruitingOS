"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, ErrorState, Field, Icon, numHead, Pill, Sheet, Skeleton, Table, type Tone } from "@ros/ui";
import { api, ApiError, type ApplicationLink, type Posting, type PostingView, type PostingsResponse, type RoleDetail, type VolumeReport, type WhoPosts } from "../api/client";
import { POSTING_WAITS_FOR_CHECK } from "../company-check";
import { BoardTicks } from "../components/BoardTicks";
import { ClosingDateField } from "../components/ClosingDate";
import { LinkedInPost } from "../components/LinkedInPost";
import { ShareJob } from "../components/ShareJob";
import { useCompanyCheck } from "../components/use-company-check";
import { scrollBehavior } from "../motion";
import { toast } from "../toast";
import { ACCEPTING_LABEL } from "../role-status";
import { boardNames } from "../role-words";
import { linkedInPostLink } from "../linkedin-post";

/**
 * The Share tab (once called Posting) and the header pieces of the job page (docs/spec/20 section 2, items 9 to 17;
 * plan Wave D; Wave S1). A posting is one role on one channel; unless the company posts itself, ITS posts to the boards
 * by hand from the company's own account (an ITS posting task per board, plan D3), records the public address, and the
 * worker checks it before anything is called live. Every state on screen says what happens next.
 *
 * The tab leads with the job's public link (share it, copy it, open it), then a LinkedIn post to copy (Wave S2), then
 * where it is posted and the closing date; each board's own card, the tracked links and the counts by source sit
 * underneath, folded away until opened (a board that needs the team starts open). Home's cards and the jobs list link
 * straight to parts of it (`#share`, `#linkedin`, `#closing-date`).
 *
 * Every change here needs role.manage (owner, admin, recruiter). Anyone else (a hiring manager, HR, an interviewer)
 * sees the same tab read-only, with one line saying who can change it, instead of buttons the API always refuses.
 * Sharing is the exception: whoever approves roles may share the job too.
 */

/** What the read-only tab says to someone without role.manage. */
export const READ_ONLY_POSTINGS = "Only an owner or an admin changes where this job is posted. You can see everything here.";

/** The dot beside each posting state: green once a check proved it live, amber while it waits on a person or is paused. */
const STATE_TONE: Record<string, Tone> = { draft: "neutral", approved: "neutral", ready_to_post: "caution", posted_manually: "accent", submitted_integration: "accent", live_verified: "good", paused: "caution", failed: "critical", closed: "neutral" };

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}.`), () => toast("Could not copy. Select the text and copy it by hand."));
}
function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "";
}
function who(by: Posting["verifiedBy"]): string {
  if (!by) return "a team member";
  return by.kind === "system" ? "the automatic check" : by.name ?? "a team member";
}
function message(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

/** The worker records a check failure as `<reason>: <detail>`; the owner reads it in plain words, with the detail kept when it is a sentence of its own. */
const CHECK_FAILURE_WORDS: Record<string, string> = { title_mismatch: "the page opened but does not show this job's title", unreachable: "the page could not be reached", status: "the board answered with an error" };
export function plainCheckFailure(raw: string | null | undefined): string {
  if (!raw) return "the page could not be read";
  const cut = raw.indexOf(": ");
  const code = (cut === -1 ? raw : raw.slice(0, cut)).trim();
  const detail = cut === -1 ? "" : raw.slice(cut + 2).trim();
  const words = CHECK_FAILURE_WORDS[code];
  if (!words) return raw;
  // the title detail only restates the words; an HTTP code or a timeout adds something
  const readable = code !== "title_mismatch" && detail.length > 0 && detail.length <= 160 && /^[a-z]/i.test(detail) && !/\b(Error|Exception|ECONN|ENOTFOUND|at \w+ \()/.test(detail);
  return readable ? `${words}: ${detail}` : words;
}
/** How many checks a failed posting went through, from the worker's own message. */
function checksIn(error: string | null | undefined): string {
  const m = /after (\d+) checks?/.exec(error ?? "");
  return m ? `after ${m[1]} ${m[1] === "1" ? "check" : "checks"}` : "";
}
/** Plain-language time zone name for the report ("Pacific Daylight Time"); the zone id itself when the browser cannot name it. */
function zoneName(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "long" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** Starts one posting action; `onSuccess` runs only once the API has accepted it, so a form keeps what was typed when the request fails. */
type Run = (channel: string, action: string, done: string, body?: unknown, onSuccess?: () => void) => void;

/* ------------------------------------------------------------------------------------------------------------ */
/* Header pieces: the accepting switch, the closed banner, the "still up" alert                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** The accepting-applications switch's three ways: stop, take them again, or (after the closing date) a later date. */
export type AcceptingMode = "stop" | "reopen" | "extend";

/** Which way the switch goes now for a live job; null once the job is not live. */
export function acceptingMode(role: Pick<RoleDetail, "status" | "acceptingApplications" | "closingDate">): AcceptingMode | null {
  if (!["open", "paused"].includes(role.status)) return null;
  if (role.acceptingApplications) return "stop";
  return role.closingDate?.applicationsClosedByDate ? "extend" : "reopen";
}

/**
 * The confirmation behind the accepting-applications switch (item 16), opened from the job's More menu or the banner.
 * Distinct from pausing the job: the job page stays up and says applications are closed; nobody is turned away. When
 * the closing date stopped them (plan D7), taking them again means a later date, so it offers the date instead.
 */
export function AcceptingSheet({ role, mode, onClose }: { role: RoleDetail; mode: AcceptingMode | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const toggle = useMutation({
    mutationFn: (accepting: boolean) => api.post(`/api/v1/roles/${role.id}/applications/accepting`, { accepting, reason: reason.trim() || undefined }),
    onSuccess: async (_data, accepting) => {
      toast(accepting ? "Taking applications again." : "Not taking new applications. Everyone who already applied is untouched.");
      onClose();
      setReason("");
      await qc.invalidateQueries({ queryKey: ["role", role.id] });
      await qc.invalidateQueries({ queryKey: ["postings", role.id] });
      await qc.invalidateQueries({ queryKey: ["volume", role.id] });
    },
    onError: (e) => toast(message(e, "Could not change the switch.")),
  });
  const reopen = mode === "reopen";
  return (
    <>
      <Sheet open={mode === "extend"} onClose={onClose} title={ACCEPTING_LABEL.extend}>
        <div className="stack">
          <p style={{ color: "var(--ink-2)" }}>Choose a later last day to apply. The apply button comes back straight away. Everyone who applied is untouched.</p>
          {mode === "extend" ? <ClosingDateField roleId={role.id} closingDate={role.closingDate} canEdit roleStatus={role.status} idBase="extend" onSaved={onClose} /> : null}
        </div>
      </Sheet>
      <Sheet open={mode === "stop" || reopen} onClose={onClose} title={reopen ? "Accept applications again?" : "Stop accepting new applications?"}>
        <div className="stack">
          {reopen ? (
            <p style={{ color: "var(--ink-2)" }}>The job page shows the apply button again. Your team is told.</p>
          ) : (
            <>
              <p style={{ color: "var(--ink-2)" }}>The job page stays up and says applications are closed. Everyone who applied stays where they are; nobody is rejected.</p>
              <p className="small muted" style={{ margin: 0 }}>New applications are refused politely. Your team is told. You can reopen at any time.</p>
              <Field label="Why (optional, kept with the record)" htmlFor="accept-reason"><input id="accept-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Enough strong applicants for now" /></Field>
            </>
          )}
          <div className="row">
            <Button variant={reopen ? "primary" : "destructive"} loading={toggle.isPending} onClick={() => toggle.mutate(reopen)}>{reopen ? "Yes, accept applications" : "Yes, stop accepting"}</Button>
            <Button variant="quiet" onClick={onClose}>{reopen ? "Not now" : "Keep accepting"}</Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}

/** The switch as a button with its confirmation: in the "Not taking new applications" banner. */
export function AcceptingSwitch({ role, size }: { role: RoleDetail; size?: "sm" | "md" }) {
  const [open, setOpen] = useState<AcceptingMode | null>(null);
  const mode = acceptingMode(role);
  if (!mode) return null;
  return (
    <>
      <Button size={size} variant={mode === "stop" ? "secondary" : "primary"} onClick={() => setOpen(mode)}>{ACCEPTING_LABEL[mode]}</Button>
      <AcceptingSheet role={role} mode={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** "Not taking new applications": why, and (for those who manage the job) the way to take them again, right here. */
export function ClosedBanner({ role, canManage, onOpenPosting }: { role: RoleDetail; canManage: boolean; onOpenPosting?: () => void }) {
  if (role.acceptingApplications || role.status === "closed") return null;
  const byDate = !!role.closingDate?.applicationsClosedByDate;
  return (
    <Alert tone="caution">
      <div className="stack" style={{ gap: 8 }}>
        <span>
          <strong>{byDate ? "Not taking new applications: the closing date has passed." : "Not taking new applications"}</strong>
          {byDate ? "" : ` since ${when(role.applicationsClosedAt)}${role.applicationsClosedReason ? ` (${role.applicationsClosedReason})` : ""}.`} The job page says so. Everyone who applied is untouched.
          {canManage ? "" : ` ${byDate ? "An owner or an admin can extend the date." : "An owner or an admin can reopen it."}`}
        </span>
        {canManage || onOpenPosting ? (
          <div className="row">
            {canManage ? <AcceptingSwitch role={role} size="sm" /> : null}
            {byDate && onOpenPosting ? <Button size="sm" variant="quiet" onClick={onOpenPosting}>Go to the Share tab</Button> : null}
          </div>
        ) : null}
      </div>
    </Alert>
  );
}

/**
 * The boards still showing the job (item 15): after the role closed, or after one board's posting was closed while the
 * role stays open. When ITS posts for the company, ITS has a task to take each down (plan D3).
 */
export function StillUpAlert({ channels, roleStatus, onOpen, canManage, whoPosts = "self" }: { channels: string[]; roleStatus: string; onOpen: () => void; canManage: boolean; whoPosts?: WhoPosts }) {
  if (!channels.length) return null;
  const one = channels.length === 1;
  return (
    <Alert tone={whoPosts === "its" ? "caution" : "critical"}>
      <strong>Still up on: {boardNames(channels)}.</strong>{" "}
      {roleStatus === "closed"
        ? `The job is closed, but ${one ? "this board still shows" : "these boards still show"} it.`
        : `The posting was closed ${one ? "there" : "on these boards"}, but ${one ? "the board still shows" : "they still show"} the job.`}{" "}
      {whoPosts === "its"
        ? `ITS takes ${one ? "it" : "them"} down and ticks ${one ? "it" : "them"} off; nothing for you to do.`
        : canManage ? "Take it down from your own account, then tick it off on the Share tab." : "An owner or an admin takes it down and ticks it off on the Share tab."} <Button size="sm" onClick={onOpen}>Go to the Share tab</Button>
    </Alert>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The tab                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

export function PostingTab({ roleId, roleStatus, canManage, canShare = false, roleTitle = "", companyName = null }: { roleId: string; roleStatus: string; canManage: boolean; canShare?: boolean; roleTitle?: string; companyName?: string | null }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["postings", roleId], queryFn: () => api.get<PostingsResponse>(`/api/v1/roles/${roleId}/postings`) });
  // Home's cards link to a part of the tab (`#share`, `#closing-date`); it is on the page only once the postings are read.
  // The part takes the focus too, so a keyboard or screen-reader user starts there; the scroll is instant for anyone who
  // asked for reduced motion.
  const loaded = !!q.data;
  useEffect(() => {
    if (!loaded || typeof window === "undefined" || !window.location.hash) return;
    const el = document.getElementById(window.location.hash.slice(1));
    // a part folded away under "Show more" opens first, so the link lands on something visible
    const folded = el?.closest("details");
    if (folded) folded.open = true;
    if (el) window.setTimeout(() => { el.scrollIntoView({ block: "start", behavior: scrollBehavior() }); el.focus({ preventScroll: true }); }, 50);
  }, [loaded]);
  const volume = useQuery({ queryKey: ["volume", roleId], queryFn: () => api.get<VolumeReport>(`/api/v1/roles/${roleId}/volume`) });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["postings", roleId] });
    await qc.invalidateQueries({ queryKey: ["role", roleId] });
    await qc.invalidateQueries({ queryKey: ["brief"] });
  };
  const act = useMutation({
    mutationFn: (input: { channel: string; action: string; body?: unknown; done: string }) => api.post(`/api/v1/roles/${roleId}/postings/${input.channel}/${input.action}`, input.body ?? {}),
    onSuccess: async (_data, input) => { toast(input.done); await refresh(); },
    onError: (e) => toast(message(e, "That did not work. Try again.")),
  });
  const run: Run = (channel, action, done, body, onSuccess) => act.mutate({ channel, action, body, done }, onSuccess ? { onSuccess } : undefined);
  // Until ITS confirms the company (founder decision B7) nothing of an approved role is public, and the tab says why.
  const check = useCompanyCheck();
  // Whether the step-by-step section starts open, decided once when the postings first arrive: a refetch after the team
  // acts never closes it under the person (and never moves their focus to the page).
  const startOpen = useRef<boolean | null>(null);

  if (q.isLoading) return <Skeleton lines={6} />;
  if (q.error || !q.data) return <ErrorState message="Could not load the postings." onRetry={() => q.refetch()} />;
  const d = q.data;
  const boards = d.postings.filter((p) => p.isBoard);
  const careers = d.postings.find((p) => p.channel === "careers_page");
  const google = d.postings.find((p) => p.channel === "google_jobs");
  const busy = act.isPending;
  const its = d.whoPosts === "its";
  const live = roleStatus === "open" || roleStatus === "paused";
  const channels = [careers, google, ...boards].filter((p): p is PostingView => !!p);
  const otherLinks = d.links.filter((l) => !l.postingId);
  // a board that waits on the team keeps its card open, so the step it needs is never hidden
  const boardsNeedYou = canManage && roleStatus !== "draft" && boards.some((p) => postingNeedsTeam(p, live));
  if (startOpen.current === null) startOpen.current = boardsNeedYou;
  const linkedIn = linkedInPostLink({ roleStatus, check, publishing: d.publishing, share: d.share, jobUrl: d.urls.job });

  return (
    <div className="stack">
      {!canManage ? <Alert tone="info">{READ_ONLY_POSTINGS}</Alert> : null}
      {roleStatus === "draft" || roleStatus === "pending_approval" ? <Alert tone="caution">Posting starts once the job is approved. Nothing is posted until then.</Alert> : null}
      {roleStatus === "paused" ? <Alert tone="caution">The job is paused: it is off your careers page and the feeds. Resume it to carry on. A board still shows it until it is paused or removed there.</Alert> : null}
      {roleStatus === "closed" ? <Alert tone={d.boardsStillUp.length && !its ? "critical" : "neutral"}>{d.boardsStillUp.length ? `The job is closed. Still up on: ${boardNames(d.boardsStillUp)}. ${its ? "ITS takes each listing down and ticks it off below." : canManage ? "Take each one down from your own account, then tick it off below." : "An owner or an admin takes each one down and ticks it off below."}` : "The job is closed and every board is confirmed down. Nothing more to do here."}</Alert> : null}
      {check === "waiting" && roleStatus !== "closed" ? <Alert tone="caution">{POSTING_WAITS_FOR_CHECK}</Alert> : null}

      {/* First: the job's public link, to share, copy or open. */}
      {canShare && roleStatus === "open" ? (
        <section id="share" className="setup-section" tabIndex={-1}>
          <Card title="Share it">
            <ShareJob roleId={roleId} roleTitle={roleTitle} companyName={companyName} />
          </Card>
        </section>
      ) : roleStatus === "open" && check !== "waiting" && d.urls.job ? (
        <Card title="Your job link">
          <JobLink url={d.urls.job} />
        </Card>
      ) : null}

      {/* Then the LinkedIn post (Wave S2): ready-made words to copy and post, under the same rule as the public link. */}
      {linkedIn ? (
        <section id="linkedin" className="setup-section" tabIndex={-1}>
          <Card title="Post on LinkedIn">
            <LinkedInPost roleId={roleId} roleTitle={roleTitle} companyName={companyName} jobUrl={linkedIn.jobUrl} linkedInUrl={linkedIn.linkUrl} canMakeLink={canShare} accepting={d.role.acceptingApplications} />
          </Card>
        </section>
      ) : roleStatus === "open" && (check === "waiting" || d.publishing?.state === "waiting_for_company_check") ? (
        // "Post on LinkedIn" from the jobs list lands here: while the company check runs, it says why there is nothing yet
        <section id="linkedin" className="setup-section" tabIndex={-1}>
          <Card title="Post on LinkedIn">
            <p className="small muted" style={{ margin: 0 }}>You can post on LinkedIn once ITS has checked your company.</p>
          </Card>
        </section>
      ) : null}

      <div className="grid-2">
        <Card title="Where it is posted">
          <p className="small muted" style={{ marginBottom: 10 }}>{its ? "ITS posts it on the job boards from your company's accounts." : "Your team posts it on the job boards from your own accounts."}</p>
          <BoardTicks key={d.boards.map((b) => `${b.channel}:${b.chosen}`).join(",")} roleId={roleId} boards={d.boards} roleStatus={roleStatus} whoPosts={d.whoPosts} canManage={canManage} />
        </Card>
        <section id="closing-date" className="setup-section" tabIndex={-1}>
          <Card title="Closing date">
            <ClosingDateField key={`${d.closingDate.closesOn}`} roleId={roleId} closingDate={d.closingDate} canEdit={canManage} roleStatus={roleStatus} idBase="posting" />
          </Card>
        </section>
      </div>

      {d.postings.length === 0 && check !== "waiting" ? <p className="muted">Nothing prepared yet. Everything is prepared the moment the job is approved.</p> : null}

      {/* Each channel's own card: its state, its link and package, its steps and buttons. */}
      <details className="more" open={startOpen.current || undefined}>
        <summary>Each board and page, step by step ({channels.length})</summary>
        <div className="stack">
          {careers || google ? (
            <div className="grid-2">
              {careers ? <NativeCard p={careers} jobUrl={d.urls.job} run={run} busy={busy} roleStatus={roleStatus} canManage={canManage} /> : null}
              {google ? <NativeCard p={google} jobUrl={d.urls.job} run={run} busy={busy} roleStatus={roleStatus} canManage={canManage} /> : null}
            </div>
          ) : null}
          <EmailInPanel emailIn={d.emailIn} run={run} busy={busy} roleStatus={roleStatus} canManage={canManage} />
          {boards.map((p) => <BoardCard key={p.id} p={p} run={run} busy={busy} roleStatus={roleStatus} canManage={canManage} live={live} />)}
        </div>
      </details>

      <details className="more">
        <summary>Your own tracked links ({otherLinks.filter((l) => !l.disabledAt).length})</summary>
        <OtherLinks roleId={roleId} links={otherLinks} roleStatus={roleStatus} onChange={refresh} canManage={canManage} />
      </details>

      <details className="more">
        <summary>Applications by source, last 14 days</summary>
        <VolumeCard report={volume.data} loading={volume.isLoading} failed={!!volume.error} onRetry={() => volume.refetch()} />
      </details>
    </div>
  );
}

/** The job's public address with Copy and Open, for someone who cannot make share links. */
function JobLink({ url }: { url: string }) {
  return (
    <div className="share-link">
      <Icon name="link" size={16} />
      <code title={url}>{url}</code>
      <Button size="sm" icon="copy" onClick={() => copy(url, "the job's address")}>Copy</Button>
      <a className="btn secondary sm" href={url} target="_blank" rel="noopener noreferrer"><Icon name="external" />Open<span className="sr-only"> the job page (opens in a new tab)</span></a>
    </div>
  );
}

/**
 * Whether a board's card holds a step for the team: an address to record when the team posts it, a check that failed,
 * a listing to take down or bring up to date, or a task ITS could not do.
 */
export function postingNeedsTeam(p: Pick<PostingView, "status" | "postedBy" | "isBoard" | "verificationAttempts" | "closureRequired" | "closureConfirmedAt" | "showsOldVersion"> & { task?: PostingView["task"] }, live: boolean): boolean {
  const its = p.postedBy === "its";
  if (its && p.task?.status === "resolved" && p.task.notDone) return true;
  if (p.showsOldVersion && live && !its) return true;
  if (p.status === "failed" && !its) return true;
  if (p.status === "closed" && p.closureRequired && !p.closureConfirmedAt && !its) return true;
  if (p.status === "ready_to_post" && p.isBoard && !its) return true;
  if (p.status === "posted_manually" && p.verificationAttempts > 0 && !its) return true;
  return false;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Cards                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

function Header({ p }: { p: PostingView }) {
  return (
    <div className="card-title">
      <h2 style={{ fontSize: 15 }}>{p.name}</h2>
      <Pill size="sm" tone={STATE_TONE[p.status] ?? "neutral"}>{p.stateLabel}</Pill>
    </div>
  );
}

/**
 * One sentence per state: what it means and what happens next. No state is a dead end. When ITS posts for the company
 * (plan D3) the sentence says ITS has it, never "from your own account".
 */
export function boardStateLine(p: Pick<PostingView, "status" | "name" | "postedBy" | "verificationAttempts" | "verificationError" | "verifiedAt" | "verifiedBy" | "verificationNote" | "pausedAt" | "error" | "closedAt" | "closureRequired" | "closureConfirmedAt"> & { task?: PostingView["task"] }): string {
  const its = p.postedBy === "its";
  // ITS closed its task as not possible (plan D3): the work is back with the team until someone asks ITS again.
  const itsCouldNot = its && !!p.task?.notDone && p.task.status === "resolved";
  switch (p.status) {
    case "draft": return "Waiting for the role to be approved.";
    case "approved": return `The role is approved; ${p.name} is being prepared.`;
    case "ready_to_post": return itsCouldNot
      ? `Nothing is on ${p.name} yet: ITS could not post it. Ask ITS again once that is sorted out, or post it from your company's own account and record the address below.`
      : its
      ? `ITS is posting this on ${p.name} from your company's own account, with this board's own apply link. It is marked as up only once its address has been checked.`
      : `Nothing is on ${p.name} yet. Post the package from your own ${p.name} account, use this board's apply link as the way to apply, then record the public address below.`;
    case "posted_manually": return p.verificationAttempts === 0 ? "Address recorded. Checking the link now; this usually takes a minute." : `The last check did not pass: ${plainCheckFailure(p.verificationError)}. It is checked again shortly (${p.verificationAttempts} of 3).${its ? "" : " If you can see the posting yourself, confirm it below."}`;
    case "live_verified": return `Live. Verified ${when(p.verifiedAt)} by ${who(p.verifiedBy)}.${p.verificationNote ? ` Note: ${p.verificationNote}` : ""}`;
    case "paused": return `Paused ${when(p.pausedAt)}. Resume brings it back to where it was. The posting may still be visible on ${p.name}; ${its ? "ask ITS to pause or remove it there" : "pause or remove it there too"} if you want it hidden.`;
    case "failed": return `${p.verificationError ? `The address could not be verified ${checksIn(p.error) || "by the automatic check"}: ${plainCheckFailure(p.verificationError)}.` : p.error ?? "The check failed."} ${its ? "ITS checks the listing and records the address again." : "Check the address and record it again, or confirm it yourself if you can see the posting."}`;
    case "closed": return `Closed ${when(p.closedAt)}. ${p.closureRequired ? (p.closureConfirmedAt ? `Removed from ${p.name}, confirmed ${when(p.closureConfirmedAt)}.` : itsCouldNot ? `Still up on ${p.name}: ITS could not take it down. Ask ITS again, or take it down from your company's own account and tick the box.` : its ? `Still up on ${p.name}: ITS takes it down from your company's account and ticks it off here.` : `Still up on ${p.name}: take it down from your own account, then tick the box.`) : "It was never posted on this board, so there is nothing to take down."}`;
    default: return "";
  }
}

/**
 * The ITS posting task on a board (plan D3), in a few words: what it is and where it stands, with the recruiter's name
 * once one has it. A task ITS closed as not possible is never called done.
 */
export function taskChip(task: PostingView["task"]): { label: string; tone: Tone } | null {
  if (!task) return null;
  if (task.status === "resolved" && task.notDone) return { label: `${task.label}: ITS could not do it`, tone: "caution" };
  if (task.status === "resolved") return { label: `${task.label}: done${task.recruiterName ? ` by ${task.recruiterName}` : ""}`, tone: "good" };
  if (task.status === "cancelled") return null;
  if (task.status === "claimed" || task.status === "in_progress") return { label: `${task.label}: ${task.recruiterName ? `${task.recruiterName} at ITS has it` : "an ITS recruiter has it"}`, tone: "accent" };
  return { label: `${task.label}: waiting for ITS`, tone: "neutral" };
}

function nativeStateLine(p: PostingView, jobUrl: string): string {
  const google = p.channel === "google_jobs";
  switch (p.status) {
    case "draft": return "Waiting for the role to be approved.";
    case "approved": return "The role is approved; the page is being prepared.";
    case "ready_to_post": return google ? "Prepared. It is submitted through the job page's structured data when the role is published." : "Prepared. The page is checked the moment it is published.";
    case "posted_manually": return p.verificationAttempts === 0 ? `The job page is at ${jobUrl}. Checking it now.` : `The last check of the job page did not pass: ${plainCheckFailure(p.verificationError)}. It is checked again shortly (${p.verificationAttempts} of 3).`;
    case "submitted_integration": return "Sent to Google through the job page's own details. Google lists jobs on its own schedule, so no day is promised. Once someone sees the job in a Google search, mark it found below with a note.";
    case "live_verified": return `Live. Verified ${when(p.verifiedAt)} by ${who(p.verifiedBy)}.${p.verificationNote ? ` Note: ${p.verificationNote}` : ""}`;
    case "paused": return `Paused ${when(p.pausedAt)}. Resume brings it back to where it was.`;
    case "failed": return `${p.verificationError && !google ? `The job page could not be verified ${checksIn(p.error) || "by the automatic check"}: ${plainCheckFailure(p.verificationError)}.` : p.error ?? "It failed."} ${google ? "Retry sends it again; or mark it found if you can see the job in a Google search." : "Check again fetches the page once more; or confirm it yourself if the page opens for you."}`;
    case "closed": return `Closed ${when(p.closedAt)}. ${google ? "Google drops the listing on its own once the page says the job is closed." : "The page says the job is closed."}`;
    default: return "";
  }
}

function VerifyNote({ p, run, busy, onDone }: { p: PostingView; run: Run; busy: boolean; onDone: () => void }) {
  const [note, setNote] = useState("");
  const id = `note-${p.id}`;
  return (
    <div className="stack" style={{ gap: 8, marginTop: 8, maxWidth: 520 }}>
      <Field label="What did you check, and when?" htmlFor={id} hint="Required. Recorded with your name; this is what makes the posting count as live."><textarea id={id} className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder={p.channel === "google_jobs" ? "e.g. Found it in a Google search on 24 September" : `e.g. Opened the listing on ${p.name} on 24 September; title and apply link are right`} /></Field>
      <div className="row">
        <Button variant="primary" disabled={note.trim().length < 3 || busy} onClick={() => run(p.channel, "verify", p.channel === "google_jobs" ? "Marked as found in Google, with your note." : `${p.name} is now live and verified, with your note.`, { note: note.trim() }, onDone)}>Confirm: I checked it</Button>
        <Button variant="quiet" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

function CloseConfirm({ p, run, busy, onDone }: { p: PostingView; run: Run; busy: boolean; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const id = `close-${p.id}`;
  const up = ["posted_manually", "live_verified", "paused"].includes(p.status) && p.isBoard;
  return (
    <div className="stack" style={{ gap: 8, marginTop: 8, maxWidth: 520 }}>
      <p className="small" style={{ color: "var(--ink-2)" }}>{up ? (p.postedBy === "its" ? `Closing here does not remove it from ${p.name} by itself: ITS gets a task to take it down from your company's account and ticks it off here.` : `Closing here does not remove it from ${p.name}: take it down from your own account too, then tick "Removed from this board".`) : "Closing here is final for this channel; a re-opened role prepares it again."}</p>
      <Field label="Reason (optional)" htmlFor={id}><input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="row">
        <Button variant="destructive" disabled={busy} onClick={() => run(p.channel, "close", `${p.name} closed.`, { reason: reason.trim() || undefined }, onDone)}>Yes, close it</Button>
        <Button variant="quiet" onClick={onDone}>Keep it</Button>
      </div>
    </div>
  );
}

/**
 * The buttons a state allows. A closed posting only offers the removal checkbox, drawn by the card. The careers page
 * and the Google listing are the job page itself, so they have no Pause or Close of their own (Wave 0 item 0.8): they
 * follow the role and the accepting switch. Resume stays for one an earlier version left paused.
 */
function Actions({ p, run, busy, roleStatus, onVerify, onClose }: { p: PostingView; run: Run; busy: boolean; roleStatus: string; onVerify: () => void; onClose: () => void }) {
  if (roleStatus === "closed" || p.status === "closed" || p.status === "draft" || p.status === "approved") return null;
  const google = p.channel === "google_jobs";
  const native = p.channel === "careers_page" || google;
  const checkable = p.isBoard || p.channel === "careers_page";
  return (
    <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
      {p.status === "posted_manually" && p.verificationAttempts > 0 && checkable ? <Button size="sm" disabled={busy} onClick={() => run(p.channel, "retry", "Checking the link again.")}>Check again</Button> : null}
      {p.status === "failed" && p.externalUrl && checkable ? <Button size="sm" disabled={busy} onClick={() => run(p.channel, "retry", "Checking the link again.")}>Check again</Button> : null}
      {p.status === "failed" && !p.externalUrl && p.isBoard ? <Button size="sm" disabled={busy} onClick={() => run(p.channel, "retry", "Back to the steps.")}>Start over</Button> : null}
      {p.status === "failed" && !checkable ? <Button size="sm" disabled={busy} onClick={() => run(p.channel, "retry", "Retrying.")}>Retry</Button> : null}
      {["posted_manually", "submitted_integration"].includes(p.status) || (p.status === "failed" && (p.externalUrl || google)) ? <Button size="sm" disabled={busy} onClick={onVerify}>{google ? "Mark it found" : "I checked it myself"}</Button> : null}
      {!native && ["ready_to_post", "posted_manually", "submitted_integration", "live_verified"].includes(p.status) ? <Button size="sm" disabled={busy} onClick={() => run(p.channel, "pause", `${p.name} paused.`)}>Pause</Button> : null}
      {p.status === "paused" ? <Button size="sm" variant="primary" disabled={busy} onClick={() => run(p.channel, "resume", `${p.name} resumed.`)}>Resume</Button> : null}
      {!native ? <Button size="sm" variant="quiet" disabled={busy} onClick={onClose}>Close</Button> : null}
    </div>
  );
}

/** The removal checklist item. Read-only (shown, never tickable) for anyone without role.manage. */
function RemovedCheckbox({ p, run, busy, canManage }: { p: PostingView; run: Run; busy: boolean; canManage: boolean }) {
  if (p.status !== "closed" || !p.closureRequired) return null;
  const id = `removed-${p.id}`;
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <input id={id} type="checkbox" checked={!!p.closureConfirmedAt} disabled={!canManage || !!p.closureConfirmedAt || busy} onChange={() => run(p.channel, "closure-confirm", `Recorded: removed from ${p.name}.`)} />
      <label htmlFor={id}>Removed from this board{p.closureConfirmedAt ? ` (confirmed ${when(p.closureConfirmedAt)})` : ""}</label>
    </div>
  );
}

function BoardCard({ p, run, busy, roleStatus, canManage, live }: { p: PostingView; run: Run; busy: boolean; roleStatus: string; canManage: boolean; live: boolean }) {
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState<null | "verify" | "close" | "updated">(null);
  const [showSteps, setShowSteps] = useState(false);
  const [updateNote, setUpdateNote] = useState("");
  const its = p.postedBy === "its";
  // When ITS posts, the steps and the address field are ITS's work: folded away, still there if the team posted it themselves.
  const stepsOpen = (p.status === "ready_to_post" && !its) || showSteps;
  const canRecord = canManage && roleStatus !== "closed" && ["ready_to_post", "posted_manually", "failed"].includes(p.status);
  const urlId = `url-${p.id}`;
  const chip = taskChip(p.task);
  // ITS closed its task as not possible (plan D3): its words, and a way to ask again once the reason is sorted out.
  const itsCouldNot = its && p.task?.status === "resolved" && p.task.notDone ? p.task : null;
  // A board a person closed while it stays ticked on an open role comes back only by being prepared again (plan D6).
  const mayPrepareAgain = canManage && roleStatus === "open" && p.status === "closed" && p.chosen && !(p.closureRequired && !p.closureConfirmedAt);
  const recordForm = canRecord ? (
    <div className="row" style={{ alignItems: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 320px" }}>
        <Field label={p.externalUrl ? "Record a different public address" : "Record the public address of the posting"} htmlFor={urlId} hint="The full https:// link to the job on the board. It is checked before the posting is called live.">
          <input id={urlId} className="input" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={`https://www.${p.channel === "linkedin_basic" ? "linkedin.com/jobs/view/..." : p.channel === "indeed" ? "indeed.com/viewjob?jk=..." : "ziprecruiter.com/jobs/..."}`} />
        </Field>
      </div>
      <Button variant="primary" disabled={!url.trim() || busy} onClick={() => run(p.channel, "url", "Address recorded. Checking the link now.", { url: url.trim() }, () => setUrl(""))}>Record the public URL</Button>
    </div>
  ) : null;
  return (
    <Card>
      <Header p={p} />
      {p.isBoard && p.status !== "closed" ? <p className="small muted" style={{ margin: "0 0 4px" }}>{its ? "Posted by ITS from your company's own account" : "Posted by your team from your own account"}</p> : null}
      <p className="small" style={{ color: "var(--ink-2)" }}>{boardStateLine(p)}</p>
      {chip ? <p style={{ margin: "6px 0 0" }}><Chip tone={chip.tone === "good" ? "good" : chip.tone === "accent" ? "accent" : chip.tone === "caution" ? "caution" : "neutral"}>{chip.label}</Chip></p> : null}
      {itsCouldNot ? (
        <div className="alert caution" style={{ marginTop: 8 }}>
          <strong>ITS could not {itsCouldNot.label.charAt(0).toLowerCase()}{itsCouldNot.label.slice(1)}.</strong>{itsCouldNot.note ? ` ${itsCouldNot.recruiterName ?? "The recruiter"} wrote: "${itsCouldNot.note}"` : ""}
          {canManage ? <div className="row" style={{ marginTop: 6 }}><Button size="sm" variant="primary" disabled={busy} onClick={() => run(p.channel, "ask-its", `Asked ITS again: ${itsCouldNot.label.charAt(0).toLowerCase()}${itsCouldNot.label.slice(1)}.`)}>Ask ITS again</Button></div> : null}
        </div>
      ) : null}
      {p.showsOldVersion && live ? (
        <div className="alert caution" style={{ marginTop: 8 }}>
          <strong>Shows an earlier version of the job{p.boardVersion ? ` (version ${p.boardVersion})` : ""}.</strong>{" "}
          {its && !itsCouldNot ? "ITS has a task to update it from your company's account with the new posting package." : "Update the listing from your own account with the posting package below, then confirm it here."}
          {canManage && (!its || itsCouldNot) && open !== "updated" ? <div className="row" style={{ marginTop: 6 }}><Button size="sm" variant="primary" onClick={() => setOpen("updated")}>It shows the new version now</Button></div> : null}
          {canManage && open === "updated" ? (
            <div className="stack" style={{ gap: 6, marginTop: 6, maxWidth: 520 }}>
              <Field label="What did you update? (optional)" htmlFor={`updated-${p.id}`}><input id={`updated-${p.id}`} className="input" value={updateNote} onChange={(e) => setUpdateNote(e.target.value)} placeholder="e.g. Pasted the new description on 9 October" /></Field>
              <div className="row">
                <Button size="sm" variant="primary" disabled={busy} onClick={() => run(p.channel, "updated", `${p.name} is up to date. Checking the link again.`, updateNote.trim() ? { note: updateNote.trim() } : {}, () => { setOpen(null); setUpdateNote(""); })}>Confirm</Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen(null)}>Cancel</Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {p.externalUrl ? <p className="small">On {p.name}: <a href={p.externalUrl} target="_blank" rel="noreferrer">{p.externalUrl}</a></p> : null}
      {mayPrepareAgain ? <div className="row" style={{ marginTop: 8 }}><Button size="sm" variant="primary" disabled={busy} onClick={() => run(p.channel, "prepare", its ? `${p.name} is prepared again; ITS posts it.` : `${p.name} is prepared again for you to post.`)}>Prepare this board again</Button></div> : null}
      <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
        {p.link ? (
          <>
            <span className="small">Apply link for {p.name}: <code>{p.link.url}</code></span>
            <Button size="sm" onClick={() => copy(p.link!.url, "the apply link")}>Copy</Button>
            <span className="small muted">{p.link.visits} {p.link.visits === 1 ? "visit" : "visits"}</span>
          </>
        ) : <span className="small muted">No apply link yet; it is created when the role is prepared.</span>}
        {p.package ? <Button size="sm" onClick={() => copy(p.package!.text, "the posting package")}>Copy posting package</Button> : null}
      </div>
      {p.steps.length ? (
        stepsOpen ? (
          <ol style={{ paddingLeft: 18, margin: "10px 0 0" }}>{p.steps.map((s, i) => <li key={`${p.id}-step-${i}`} className="small">{s}</li>)}</ol>
        ) : <p style={{ marginTop: 8 }}><Button size="sm" variant="quiet" onClick={() => setShowSteps(true)}>Show the steps</Button></p>
      ) : null}
      {recordForm && its ? (
        <details style={{ marginTop: 10 }}>
          <summary className="small">Posted it yourself? Record the address</summary>
          {recordForm}
        </details>
      ) : recordForm}
      {canManage && open === "verify" ? <VerifyNote p={p} run={run} busy={busy} onDone={() => setOpen(null)} /> : null}
      {canManage && open === "close" ? <CloseConfirm p={p} run={run} busy={busy} onDone={() => setOpen(null)} /> : null}
      {canManage && open === null ? <Actions p={p} run={run} busy={busy} roleStatus={roleStatus} onVerify={() => setOpen("verify")} onClose={() => setOpen("close")} /> : null}
      <RemovedCheckbox p={p} run={run} busy={busy} canManage={canManage} />
      {its && !canManage && p.status === "ready_to_post" ? <p className="small muted" style={{ marginTop: 8 }}>Nothing for you to do here: ITS posts it and this card follows.</p> : null}
    </Card>
  );
}

function NativeCard({ p, jobUrl, run, busy, roleStatus, canManage }: { p: PostingView; jobUrl: string; run: Run; busy: boolean; roleStatus: string; canManage: boolean }) {
  const [open, setOpen] = useState<null | "verify">(null);
  return (
    <Card>
      <Header p={p} />
      <p className="small" style={{ color: "var(--ink-2)" }}>{nativeStateLine(p, jobUrl)}</p>
      {p.channel === "careers_page" ? <p className="small">Job page: <a href={jobUrl} target="_blank" rel="noreferrer">{jobUrl}</a> <Button size="sm" onClick={() => copy(jobUrl, "the job page address")}>Copy</Button></p> : null}
      {p.channel === "google_jobs" && p.instructions ? <p className="small muted">{p.instructions}</p> : null}
      {roleStatus !== "closed" && p.status !== "closed" ? <p className="small muted">This follows the job. To stop new applications, use "Stop accepting applications" in the More menu at the top, or pause the job. Google then drops the listing on its own.</p> : null}
      {canManage && open === "verify" ? <VerifyNote p={p} run={run} busy={busy} onDone={() => setOpen(null)} /> : null}
      {canManage && open === null ? <Actions p={p} run={run} busy={busy} roleStatus={roleStatus} onVerify={() => setOpen("verify")} onClose={() => undefined} /> : null}
    </Card>
  );
}

/** Not a board: the intake address and whether inbound mail is connected. A failed connection is checked again from here once ITS has connected the mail domain. */
function EmailInPanel({ emailIn, run, busy, roleStatus, canManage }: { emailIn: PostingsResponse["emailIn"]; run: Run; busy: boolean; roleStatus: string; canManage: boolean }) {
  const canRecheck = canManage && emailIn.status === "failed" && roleStatus === "open";
  return (
    <Card title="Applications by email" aside={<Pill size="sm" tone={emailIn.connected ? "good" : "caution"}>{emailIn.connected ? "Connected" : "Not connected"}</Pill>}>
      {emailIn.address ? (
        <p className="small">Address: <code>{emailIn.address}</code> <Button size="sm" onClick={() => copy(emailIn.address!, "the intake address")}>Copy</Button></p>
      ) : <p className="small muted">No address yet; it is created when the role is prepared.</p>}
      <p className="small muted" style={{ marginTop: 6 }}>
        {emailIn.connected
          ? "Mail sent to this address arrives here as an application, résumé attached, as if the person applied on the careers page. Give it only to a board that insists on emailing applications; the apply links are better because they record the source."
          : `Inbound mail is not connected yet, so mail sent to this address does not arrive. Use each board's apply link instead. Ask ITS to connect inbound mail if a board can only email applications${canRecheck ? ", then use \"Check again\" here" : ""}.`}
      </p>
      {!emailIn.connected && emailIn.error ? <p className="small muted" style={{ marginTop: 6 }}>Why: {emailIn.error}</p> : null}
      {canRecheck ? (
        <div className="row" style={{ marginTop: 10 }}>
          <Button size="sm" disabled={busy} onClick={() => run("email_in", "retry", "Checking the mailbox connection again.")}>Check again</Button>
        </div>
      ) : null}
    </Card>
  );
}

function OtherLinks({ roleId, links, roleStatus, onChange, canManage }: { roleId: string; links: ApplicationLink[]; roleStatus: string; onChange: () => Promise<void>; canManage: boolean }) {
  const [source, setSource] = useState<"referral" | "direct" | "other">("referral");
  const [label, setLabel] = useState("");
  const [detail, setDetail] = useState("");
  const create = useMutation({
    mutationFn: () => api.post<ApplicationLink>(`/api/v1/roles/${roleId}/links`, { source, label: label.trim(), sourceDetail: detail.trim() || undefined }),
    onSuccess: async () => { toast("Link created. Copy it and share it."); setLabel(""); setDetail(""); await onChange(); },
    onError: (e) => toast(message(e, "Could not create the link.")),
  });
  const disable = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/roles/${roleId}/links/${id}/disable`),
    onSuccess: async () => { toast("Link disabled. Anyone who opens it now sees a not-found page."); await onChange(); },
    onError: (e) => toast(message(e, "Could not disable the link.")),
  });
  return (
    <Card title="Other links">
      <p className="small muted">A link of your own for a referrer, a direct approach or anything else. Applications through it show this source and name, never the link itself.</p>
      {links.length ? (
        <Table head={["Name", "Source", "Link", numHead("Visits"), ""]} label="Other tracked links">
          {links.map((l) => (
            <tr key={l.id} style={l.disabledAt ? { opacity: 0.6 } : undefined}>
              <td>{l.label}{l.sourceDetail && l.sourceDetail !== l.label ? <span className="small muted"> · {l.sourceDetail}</span> : null}</td>
              <td>{l.sourceLabel}</td>
              <td><code className="small">{l.url}</code></td>
              <td className="num">{l.visits}</td>
              <td>
                {l.disabledAt ? <span className="small muted">Disabled {when(l.disabledAt)}</span> : (
                  <span className="row">
                    <Button size="sm" onClick={() => copy(l.url, "the link")}>Copy</Button>
                    {canManage ? <Button size="sm" variant="quiet" disabled={disable.isPending} onClick={() => disable.mutate(l.id)}>Disable</Button> : null}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      ) : <p className="small muted" style={{ marginTop: 8 }}>No other links yet.</p>}
      {canManage && roleStatus !== "closed" ? (
        <div className="row" style={{ alignItems: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
          <Field label="Kind" htmlFor="link-source"><select id="link-source" className="select" value={source} onChange={(e) => setSource(e.target.value as "referral" | "direct" | "other")}><option value="referral">Referral</option><option value="direct">Direct</option><option value="other">Other</option></select></Field>
          <Field label="Name (what you will see)" htmlFor="link-label"><input id="link-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={source === "referral" ? "Referral: Dr. Patel" : source === "direct" ? "Email to past applicants" : "Community board"} /></Field>
          <Field label="Who or what it is for (optional)" htmlFor="link-detail"><input id="link-detail" className="input" value={detail} onChange={(e) => setDetail(e.target.value)} placeholder={source === "referral" ? "Dr. Patel" : ""} /></Field>
          <Button variant="primary" disabled={!label.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create link</Button>
        </div>
      ) : null}
    </Card>
  );
}

function VolumeCard({ report, loading, failed, onRetry }: { report: VolumeReport | undefined; loading: boolean; failed: boolean; onRetry: () => void }) {
  if (loading) return <Skeleton lines={3} />;
  if (failed || !report) return <ErrorState message="Could not load the application counts." onRetry={onRetry} />;
  const yesterday = report.days[report.days.length - 2];
  const today = report.days[report.days.length - 1];
  return (
    <Card title="Applications by source (last 14 days)">
      <p className="small muted">{report.totals.total} in total; {report.yesterday.total} yesterday, {report.today.total} so far today. Days run midnight to midnight, {zoneName(report.timeZone)}.</p>
      <p className="small muted" style={{ marginTop: 4 }}>You are told when a day goes above {report.threshold}. Nobody is turned away automatically; "Stop accepting applications" in the More menu stops new ones.</p>
      {report.sources.length ? (
        <Table head={["Source", numHead("Last 14 days"), numHead("Yesterday"), numHead("Today")]} label="Applications by source">
          {report.sources.map((s) => <tr key={s.source}><td>{s.label}</td><td className="num">{s.total}</td><td className="num">{yesterday?.bySource[s.source] ?? 0}</td><td className="num">{today?.bySource[s.source] ?? 0}</td></tr>)}
        </Table>
      ) : <p className="small muted" style={{ marginTop: 8 }}>No applications in the last 14 days.</p>}
      <p className="small muted" style={{ marginTop: 8 }}>By day: {report.days.map((d) => `${d.day.slice(5)}: ${d.total}`).join(" · ")}</p>
    </Card>
  );
}
