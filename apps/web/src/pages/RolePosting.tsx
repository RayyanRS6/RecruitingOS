"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, ErrorState, Field, Sheet, Skeleton, Table } from "@ros/ui";
import { api, ApiError, type ApplicationLink, type Posting, type PostingView, type PostingsResponse, type RoleDetail, type VolumeReport } from "../api/client";
import { toast } from "../toast";
import { boardNames } from "../role-words";

/**
 * The Posting tab and the header pieces of the role page (docs/spec/20 section 2, items 9 to 17). A posting is one
 * role on one channel; ITS posts to the boards by hand from the customer's own account, records the public address,
 * and the worker checks it before anything is called live. Every state on screen says what happens next.
 *
 * Every change here needs role.manage (owner, admin, recruiter). Anyone else (a hiring manager, HR, an interviewer)
 * sees the same tab read-only, with one line saying who can change it, instead of buttons the API always refuses.
 */

/** What the read-only tab says to someone without role.manage. */
export const READ_ONLY_POSTINGS = "Only an owner or an admin can change postings: record a board's address, pause, close, or tick a board off as taken down. Ask one of them; everything here stays visible to you.";

type Tone = "neutral" | "accent" | "needs" | "good" | "caution" | "critical";
const STATE_TONE: Record<string, Tone> = { draft: "neutral", approved: "neutral", ready_to_post: "needs", posted_manually: "accent", submitted_integration: "accent", live_verified: "good", paused: "caution", failed: "critical", closed: "neutral" };

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

