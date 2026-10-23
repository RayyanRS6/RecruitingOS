"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PACKET_VISIBILITY_LABEL } from "@ros/contracts";
import { Alert, Avatar, Button, Card, Chip, cn, EmptyState, ErrorState, Field, Icon, IconLabel, Pill, Skeleton, Timeline } from "@ros/ui";
import { api, ApiError, type DecisionMaker, type InterviewPlanView, type LegalCheck, type PacketFlag, type Requirement, type RoleDetail, type RoleEvent, type RolePacket } from "../api/client";
import { APPROVE_WAITS_FOR_CHECK, approvedToast } from "../company-check";
import { BoardTicks } from "../components/BoardTicks";
import { ClosingDateField } from "../components/ClosingDate";
import { useCompanyCheck } from "../components/use-company-check";
import { Link } from "../nav";
import { autoActionsLine, isLegalReason, legalLines, previewHref, wordsList } from "../publishing";
import { toast } from "../toast";
import { actorWords, describeRoleEvent, roleWords } from "../role-words";
import { evidencedInWords } from "./role/evidence";

/**
 * The role page's approval card, preferences card, requirement lists, Interview plan tab and Activity tab
 * (docs/spec/21 section 7: B2, B8, B9, B11). RoleDetail.tsx composes them; nothing here knows about the other tabs.
 */

export const WORK_MODEL: Record<string, string> = { onsite: "On site", hybrid: "Hybrid", remote: "Remote" };
export function workModelLabel(policy: string | undefined): string {
  return WORK_MODEL[policy ?? ""] ?? "On site";
}

const ROUND_FORMAT: Record<string, string> = { video: "video call", phone: "phone", onsite: "on site", working_session: "working session" };

/** While the role page waits on the worker it reads the role again this often, and for this long at most. */
export const CATCH_UP_EVERY_MS = 2000;
export const CATCH_UP_FOR_MS = 120_000;

/**
 * Whether the role page is waiting on the worker, which runs the approval workflow apart from the web server: just after
 * "Ask for approval" the role waits for approval before its approval request exists, so there is nothing to approve yet;
 * just after this page approved `approvedVersion`, the role opens (or, for a change to a live job, that version becomes
 * current) a moment later. Without this the owner saw no "Approve and publish" and a stale status until a reload.
 */
export function waitingOnWorker(role: Pick<RoleDetail, "status" | "packetApproval" | "currentPacket">, approvedVersion: number | null): boolean {
  if (approvedVersion !== null) return role.status === "pending_approval" || (role.currentPacket?.version ?? 0) < approvedVersion;
  return role.status === "pending_approval" && !role.packetApproval?.pending;
}

/** The role query's refetch interval: every 2 seconds while waiting on the worker (since `since`), for two minutes at most. */
export function catchUpInterval(waiting: boolean, since: number | null, now: number): number | false {
  return waiting && since !== null && now - since < CATCH_UP_FOR_MS ? CATCH_UP_EVERY_MS : false;
}

/**
 * The mark on a part of the role that is on the job page (plan D10): the kit's eye, whose words (the job builder's
 * "Candidates see this") are its accessible name and tooltip. The kit centres it in a card's title row; inside a
 * sentence it sits on the text's line.
 */
export function CandidatesSeeThis() {
  return <IconLabel icon="eye" label={PACKET_VISIBILITY_LABEL.public} className="align-text-bottom" />;
}

/** The lock's words beside the must-haves on the approval card: their reasons are not on the job page. */
export const WHY_STAYS_WITH_TEAM = "Why each one matters stays with your team.";

/**
 * Lists inside a card as rows split by hairlines (screenshot 6's rows), shared by the job page's tabs (RoleDetail.tsx).
 * The number beside an ordered one is the kit's `ordinal` class, here and on the questions card.
 */
export const DIVIDED_ROWS = "grid grid-cols-1 gap-3";
export const DIVIDED_ROW = "border-t border-line pt-3 first:border-t-0 first:pt-0";