/** The accepting-applications switch (item 16). Distinct from pausing the role: the job page stays up and says applications are closed; nobody is turned away. */
export function AcceptingSwitch({ role }: { role: RoleDetail }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<null | "close" | "reopen">(null);
  const [reason, setReason] = useState("");
  const toggle = useMutation({
    mutationFn: (accepting: boolean) => api.post(`/api/v1/roles/${role.id}/applications/accepting`, { accepting, reason: reason.trim() || undefined }),
    onSuccess: async (_data, accepting) => {
      toast(accepting ? "Taking applications again." : "Not taking new applications. Everyone who already applied is untouched.");
      setConfirming(null);
      setReason("");
      await qc.invalidateQueries({ queryKey: ["role", role.id] });
      await qc.invalidateQueries({ queryKey: ["postings", role.id] });
      await qc.invalidateQueries({ queryKey: ["volume", role.id] });
    },
    onError: (e) => toast(message(e, "Could not change the switch.")),
  });
  if (!["open", "paused"].includes(role.status)) return null;
  return (
    <>
      {role.acceptingApplications ? <Button onClick={() => setConfirming("close")}>Stop accepting applications</Button> : <Button variant="primary" onClick={() => setConfirming("reopen")}>Accept applications again</Button>}
      <Sheet open={confirming !== null} onClose={() => setConfirming(null)} title={confirming === "reopen" ? "Accept applications again?" : "Stop accepting new applications?"}>
        <div className="stack">
          {confirming === "reopen" ? (
            <p style={{ color: "var(--ink-2)" }}>The job page shows the apply button again and new applications come in as before. Your team is told.</p>
          ) : (
            <>
              <p style={{ color: "var(--ink-2)" }}>The job page stays up and says applications are closed. New applications are refused politely at the door. Everyone who already applied stays exactly where they are; nobody is rejected. Your team is told. You can reopen at any time.</p>
              <Field label="Why (optional, kept with the record)" htmlFor="accept-reason"><input id="accept-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Enough strong applicants for now" /></Field>
            </>
          )}
          <div className="row">
            <Button variant={confirming === "reopen" ? "primary" : "destructive"} loading={toggle.isPending} onClick={() => toggle.mutate(confirming === "reopen")}>{confirming === "reopen" ? "Yes, accept applications" : "Yes, stop accepting"}</Button>
            <Button variant="quiet" onClick={() => setConfirming(null)}>{confirming === "reopen" ? "Not now" : "Keep accepting"}</Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}

export function ClosedBanner({ role, canManage }: { role: RoleDetail; canManage: boolean }) {
  if (role.acceptingApplications || role.status === "closed") return null;
  return (
    <Alert tone="caution">
      <strong>Not taking new applications</strong> since {when(role.applicationsClosedAt)}{role.applicationsClosedReason ? ` (${role.applicationsClosedReason})` : ""}. The job page stays up and says applications are closed. Everyone who already applied is untouched. {canManage ? "Use \"Accept applications again\" above to reopen." : "An owner or an admin can reopen it."}
    </Alert>
  );
}

/** The boards a person still has to take down (item 15): after the role closed, or after they closed one board's posting while the role stays open. */
export function StillUpAlert({ channels, roleStatus, onOpen, canManage }: { channels: string[]; roleStatus: string; onOpen: () => void; canManage: boolean }) {
  if (!channels.length) return null;
  const one = channels.length === 1;
  return (
    <Alert tone="critical">
      <strong>Still up on: {boardNames(channels)}.</strong>{" "}
      {roleStatus === "closed"
        ? `The role is closed, but ${one ? "this board still shows" : "these boards still show"} the job.`
        : `The posting was closed ${one ? "there" : "on these boards"}, but ${one ? "the board still shows" : "they still show"} the job.`}{" "}
      {canManage ? "Take it down from your own account, then tick it off on the Posting tab." : "An owner or an admin takes it down from the company's account and ticks it off on the Posting tab; ask one of them."} <Button size="sm" onClick={onOpen}>Go to the Posting tab</Button>
    </Alert>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The tab                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

export function PostingTab({ roleId, roleStatus, canManage }: { roleId: string; roleStatus: string; canManage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["postings", roleId], queryFn: () => api.get<PostingsResponse>(`/api/v1/roles/${roleId}/postings`) });
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

  if (q.isLoading) return <Skeleton lines={6} />;
  if (q.error || !q.data) return <ErrorState message="Could not load the postings." onRetry={() => q.refetch()} />;
  const d = q.data;
  const boards = d.postings.filter((p) => p.isBoard);
  const careers = d.postings.find((p) => p.channel === "careers_page");
  const google = d.postings.find((p) => p.channel === "google_jobs");
  const busy = act.isPending;

  return (
    <div className="stack">
      {!canManage ? <Alert tone="info">{READ_ONLY_POSTINGS}</Alert> : null}
      {roleStatus === "draft" || roleStatus === "pending_approval" ? <Alert tone="caution">Posting starts when the role is approved and open. Nothing is posted anywhere until then.</Alert> : null}
      {roleStatus === "paused" ? <Alert tone="caution">The role is paused: it is off the careers page and the feeds, and postings keep their state. Resume the role to carry on. A board posting stays visible on the board until it is paused or removed there.</Alert> : null}
      {roleStatus === "closed" ? <Alert tone={d.boardsStillUp.length ? "critical" : "neutral"}>{d.boardsStillUp.length ? `The role is closed. Still up on: ${boardNames(d.boardsStillUp)}. ${canManage ? "Take each posting down from your own account, then tick it off below." : "An owner or an admin takes each posting down and ticks it off below."}` : "The role is closed and every board is confirmed down. Nothing more to do here."}</Alert> : null}
      {d.postings.length === 0 ? <p className="muted">Nothing prepared yet. The channels are prepared the moment the role is approved.</p> : null}

      {careers || google ? (
        <div className="grid-2">
          {careers ? <NativeCard p={careers} jobUrl={d.urls.job} run={run} busy={busy} roleStatus={roleStatus} canManage={canManage} /> : null}
          {google ? <NativeCard p={google} jobUrl={d.urls.job} run={run} busy={busy} roleStatus={roleStatus} canManage={canManage} /> : null}
        </div>
      ) : null}

      <EmailInPanel emailIn={d.emailIn} run={run} busy={busy} roleStatus={roleStatus} canManage={canManage} />

      {boards.map((p) => <BoardCard key={p.id} p={p} run={run} busy={busy} roleStatus={roleStatus} canManage={canManage} />)}

      <OtherLinks roleId={roleId} links={d.links.filter((l) => !l.postingId)} roleStatus={roleStatus} onChange={refresh} canManage={canManage} />

      <VolumeCard report={volume.data} loading={volume.isLoading} failed={!!volume.error} onRetry={() => volume.refetch()} />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Cards                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

function Header({ p }: { p: PostingView }) {
  return (
    <div className="card-title">
      <h2 style={{ fontSize: 15 }}>{p.name}</h2>
      <Chip tone={STATE_TONE[p.status] ?? "neutral"}>{p.stateLabel}</Chip>
    </div>
  );
}

/** One sentence per state: what it means and what happens next. No state is a dead end. */
function boardStateLine(p: PostingView): string {
  switch (p.status) {
    case "draft": return "Waiting for the role to be approved.";
    case "approved": return `The role is approved; ${p.name} is being prepared.`;
    case "ready_to_post": return `Nothing is on ${p.name} yet. Post the package from your own ${p.name} account, use this board's apply link as the way to apply, then record the public address below.`;
    case "posted_manually": return p.verificationAttempts === 0 ? "Address recorded. Checking the link now; this usually takes a minute." : `The last check did not pass: ${plainCheckFailure(p.verificationError)}. It is checked again shortly (${p.verificationAttempts} of 3). If you can see the posting yourself, confirm it below.`;
    case "live_verified": return `Live. Verified ${when(p.verifiedAt)} by ${who(p.verifiedBy)}.${p.verificationNote ? ` Note: ${p.verificationNote}` : ""}`;
    case "paused": return `Paused ${when(p.pausedAt)}. Resume brings it back to where it was. The posting may still be visible on ${p.name}; pause or remove it there too if you want it hidden.`;
    case "failed": return `${p.verificationError ? `The address could not be verified ${checksIn(p.error) || "by the automatic check"}: ${plainCheckFailure(p.verificationError)}.` : p.error ?? "The check failed."} Check the address and record it again, or confirm it yourself if you can see the posting.`;
    case "closed": return `Closed ${when(p.closedAt)}. ${p.closureRequired ? (p.closureConfirmedAt ? `Removed from ${p.name}, confirmed ${when(p.closureConfirmedAt)}.` : `Still up on ${p.name}: take it down from your own account, then tick the box.`) : "It was never posted on this board, so there is nothing to take down."}`;
    default: return "";
  }
}

function nativeStateLine(p: PostingView, jobUrl: string): string {
  const google = p.channel === "google_jobs";
  switch (p.status) {
    case "draft": return "Waiting for the role to be approved.";
    case "approved": return "The role is approved; the page is being prepared.";
    case "ready_to_post": return google ? "Prepared. It is submitted through the job page's structured data when the role is published." : "Prepared. The page is checked the moment it is published.";
    case "posted_manually": return p.verificationAttempts === 0 ? `The job page is at ${jobUrl}. Checking it now.` : `The last check of the job page did not pass: ${plainCheckFailure(p.verificationError)}. It is checked again shortly (${p.verificationAttempts} of 3).`;
    case "submitted_integration": return "Submitted through the job page's structured data. Google lists jobs on its own schedule, usually within a few days. When the job shows up in Google Search Console or in a Google search, mark it verified below with a note.";
    case "live_verified": return `Live. Verified ${when(p.verifiedAt)} by ${who(p.verifiedBy)}.${p.verificationNote ? ` Note: ${p.verificationNote}` : ""}`;
    case "paused": return `Paused ${when(p.pausedAt)}. Resume brings it back to where it was.`;
    case "failed": return `${p.verificationError && !google ? `The job page could not be verified ${checksIn(p.error) || "by the automatic check"}: ${plainCheckFailure(p.verificationError)}.` : p.error ?? "It failed."} ${google ? "Retry re-submits it; or mark it verified if you can see the job in Google." : "Check again fetches the page once more; or confirm it yourself if the page opens for you."}`;
    case "closed": return `Closed ${when(p.closedAt)}. ${google ? "Google drops the listing on its own once the page says the job is closed." : "The page says the job is closed."}`;
    default: return "";
  }
}

function VerifyNote({ p, run, busy, onDone }: { p: PostingView; run: Run; busy: boolean; onDone: () => void }) {
  const [note, setNote] = useState("");
  const id = `note-${p.id}`;
  return (
    <div className="stack" style={{ gap: 8, marginTop: 8, maxWidth: 520 }}>
      <Field label="What did you check, and when?" htmlFor={id} hint="Required. Recorded with your name; this is what makes the posting count as live."><textarea id={id} className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder={p.channel === "google_jobs" ? "e.g. Seen in Search Console on 24 September" : `e.g. Opened the listing on ${p.name} on 24 September; title and apply link are right`} /></Field>
      <div className="row">
        <Button variant="primary" disabled={note.trim().length < 3 || busy} onClick={() => run(p.channel, "verify", `${p.name} is now live and verified, with your note.`, { note: note.trim() }, onDone)}>Confirm: I checked it</Button>
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
      <p className="small" style={{ color: "var(--ink-2)" }}>{up ? `Closing here does not remove it from ${p.name}: take it down from your own account too, then tick "Removed from this board".` : "Closing here is final for this channel; a re-opened role prepares it again."}</p>
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
      {["posted_manually", "submitted_integration"].includes(p.status) || (p.status === "failed" && (p.externalUrl || google)) ? <Button size="sm" disabled={busy} onClick={onVerify}>{google ? "Mark verified" : "I checked it myself"}</Button> : null}
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

function BoardCard({ p, run, busy, roleStatus, canManage }: { p: PostingView; run: Run; busy: boolean; roleStatus: string; canManage: boolean }) {
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState<null | "verify" | "close">(null);
  const [showSteps, setShowSteps] = useState(false);
  const stepsOpen = p.status === "ready_to_post" || showSteps;
  const canRecord = canManage && roleStatus !== "closed" && ["ready_to_post", "posted_manually", "failed"].includes(p.status);
  const urlId = `url-${p.id}`;
  return (
    <Card>
      <Header p={p} />
      <p className="small" style={{ color: "var(--ink-2)" }}>{boardStateLine(p)}</p>
      {p.externalUrl ? <p className="small">On {p.name}: <a href={p.externalUrl} target="_blank" rel="noreferrer">{p.externalUrl}</a></p> : null}
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
      {canRecord ? (
        <div className="row" style={{ alignItems: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 320px" }}>
            <Field label={p.externalUrl ? "Record a different public address" : "Record the public address of the posting"} htmlFor={urlId} hint="The full https:// link to the job on the board. It is checked before the posting is called live.">
              <input id={urlId} className="input" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={`https://www.${p.channel === "linkedin_basic" ? "linkedin.com/jobs/view/..." : p.channel === "indeed" ? "indeed.com/viewjob?jk=..." : "ziprecruiter.com/jobs/..."}`} />
            </Field>
          </div>
          <Button variant="primary" disabled={!url.trim() || busy} onClick={() => run(p.channel, "url", "Address recorded. Checking the link now.", { url: url.trim() }, () => setUrl(""))}>Record the public URL</Button>
        </div>
      ) : null}
      {canManage && open === "verify" ? <VerifyNote p={p} run={run} busy={busy} onDone={() => setOpen(null)} /> : null}
      {canManage && open === "close" ? <CloseConfirm p={p} run={run} busy={busy} onDone={() => setOpen(null)} /> : null}
      {canManage && open === null ? <Actions p={p} run={run} busy={busy} roleStatus={roleStatus} onVerify={() => setOpen("verify")} onClose={() => setOpen("close")} /> : null}
      <RemovedCheckbox p={p} run={run} busy={busy} canManage={canManage} />
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
      {roleStatus !== "closed" && p.status !== "closed" ? <p className="small muted">This follows the role. To stop new applications, use "Stop accepting applications" at the top of the page, or pause the role. The job page then says so, and Google drops the listing on its own.</p> : null}
      {canManage && open === "verify" ? <VerifyNote p={p} run={run} busy={busy} onDone={() => setOpen(null)} /> : null}
      {canManage && open === null ? <Actions p={p} run={run} busy={busy} roleStatus={roleStatus} onVerify={() => setOpen("verify")} onClose={() => undefined} /> : null}
    </Card>
  );
}

/** Not a board: the intake address and whether inbound mail is connected. A failed connection is checked again from here once ITS has connected the mail domain. */
function EmailInPanel({ emailIn, run, busy, roleStatus, canManage }: { emailIn: PostingsResponse["emailIn"]; run: Run; busy: boolean; roleStatus: string; canManage: boolean }) {
  const canRecheck = canManage && emailIn.status === "failed" && roleStatus === "open";
  return (
    <Card title="Applications by email" aside={<Chip tone={emailIn.connected ? "good" : "caution"}>{emailIn.connected ? "Connected" : "Not connected"}</Chip>}>
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
      <p className="small muted">A link for a referrer, a direct approach, or anything else. Applications through it are recorded with this source and name; the link itself never appears in the candidate's record.</p>
      {links.length ? (
        <Table head={["Name", "Source", "Link", "Visits", ""]} label="Other tracked links">
          {links.map((l) => (
            <tr key={l.id} style={l.disabledAt ? { opacity: 0.6 } : undefined}>
              <td>{l.label}{l.sourceDetail && l.sourceDetail !== l.label ? <span className="small muted"> · {l.sourceDetail}</span> : null}</td>
              <td>{l.sourceLabel}</td>
              <td><code className="small">{l.url}</code></td>
              <td>{l.visits}</td>
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
      <p className="small muted">{report.totals.total} in total; {report.yesterday.total} yesterday, {report.today.total} so far today. Days run midnight to midnight, {zoneName(report.timeZone)}. You are told when a day goes above {report.threshold}. Nobody is ever turned away automatically; the switch at the top stops new applications without touching anyone.</p>
      {report.sources.length ? (
        <Table head={["Source", "Last 14 days", "Yesterday", "Today"]} label="Applications by source">
          {report.sources.map((s) => <tr key={s.source}><td>{s.label}</td><td>{s.total}</td><td>{yesterday?.bySource[s.source] ?? 0}</td><td>{today?.bySource[s.source] ?? 0}</td></tr>)}
        </Table>
      ) : <p className="small muted" style={{ marginTop: 8 }}>No applications in the last 14 days.</p>}
      <p className="small muted" style={{ marginTop: 8 }}>By day: {report.days.map((d) => `${d.day.slice(5)}: ${d.total}`).join(" · ")}</p>
    </Card>
  );
}