/**
 * Must-haves and nice-to-haves with why they matter and where each is checked, in the editor's words for where
 * (role/evidence.ts: the screening conversation is the "AI interview").
 */
export function RequirementList({ items, empty }: { items: Requirement[]; empty: string }) {
  if (!items.length) return <p className="muted">{empty}</p>;
  return (
    <ul className={DIVIDED_ROWS}>
      {items.map((m) => (
        <li key={m.key} className={cn(DIVIDED_ROW, "grid gap-0.5")}>
          <strong>{m.text}</strong>
          <span className="small muted">{m.rationale}</span>
          <span className="small muted">Evidenced in: {evidencedInWords(m.evidencedBy)}</span>
        </li>
      ))}
    </ul>
  );
}

/** What the owner said matters, in their words: deal-breakers, what failure looks like, who decides. */
export function PreferencesCard({ packet, decisionMaker }: { packet: RolePacket; decisionMaker: DecisionMaker | null }) {
  const pref = packet.preferences;
  const stated = pref.decisionMakerName?.trim();
  const statedIsAPerson = !!stated && !/^(the )?(owner|hiring manager)$|^(me|myself|i)$/i.test(stated);
  return (
    <Card title="What matters to you">
      <dl className="kv">
        <dt>Final decision</dt>
        <dd>
          {decisionMaker ? <>{decisionMaker.name ?? decisionMaker.email} <Pill size="sm" tone="good">on the team</Pill></> : stated ? <>{stated}{statedIsAPerson ? <> <Pill size="sm" tone="caution">not on the team yet</Pill></> : null}</> : "Not named yet"}
          <br />
          <span className="small muted">{decisionMaker ? "Approvals of the job are reserved for them; an owner can also decide." : statedIsAPerson ? "Invite them to the team and approvals will go to them." : "Any owner, admin or hiring manager can approve."}</span>
        </dd>
        <dt>Deal-breakers</dt>
        <dd>{pref.dealBreakersInTheirWords.length ? <ul className="list-disc pl-[18px]">{pref.dealBreakersInTheirWords.map((d, i) => <li key={i}>{d}</li>)}</ul> : <span className="muted">None stated</span>}</dd>
        <dt>What failure looks like</dt>
        <dd>{pref.whatFailureLooksLike ?? <span className="muted">Not stated</span>}</dd>
        {pref.interviewStyle ? <><dt>Interview style</dt><dd>{pref.interviewStyle}</dd></> : null}
      </dl>
    </Card>
  );
}

/**
 * The decision on a role packet: approve, send back with a note, or ask again after it was sent back. What the
 * signed-in person may do comes from the API (the self-approval rule and the named decision maker live there); Edit
 * and "Request approval again" need packet.edit, so they are left out for anyone without it (`canEdit`).
 * `onShowProposed` switches the role page's tabs to the version waiting for approval, and back.
 *
 * Wave D: the card opens the job page preview of the version waiting in a new tab (D1, for those who see pay), says
 * where the job goes once approved with the board ticks (D6), lists what the law of the job's places still asks for
 * (D5; approving waits for it) and says in one line what starts on its own once the job is live (D9). After approving,
 * `onApproved` opens the screen that shows where the job is going (D2).
 */
export function PacketApprovalCard({ role, onEdit, canEdit, canManage, canSeePay, showingProposed, onShowProposed, onApproved }: { role: RoleDetail; onEdit: () => void; canEdit: boolean; canManage: boolean; canSeePay: boolean; showingProposed: boolean; onShowProposed: (show: boolean) => void; onApproved: (info: { editWhileOpen: boolean }) => void }) {
  const qc = useQueryClient();
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["role", role.id] });
    await qc.invalidateQueries({ queryKey: ["postings", role.id] });
    await qc.invalidateQueries({ queryKey: ["brief"] });
    await qc.invalidateQueries({ queryKey: ["roles"] });
    await qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const pending = role.packetApproval?.pending ?? null;
  const latest = role.packetApproval?.latest ?? null;
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState("");
  // Until ITS confirms the company (founder decision B7) an approved role waits to go public; the toast says so.
  const check = useCompanyCheck();
  const approve = useMutation({
    mutationFn: (_editWhileOpen: boolean) => api.post(`/api/v1/roles/${role.id}/approve`, { version: pending!.version }),
    onSuccess: async (_r, editWhileOpen) => { toast(approvedToast({ editWhileOpen: !!pending?.editWhileOpen, check })); onApproved({ editWhileOpen }); await refresh(); },
    // A refusal by the legal check (D5) names what is missing; the card lists it once the role is read again.
    onError: async (e) => { toast(e instanceof ApiError ? e.message : "Could not approve."); if (e instanceof ApiError && e.code === "legal_check") await refresh(); },
  });
  // Sent back from this card: the API keeps saying the role waits for approval until the worker makes it a draft again,
  // so the card says it was sent back meanwhile. Once the role is no longer waiting, this is done with: asking for
  // approval again later reaches the same state from the API, and that one is "Getting the approval ready".
  const [sentBackHere, setSentBackHere] = useState(false);
  useEffect(() => {
    if (role.status !== "pending_approval") setSentBackHere(false);
  }, [role.status]);
  const sendBack = useMutation({
    mutationFn: () => api.post(`/api/v1/approvals/${pending!.id}/decide`, { decision: "reject", ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: async () => { toast(pending?.editWhileOpen ? "Sent back. The role keeps its approved version." : "Sent back. The role is a draft again in a few seconds."); setSentBackHere(true); setSendingBack(false); setNote(""); await refresh(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send it back."),
  });
  const again = useMutation({
    mutationFn: () => api.post(`/api/v1/roles/${role.id}/request-approval`, {}),
    onSuccess: async () => { toast("Sent for approval again."); await refresh(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not ask for approval."),
  });

  const sentBack = role.status === "draft" && latest && (latest.status === "rejected" || latest.status === "expired") ? latest : null;
  if (sentBack) {
    return (
      <Card needsYou hero lift title={sentBack.status === "expired" ? "The approval ran out of time" : "Sent back"}>
        <p className="max-w-[68ch] text-ink-2">
          {sentBack.status === "expired" ? "Nobody decided within 14 days, so the role is a draft again." : `Sent back${sentBack.decidedBy ? ` by ${sentBack.decidedBy.name}` : ""}${sentBack.decidedAt ? ` on ${new Date(sentBack.decidedAt).toLocaleDateString()}` : ""}: ${sentBack.decisionNote ?? "no note was left"}.`}
        </p>
        {/* the two buttons say what comes next; someone who cannot edit is told who does */}
        {canEdit ? (
          <div className="row mt-5">
            <Button variant="primary" loading={again.isPending} onClick={() => again.mutate()}>Request approval again</Button>
            <Button onClick={onEdit}>Edit first</Button>
          </div>
        ) : <p className="small muted mt-1.5">An owner, an admin or a hiring manager edits it and asks for approval again.</p>}
      </Card>
    );
  }
  if (!pending && role.status === "pending_approval") return <CatchingUpCard latest={latest} sentBackHere={sentBackHere} />;
  if (!pending) return null;
  const packet = pending.editWhileOpen ? role.proposedPacket?.packet ?? null : role.currentPacket?.packet ?? null;
  const assumptions = packet?.provenance.assumptions ?? [];
  const expires = pending.expiresAt ? new Date(pending.expiresAt).toLocaleDateString() : null;
  const legal = legalLines(pending.legalCheck);
  const autoLine = autoActionsLine(role.autoActionsOnOpen);
  const musts = packet?.requirements?.mustHaves ?? [];
  const nices = packet?.requirements?.niceToHaves ?? [];
  // The person's own reason, or the state while a live job's change waits; a new job's buttons and "Once approved it
  // goes to…" already say what approving does, so it needs no sentence of its own.
  const lead = pending.rationale ?? (pending.editWhileOpen ? "The job keeps running on its approved version until you decide." : null);
  // Reserved for someone (a name), and the date it lapses: the decision's only facts beyond the buttons.
  const decides = [pending.decisionMaker ? `Reserved for ${pending.decisionMaker.name ?? pending.decisionMaker.email}; an owner can also decide.` : "", expires ? `Waits until ${expires}, then goes back to a draft.` : ""].filter(Boolean).join(" ");
  // The page's one next step (screenshot 1's "Your next step"): the kit's needsYou wash with its hero-sized title.
  return (
    <Card needsYou hero lift title={pending.editWhileOpen ? `Approve version ${pending.version} of ${role.title}` : "Approve this job"}>
      <div className="stack gap-3">
        {lead ? <p className="max-w-[68ch] text-ink-2">{lead}</p> : null}
        {!pending.editWhileOpen && check === "waiting" ? <Alert tone="info">{APPROVE_WAITS_FOR_CHECK}</Alert> : null}
        {canSeePay ? (
          // what the preview is, as the link's tooltip
          <div className="row">
            <a className="btn secondary sm" href={previewHref(role.id, pending.version)} target="_blank" rel="noopener noreferrer" title={`Version ${pending.version} exactly as candidates will see it. The preview is not public and search engines never see it.`}><Icon name="eye" />Preview the job page<span className="sr-only"> (opens in a new tab)</span></a>
          </div>
        ) : null}
        {!pending.editWhileOpen ? <WhereItGoes role={role} canManage={canManage} /> : null}
        {musts.length || nices.length ? (
          // The job page lists them (plan D10), so the approver sees them as candidates will; the eye says so, and the
          // lock says why each one matters stays with the team (both words are the marks' names and tooltips).
          <p className="small text-ink-2">
            <CandidatesSeeThis /> The job page lists what you are looking for: {musts.map((m) => m.text).join("; ") || "nothing yet"}.
            {nices.length ? ` Nice to have: ${nices.map((m) => m.text).join("; ")}.` : ""}{" "}
            <IconLabel icon="lock" label={WHY_STAYS_WITH_TEAM} className="align-text-bottom" />
          </p>
        ) : null}
        {legal.missing.length || legal.inOrder.length ? <LegalCheckList role={role} check={pending.legalCheck ?? null} canEdit={canEdit} canManage={canManage} onEdit={onEdit} /> : null}
        {autoLine ? <p className="small muted">{autoLine} <Link to={role.autoActionsOnOpen.changeHref}>Change these rules</Link></p> : null}
        {pending.editWhileOpen && role.proposedPacket ? (
          <div className="row gap-x-3">
            <p className="small min-w-0 flex-[1_1_20rem] text-ink-2">What changed: {role.proposedPacket.changeSummary ?? "edited"} · by {role.proposedPacket.createdBy.name ?? "a team member"} on {new Date(role.proposedPacket.createdAt).toLocaleDateString()}. Current version: {role.currentPacket?.version ?? "?"}.</p>
            <Button size="sm" onClick={() => onShowProposed(!showingProposed)}>{showingProposed ? `Back to version ${role.currentPacket?.version ?? "?"}` : `Show version ${role.proposedPacket.version}`}</Button>
          </div>
        ) : null}
        {decides ? <p className="small muted">{decides}</p> : null}
        {assumptions.length ? (
          <div className="alert caution">
            <strong>Assumptions the assistant made:</strong>
            <ul className="mt-1.5 list-disc pl-[18px]">{assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </div>
        ) : null}
        {pending.flags.length ? <ApprovalFlags roleId={role.id} version={pending.version} flags={pending.flags} canKeep={canEdit} onEdit={onEdit} onKept={refresh} /> : null}
        {!pending.viewer.mayDecide && !(legal.missing.length && isLegalReason(pending.viewer.reason)) ? <Alert tone="info">{pending.viewer.reason ?? "Someone else on your team decides this one."}</Alert> : null}
      </div>
      {sendingBack ? (
        <div className="stack mt-5 max-w-[520px] gap-2">
          <Field label="What should change? (the note goes back with the job)" htmlFor="sendback-note"><input id="sendback-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Raise the ceiling before we post this" /></Field>
          <div className="row">
            <Button variant="destructive" loading={sendBack.isPending} onClick={() => sendBack.mutate()}>Send back</Button>
            <Button variant="quiet" onClick={() => setSendingBack(false)}>Keep reviewing</Button>
          </div>
        </div>
      ) : (
        <div className="row mt-5">
          {pending.viewer.mayDecide ? <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate(!!pending.editWhileOpen)}>{pending.editWhileOpen ? "Approve this version" : "Approve and publish"}</Button> : null}
          {pending.viewer.maySendBack ? <Button onClick={() => setSendingBack(true)}>Send back with a note</Button> : null}
          {canEdit ? <Button onClick={onEdit}>{pending.viewer.mayDecide ? "Edit first" : "Edit"}</Button> : null}
        </div>
      )}
    </Card>
  );
}

/**
 * The approval card while the worker catches up (the role page reads the role again meanwhile), so the page says what is
 * happening rather than show nothing: just after "Ask for approval", just after approving, and just after this page sent
 * the role back (`sentBackHere`), when the API still says the role waits for approval until the worker makes it a draft.
 */
export function CatchingUpCard({ latest, sentBackHere }: { latest: RoleDetail["packetApproval"]["latest"]; sentBackHere: boolean }) {
  const [title, words] = sentBackHere
    ? ["Sent back", "The role goes back to a draft in a few seconds. This page updates on its own; if it does not, reload it."]
    : latest?.status === "approved"
      ? ["Approved: the job is opening", "The job opens in a few seconds. This page updates on its own; if it does not, reload it."]
      : ["Getting the approval ready", "The approval shows here in a few seconds. This page updates on its own; if it does not, reload it."];
  return (
    <Card needsYou hero title={title}>
      <p className="small row flex-nowrap items-start gap-2.5 text-ink-2 [&>.spinner]:mt-0.5" role="status">
        <span className="spinner" aria-hidden="true" />
        {words}
      </p>
    </Card>
  );
}

/**
 * Where the job goes once approved (plan D6): the careers page, Google and the ticked boards, and who posts on the
 * boards. Those who manage postings change the ticks here, before approving; they can change them after too.
 */
function WhereItGoes({ role, canManage }: { role: RoleDetail; canManage: boolean }) {
  const [changing, setChanging] = useState(false);
  const boards = role.boards.filter((b) => b.chosen).map((b) => b.name);
  const places = wordsList(["your careers page", "Google", ...boards]);
  return (
    <div className="stack gap-1.5">
      <p className="small text-ink-2">
        Once approved it goes to {places}. {boards.length ? (role.whoPosts === "its" ? "ITS posts it on the job boards from your company's own accounts." : "You post it on the job boards from your own accounts.") : ""}
        {canManage && !changing ? <> <button type="button" className="link-btn" onClick={() => setChanging(true)}>Change the boards</button></> : null}
      </p>
      {changing ? <BoardTicks roleId={role.id} boards={role.boards} roleStatus={role.status} whoPosts={role.whoPosts} canManage={canManage} onDone={() => setChanging(false)} /> : null}
    </div>
  );
}

/**
 * What the law of the job's places asks of the ad (plan D5): what is still missing, each with how to put it right
 * (approving waits for these), then what is in order. Places our lawyer has not confirmed yet are named as a note and
 * never hold approval. A Colorado role's closing date can be set right here.
 */
function LegalCheckList({ role, check, canEdit, canManage, onEdit }: { role: RoleDetail; check: LegalCheck | null; canEdit: boolean; canManage: boolean; onEdit: () => void }) {
  const { missing, inOrder } = legalLines(check);
  return (
    <section aria-label="What the law asks of this job ad" className="stack gap-2">
      {missing.length ? (
        <div className="alert caution">
          <strong>Before this job can go live</strong>
          <ul className="mt-1.5 grid list-disc gap-2 pl-[18px]">
            {missing.map((i) => (
              <li key={i.key}>
                <strong>{i.label}.</strong> {i.detail}{i.fix ? ` ${i.fix}` : ""}
                {i.key === "pay_range" && canEdit ? <div className="row mt-2"><Button size="sm" onClick={onEdit}>Edit the pay</Button></div> : null}
                {i.key === "benefits" ? <div className="row mt-2"><Link to="/setup#setup-company" className="btn secondary sm">Describe the benefits in Settings</Link>{canEdit ? <Button size="sm" variant="ghost" onClick={onEdit}>Or only for this job</Button> : null}</div> : null}
                {i.key === "closing_date" ? <div className="mt-2"><ClosingDateField roleId={role.id} closingDate={role.closingDate} canEdit={canManage} roleStatus={role.status} idBase="legal" /></div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {inOrder.length ? (
        // What is already in order stays folded away, so a busy owner reads only what needs them (side-by-side, step 4).
        <details className="more small">
          <summary>What the law asks of this job ad is in order ({inOrder.length})</summary>
          <ul className="grid gap-2" aria-label="Already in order">
            {inOrder.map((i) => (
              <li key={i.key} className="flex items-start gap-2 text-ink-2">
                <span className="mt-px flex-none text-good"><Icon name="check-circle" size={16} label="In order" /></span>
                <span><strong>{i.label}:</strong> {i.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/**
 * The wording the fairness check flagged on the version waiting for approval (plan C1), on the approval card itself:
 * each phrase, where it is, why, and the lawful way to say it. Until each open one is changed (Edit) or kept by a person
 * with a reason, the role cannot be approved; a kept one shows who kept it and why, for the approver to weigh.
 */
function ApprovalFlags({ roleId, version, flags, canKeep, onEdit, onKept }: { roleId: string; version: number; flags: PacketFlag[]; canKeep: boolean; onEdit: () => void; onKept: () => Promise<void> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const keep = useMutation({
    mutationFn: (input: { flagId: string; reason: string }) => api.post(`/api/v1/roles/${roleId}/packets/${version}/flags/keep`, input),
    onSuccess: async () => { toast("Kept, with your reason.", "Whoever approves the role sees why."); setOpen(null); setReason(""); await onKept(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not keep it."),
  });
  const waiting = flags.filter((f) => !f.kept);
  return (
    <section aria-label="Wording to check before approval" className="stack gap-3">
      <h3 className="text-[14px]">{waiting.length ? "Check this wording before approving" : "Wording someone chose to keep"}</h3>
      {flags.map((f) => {
        const id = `keep-${version}-${f.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        return (
          // each phrase in a quiet box of its own, with a warm rule on its left: something to look at, not an alarm
          <div key={f.id} className="stack gap-2 rounded-xl border border-line border-l-2 border-l-caution-dot bg-surface p-3.5">
            <p><strong>"{f.text}"</strong> <span className="small muted">({flagPlace(f.path)})</span> {f.reason}</p>
            {f.alternative ? <p className="small text-ink-2">Instead: {f.alternative}</p> : null}
            {f.kept ? (
              <p className="small"><Chip tone="caution">Kept</Chip> {f.kept.by.name ?? "A team member"} kept it on {new Date(f.kept.at).toLocaleDateString()}: "{f.kept.reason}"</p>
            ) : open === f.id ? (
              <div className="stack gap-1.5">
                <Field label="Why keep it? (whoever approves the role sees this)" htmlFor={id}><input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Required by our state licence board" /></Field>
                <div className="row">
                  <Button size="sm" variant="primary" disabled={reason.trim().length < 5} loading={keep.isPending} onClick={() => keep.mutate({ flagId: f.id, reason: reason.trim() })}>Keep it, with this reason</Button>
                  <Button size="sm" variant="quiet" onClick={() => setOpen(null)}>Cancel</Button>
                </div>
              </div>
            ) : canKeep ? (
              <div className="row">
                <Button size="sm" variant="primary" onClick={onEdit}>Change the wording</Button>
                <Button size="sm" onClick={() => { setOpen(f.id); setReason(""); }}>Keep it…</Button>
              </div>
            ) : <p className="small muted">Someone who can edit the role changes the wording, or keeps it and says why.</p>}
          </div>
        );
      })}
    </section>
  );
}

/** Where in the role a flagged phrase is, in plain words. */
function flagPlace(path: string): string {
  const p = path.replace(/\[[^\]]*\]/g, "");
  if (p.startsWith("identity")) return "the job title";
  if (p.startsWith("description.publicJobDescription")) return "the job description";
  if (p.startsWith("description")) return "the team's notes";
  if (p.startsWith("requirements.mustHaves")) return "a must-have";
  if (p.startsWith("requirements.niceToHaves")) return "a nice-to-have";
  if (p.startsWith("requirements.eligibility")) return "an application question";
  if (p.startsWith("screening")) return "a screening question";
  if (p.startsWith("competencies")) return "what interviewers look for";
  if (p.startsWith("evaluation")) return "how applications are judged";
  if (p.startsWith("interviews")) return "an interview question";
  if (p.startsWith("preferences.dealBreakers")) return "the deal-breakers";
  if (p.startsWith("communication")) return "the company description";
  return "the role";
}

/** The rounds with who interviews and whether times can be offered to them, and, for anyone with packet.edit (`canEdit`), a way to assign people per round. */
export function InterviewPlanTab({ roleId, canEdit }: { roleId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ["interview-plan", roleId], queryFn: () => api.get<InterviewPlanView>(`/api/v1/roles/${roleId}/interview-plan`) });
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: (input: { key: string; ids: string[] }) => api.patch<InterviewPlanView>(`/api/v1/roles/${roleId}/interview-plan`, { rounds: [{ key: input.key, interviewerUserIds: input.ids }] }),
    onSuccess: async (r) => {
      toast(r.outcome === "approved_current" ? "Interviewers assigned." : r.outcome === "proposed_pending_approval" ? "Saved as a new version. It takes effect once an approver says yes." : "Saved with the draft.");
      setEditingKey(null);
      await qc.invalidateQueries({ queryKey: ["interview-plan", roleId] });
      await qc.invalidateQueries({ queryKey: ["role", roleId] });
      await qc.invalidateQueries({ queryKey: ["brief"] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save the interviewers."),
  });
  if (plan.isLoading) return <Skeleton lines={4} />;
  if (plan.error || !plan.data) return <ErrorState message="Could not load the interview plan." onRetry={() => plan.refetch()} />;
  const d = plan.data;
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...new Set([...p, id])] : p.filter((x) => x !== id)));
  return (
    <Card title="Interview rounds" aside={<Chip>Version {d.version}</Chip>}>
      {/* each person's pill says whether times can be offered to them; someone who cannot assign is told who does, and
          an editor reads what saving does beside Save */}
      {canEdit ? null : <p className="small muted mb-4">An owner, an admin or a hiring manager assigns the interviewers.</p>}
      {/* The rounds in order, one row each (screenshot 6's team rows): the number, the round and its people, then Change.
          Nothing is clipped (the rows have no fill), and a long interviewer pill wraps on a phone rather than run out. */}
      <ol className="rounded-xl border border-line">
        {d.rounds.map((r, n) => (
          <li key={r.key} className="flex items-start gap-3 border-t border-line px-4 py-4 first:border-t-0 motion-safe:animate-enter" style={{ animationDelay: `${Math.min(n, 7) * 30}ms` }}>
            <span className="ordinal mt-0.5">{n + 1}</span>
            <div className="min-w-0 flex-1">
              <p><strong>{r.title}</strong> <span className="text-ink-2">· {r.durationMinutes} min · {ROUND_FORMAT[r.format] ?? r.format}</span></p>
              <p className="small muted">{r.purpose}</p>
              <div className="row mt-2.5">
                {r.interviewers.length
                  ? r.interviewers.map((i) => <Pill key={i.userId} size="sm" tone={i.schedulable ? "good" : "caution"} className="wrap">{i.name} · {i.schedulable ? "can be scheduled" : "no calendar or hours yet"}</Pill>)
                  : <span className="small muted">Nobody assigned yet{r.interviewerRoles.length ? ` (planned: ${roleWords(r.interviewerRoles)})` : ""}.</span>}
                {canEdit && editingKey !== r.key ? <span className="sm:ml-auto"><Button size="sm" onClick={() => { setEditingKey(r.key); setPicked(r.interviewers.map((i) => i.userId)); }}>{r.interviewers.length ? "Change" : "Assign interviewers"}</Button></span> : null}
              </div>
              {canEdit && editingKey === r.key ? (
                <div className="stack mt-3 gap-3">
                  {d.team.length ? (
                    // the team as rows to tick: the person, their role and whether times can be offered to them
                    <div className="overflow-hidden rounded-xl border border-line bg-surface">
                      {d.team.map((m) => (
                        <label key={m.userId} className="flex min-h-14 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line px-3.5 py-2.5 first:border-t-0 hover:bg-surface-2/60 has-[:checked]:bg-tint">
                          <input type="checkbox" checked={picked.includes(m.userId)} onChange={(e) => toggle(m.userId, e.target.checked)} />
                          <Avatar name={m.name} size="sm" />
                          <span className="min-w-0 flex-1">{m.name} <span className="small muted">({m.role.replace(/_/g, " ")})</span></span>
                          <Pill size="sm" tone={m.schedulable ? "good" : "caution"} className="wrap">{m.schedulable ? "availability known" : "no calendar or hours yet"}</Pill>
                        </label>
                      ))}
                    </div>
                  ) : <p className="small muted">Nobody is on the team yet. Invite people from Settings.</p>}
                  {/* the consequence of saving, where the action is (on a live job the new version waits for approval) */}
                  <p className="small muted">Assigning interviewers saves a new version of the job.</p>
                  <div className="row">
                    <Button variant="primary" size="sm" loading={save.isPending} onClick={() => save.mutate({ key: r.key, ids: picked })}>Save interviewers</Button>
                    <Button size="sm" variant="quiet" onClick={() => setEditingKey(null)}>Cancel</Button>
                  </div>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

// What happened on a role, in plain words (describeRoleEvent), lives in role-words.ts with the channel and role words.

/** Everything that happened on the role, newest first, in plain words. */
export function ActivityTab({ roleId }: { roleId: string }) {
  const q = useQuery({ queryKey: ["role-timeline", roleId], queryFn: () => api.get<RoleEvent[]>(`/api/v1/roles/${roleId}/timeline`) });
  if (q.isLoading) return <Skeleton lines={5} />;
  if (q.error || !q.data) return <ErrorState message={q.error instanceof ApiError && q.error.status === 403 ? "Your role cannot see this job's activity." : "Could not load the activity."} onRetry={() => q.refetch()} />;
  if (!q.data.length) return <EmptyState title="Nothing yet" />;
  return (
    <Card title="Activity" aside={<Chip>{q.data.length} {q.data.length === 1 ? "entry" : "entries"}</Chip>}>
      <Timeline items={q.data.map((e) => ({ when: e.occurredAt, what: describeRoleEvent(e), who: actorWords(e.actor) }))} />
    </Card>
  );
}
