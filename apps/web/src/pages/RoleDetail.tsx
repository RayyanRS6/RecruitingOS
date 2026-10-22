"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "../nav";
import { Alert, Button, Card, Chip, cn, EmptyState, ErrorState, Skeleton } from "@ros/ui";
import { formatPayRange } from "@ros/contracts";
import { api, ApiError, type Me, type RoleDetail as RoleDetailT, type RolePacket } from "../api/client";
import { ROLE_WAITS_FOR_CHECK } from "../company-check";
import { AskRecruiter } from "../components/AskRecruiter";
import { useCompanyCheck } from "../components/use-company-check";
import { canApproveRole, canDecline, canEditPacket, canEditPacketJson, canManageRole, canRecordOutcome, canSeeActivity, canSeePay, canSeeTalent, canShareJob, canTryWeights } from "../roles";
import { outdatedBoardsLine } from "../publishing";
import { payShownLabel } from "../role-words";
import { REASON_WORD } from "./new-role/rules";
import { jobTabFrom, jobTabHref, jobTabs, type JobPageTab } from "../role-status";
import { MUST_HAVES_SCORE_LINE, SCORE_WEIGHTS_LINE, checkedInLabel, editorFocusFrom, importanceLabel, type EditorFocus } from "../skills-form";
import { SAFETY_NET_NOTE } from "../talent-list";
import { CloseRoleCard, ClosingMessageCard } from "../components/ClosingMessage";
import { AfterApproval } from "./AfterApproval";
import { JobHeader, JobMenu, JobTabs, jobFactsFor } from "./JobHeader";
import { ClosedBanner, PostingTab, StillUpAlert } from "./RolePosting";
import { ActivityTab, CandidatesSeeThis, DIVIDED_ROW as ROW, DIVIDED_ROWS as ROWS, InterviewPlanTab, ORDINAL, PacketApprovalCard, PreferencesCard, RequirementList, catchUpInterval, waitingOnWorker, workModelLabel } from "./RolePlan";
import { EditPacket } from "./RoleEditor";
import { ReportTab } from "./RoleReport";
import { ApplicantQuestions } from "./role/ApplicantQuestions";
import { WeightsPreview } from "./role/WeightsPreview";
import { CandidatePreview } from "./new-role/CandidatePreview";
import { RoleRefine } from "./new-role/RoleRefine";
import { RoomAlert } from "./new-role/StartView";
import { useStartDraft } from "./new-role/use-start-draft";

/**
 * An interviewer opens only the jobs they interview for; any other job answers "not found" (as if it did not exist).
 * The page says so plainly instead of a failure to retry.
 */
export function notOnThisJob(error: unknown, myRole: string | null | undefined): boolean {
  return myRole === "interviewer" && error instanceof ApiError && (error.status === 404 || error.status === 403);
}

/** What an interviewer sees on a job they are not on, or on its candidates: where their own interviews are. */
export function NotOnThisJob(props: { title?: string; body?: string }) {
  return (
    <EmptyState
      icon="calendar"
      title={props.title ?? "You are not on this job"}
      body={props.body ?? "You see the jobs you interview for. Your interviews are under Interviews."}
      action={<Link to="/interviews" className="btn primary">Go to Interviews</Link>}
    />
  );
}

/** Statuses in which the packet is still worked on, so a change can be asked for by chat (plan C10). */
const REFINABLE = ["draft", "pending_approval", "open", "paused"];

/**
 * The job page (Wave S1: simple, Kanvis-like): the job's header and its one tab strip, shared with its Candidates page.
 * Job (the description and the basics), Scoring (must-haves, what we look for and, since Wave S7, the questions every
 * applicant answers), Interview plan, Share (where it is
 * posted), Report and Activity. `?tab=` opens a tab; older names (`posting`, `overview`, `requirements`, `evaluation`,
 * `history`) open the tab that now holds them, so every link in a notification or an email still lands. Approving the
 * job as one thing, the close card and the closing message sit under the tab strip, on every tab.
 */
export function RoleDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  // The version this page approved: until the worker has opened the role (or made that version current), the page
  // reads the role again. Just after "Ask for approval" it does the same until the approval request exists.
  const [approvedVersion, setApprovedVersion] = useState<number | null>(null);
  const waitingSince = useRef<number | null>(null);
  const role = useQuery({
    queryKey: ["role", id],
    queryFn: () => api.get<RoleDetailT>(`/api/v1/roles/${id}`),
    // A refusal (a job this person is not on) is an answer, not a hiccup: it is not asked again.
    retry: (count, e) => !(e instanceof ApiError && (e.status === 403 || e.status === 404)) && count < 1,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || !waitingOnWorker(data, approvedVersion)) {
        waitingSince.current = null;
        return false;
      }
      if (waitingSince.current === null) waitingSince.current = Date.now();
      return catchUpInterval(true, waitingSince.current, Date.now());
    },
  });
  const waiting = !!role.data && waitingOnWorker(role.data, approvedVersion);
  const wasWaiting = useRef(false);
  useEffect(() => {
    // Once the worker has caught up, the roles list (the rail's dot), Home and the Share tab read the new state too.
    if (wasWaiting.current && !waiting) {
      setApprovedVersion(null);
      qc.invalidateQueries({ queryKey: ["roles"] });
      qc.invalidateQueries({ queryKey: ["postings", id] });
      qc.invalidateQueries({ queryKey: ["brief"] });
    }
    wasWaiting.current = waiting;
  }, [waiting, qc, id]);
  const [search] = useSearchParams();
  const navigate = useNavigate();
  // The tab is the address's: a tab link, a notification or a Home card all change `?tab=`.
  const tab = jobTabFrom(search.get("tab"));
  const pickTab = (next: string) => navigate(jobTabHref(id ?? "", jobTabFrom(next)));
  // What the signed-in person may change here follows the permission matrix (roles.ts); until it is known, nothing that changes the role is offered.
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const membership = me.data?.memberships.find((m) => m.companyId === me.data?.activeCompanyId);
  const myRole = membership?.role ?? null;
  const companyName = membership?.companyName ?? me.data?.staffAccess?.companyName ?? null;
  // The editor is mounted only while open and starts from the version it was opened on (the one waiting for approval, when there is one).
  // `focus` opens it at the must-haves or the skills.
  const [editBase, setEditBase] = useState<{ version: number; packet: RolePacket; proposed: boolean; newestAtOpen: number; focus: EditorFocus | null } | null>(null);
  // "Show vN" on the approval card: the tabs show the version waiting for approval instead of the one the role runs on.
  const [showProposed, setShowProposed] = useState(false);
  // An open role of a company ITS has not confirmed yet is not public (founder decision B7): the page says so at the top.
  const check = useCompanyCheck();
  // "See what candidates will see" (plan C9) and "Hire for this job again" (C14).
  const [previewOpen, setPreviewOpen] = useState(false);
  // "Try different weights" (founder decision L-07 A): a preview that saves nothing, from the Scoring tab or the More menu.
  const [weightsOpen, setWeightsOpen] = useState(false);
  const again = useStartDraft();
  // The screen right after approval (plan D2): where the job is going, opened by the approval card.
  const [afterApproval, setAfterApproval] = useState<{ editWhileOpen: boolean } | null>(null);

  const [closing, setClosing] = useState<{ outcome: string } | null>(null);
  // "Close the role" on Home's closing-date card links here with `?close=1`: the close form opens, nothing is closed yet.
  const wantsClose = search.get("close") === "1";
  const closeAsked = useRef(false);
  useEffect(() => {
    if (!wantsClose || closeAsked.current || !role.data || !me.data) return;
    closeAsked.current = true;
    const mine = me.data.memberships.find((m) => m.companyId === me.data?.activeCompanyId)?.role ?? null;
    if (canRecordOutcome(mine) && ["open", "paused"].includes(role.data.status)) setClosing({ outcome: "no_hire" });
  }, [wantsClose, role.data, me.data]);
  // "Send the closing message" on Home's card for a closed role links here with `?closingMessage=1` (founder decision Q30).
  const wantsClosingMessage = search.get("closingMessage") === "1";
  const [closingMessage, setClosingMessage] = useState(wantsClosingMessage);
  useEffect(() => { if (wantsClosingMessage) setClosingMessage(true); }, [wantsClosingMessage]);
  // `?edit=must-haves` (the role report's and the pool summary's "stricter than needed" prompt) or `?edit=skills` opens
  // the editor at that section for someone who may edit; `?edit=1` (Edit in the Candidates page's More menu) opens it at
  // the top. Nothing is saved until they save a new version.
  const wantsEdit = editorFocusFrom(search.get("edit"));
  const wantsEditTop = search.get("edit") === "1";
  const editAsked = useRef(false);
  useEffect(() => {
    if ((!wantsEdit && !wantsEditTop) || editAsked.current || !role.data || !me.data) return;
    editAsked.current = true;
    const mine = me.data.memberships.find((m) => m.companyId === me.data?.activeCompanyId)?.role ?? null;
    const d = role.data;
    const pending = d.packetApproval?.pending?.editWhileOpen ? d.proposedPacket : null;
    const from = pending ?? d.currentPacket;
    if (canEditPacket(mine) && from) setEditBase({ version: from.version, packet: from.packet, proposed: !!pending, newestAtOpen: Math.max(0, ...d.packetVersions.map((v) => v.version)), focus: wantsEdit });
  }, [wantsEdit, wantsEditTop, role.data, me.data]);
  // `?preview=1` (Candidate view in the Candidates page's More menu) opens the job page as candidates see it.
  const wantsPreview = search.get("preview") === "1";
  useEffect(() => { if (wantsPreview) setPreviewOpen(true); }, [wantsPreview]);
  // The first draw, on the server and in the browser alike, is this skeleton (Wave S2): the rail reads the jobs list,
  // never the job itself, so the browser holds none of the job before it takes the page over. Anything this page shows
  // one day from the rail's jobs list must wait for useIsClient() (components/use-is-client.ts), as on Candidates.
  if (role.isLoading) return <Skeleton lines={5} />;
  if (notOnThisJob(role.error, myRole)) return <NotOnThisJob />;
  if (role.error || !role.data) return <ErrorState message="Could not load this job." onRetry={() => role.refetch()} />;
  const r = role.data;
  const manage = canManageRole(myRole);
  const editPacket = canEditPacket(myRole);
  const talent = canSeeTalent(myRole);
  const activity = canSeeActivity(myRole);
  const current = r.currentPacket;
  const proposed = r.packetApproval?.pending?.editWhileOpen ? r.proposedPacket : null;
  const shown = showProposed && proposed ? proposed : current;
  const p = shown?.packet;
  const editSource = proposed ?? current;
  const newestVersion = Math.max(0, ...r.packetVersions.map((v) => v.version));
  const openEditor = (focus: EditorFocus | null = null) => { if (editSource) setEditBase({ version: editSource.version, packet: editSource.packet, proposed: !!proposed && editSource === proposed, newestAtOpen: newestVersion, focus }); };
  const share = canShareJob(myRole);
  const applicants = r.counts ? Object.values(r.counts).reduce((a, b) => a + b, 0) : 0;
  const tabItems = jobTabs({ seesCandidates: talent, candidates: applicants });
  // Only with someone to put in order, and never on an ITS grant about one candidate (roles.ts canTryWeights).
  const mayTryWeights = canTryWeights(myRole, me.data?.staffAccess?.scope) && !!current && applicants > 0;
  const visibleTab: JobPageTab = tabItems.some((o) => o.id === tab) ? tab : "job";

  return (
    <div className="stack gap-5 [&>.page-header]:mb-1">
      <JobHeader
        title={r.title}
        status={r.status}
        pulse={r.status === "open" && r.acceptingApplications}
        companyName={companyName}
        // place · type · how it is worked · pay, and "Apply by …" (plan D7) while a closing date is set
        sub={jobFactsFor(r) ?? "No job details yet."}
        actions={
          <>
            <AskRecruiter roleId={r.id} />
            <JobMenu
              roleId={r.id}
              role={r}
              status={r.status}
              myRole={myRole}
              closingMessageOpen={closingMessage || !!closing}
              on={{
                edit: editSource ? () => openEditor() : undefined,
                preview: shown && talent ? () => setPreviewOpen(true) : undefined,
                weights: mayTryWeights ? () => setWeightsOpen(true) : undefined,
                close: () => setClosing({ outcome: "filled_outside_platform" }),
                // Not while the close card is up (it shows the closing message, then its Undo): the sheet would not open under it.
                "closing-message": () => setClosingMessage(true),
                "hire-again": () => again.hireAgain(r.id),
              }}
            />
          </>
        }
      />

      {p ? <JobTabs roleId={r.id} current={visibleTab} items={tabItems} /> : null}

      {again.limit?.room && !again.limit.room.ok ? <RoomAlert room={again.limit.room} ask={again.limit.ask} /> : null}
      {again.problem ? <Alert tone="critical">{again.problem}</Alert> : null}
      <StillUpAlert channels={r.boardsStillUp ?? []} roleStatus={r.status} onOpen={() => pickTab("share")} canManage={manage} whoPosts={r.whoPosts} />
      {/* An approved change is live on the job page; the boards posted by hand still show the earlier version (plan D4). */}
      {(r.status === "open" || r.status === "paused") && r.boardsShowingOldVersion?.length ? <Alert tone="caution">{outdatedBoardsLine(r.boardsShowingOldVersion, r.whoPosts)} <Button size="sm" onClick={() => pickTab("share")}>Go to the Share tab</Button></Alert> : null}
      <ClosedBanner role={r} canManage={manage} onOpenPosting={() => pickTab("share")} />
      {check === "waiting" && ["open", "paused"].includes(r.status) ? <Alert tone="caution">{ROLE_WAITS_FOR_CHECK}</Alert> : null}

      {/* Closing lists who is still in process, then shows the one closing message for them all (founder decision Q30). */}
      {closing ? <CloseRoleCard roleId={r.id} initialOutcome={closing.outcome} mayTell={canDecline(myRole)} onClose={() => setClosing(null)} /> : null}
      {closingMessage && !closing && r.status === "closed" && canDecline(myRole) ? <ClosingMessageCard roleId={r.id} onDone={() => { setClosingMessage(false); if (search.get("closingMessage")) navigate(`/roles/${r.id}`, { replace: true }); }} /> : null}

      {p ? <PacketApprovalCard role={r} onEdit={() => openEditor()} canEdit={editPacket} canManage={manage} canSeePay={canSeePay(myRole)} showingProposed={shown === proposed && !!proposed} onShowProposed={setShowProposed} onApproved={(info) => { setShowProposed(false); setAfterApproval(info); setApprovedVersion(r.packetApproval?.pending?.version ?? newestVersion); }} /> : null}

      {p ? (
        <>
          {proposed && shown === proposed ? <Alert tone="info">Showing version {proposed.version}, waiting for approval. The job still runs on version {current?.version ?? "?"}. <Button size="sm" onClick={() => setShowProposed(false)}>Back to version {current?.version ?? "?"}</Button></Alert> : null}

          {visibleTab === "job" ? (
            <>
              {/* The description on the left, the basics beside it as a narrow side card (screenshot 7's "at a glance") */}
              <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
                <div className="stack gap-5">
                  <Card title="Job description" aside={<CandidatesSeeThis />}><p className="whitespace-pre-wrap text-ink-2">{p.description.publicJobDescription}</p></Card>
                  {editPacket && REFINABLE.includes(r.status) ? <RoleRefine roleId={r.id} packet={editSource?.packet ?? p} whoPosts={r.whoPosts} /> : null}
                </div>
                <Card title="The basics" aside={<Chip>Version {shown!.version}</Chip>} className="p-5">
                  <dl className={FACTS}>
                    <Fact term="Pay">{money(p)}</Fact>
                    <Fact term="Shown to candidates">{payShownLabel(shown!, p.compensation.discloseRange)}</Fact>
                    <Fact term="Work model">{workModelLabel(p.identity.remotePolicy)}</Fact>
                    <Fact term="Schedule">{p.identity.schedule ?? "As posted"}</Fact>
                    <Fact term="Target start">{p.business.timeline.targetStartDate ?? "Flexible"}</Fact>
                  </dl>
                  <details className="more mt-4 border-t border-line pt-4">
                    <summary>Pay ceiling, reason and urgency</summary>
                    <dl className={FACTS}>
                      <Fact term="Ceiling">{p.compensation.basis === "hourly" ? `$${p.compensation.ceiling}/hr` : `$${p.compensation.ceiling.toLocaleString()}`} <span className="muted small font-normal">(never exceeded without your approval)</span></Fact>
                      <Fact term="Pay sources">{p.compensation.sources.map((s) => s.name).join("; ") || "owner-stated"}</Fact>
                      <Fact term="Reason">{REASON_WORD[p.business.reason] ?? p.business.reason.replace(/_/g, " ")}{p.business.reasonDetail ? ` · ${p.business.reasonDetail}` : ""}</Fact>
                      <Fact term="Urgency">{p.business.timeline.urgency}</Fact>
                    </dl>
                  </details>
                </Card>
              </div>
              <details className="more">
                <summary>What matters to you, and where candidates come from</summary>
                <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2">
                  <PreferencesCard packet={p} decisionMaker={r.decisionMaker ?? null} />
                  <Card title="Where candidates will come from"><p className="small text-ink-2">{p.sourcing.summary}</p><div className="row mt-3">{p.sourcing.channels.map((c) => <Chip key={c}>{c.replace("_", " ")}</Chip>)}</div></Card>
                </div>
              </details>
            </>
          ) : null}

          {visibleTab === "scoring" ? (
            <div className="stack gap-5">
              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <Card title="Must-haves" aside={<CandidatesSeeThis />}>
                  <RequirementList items={p.requirements.mustHaves} empty="None listed." />
                  <p className="small muted mt-4">{MUST_HAVES_SCORE_LINE}</p>
                  <details className="more mt-2">
                    <summary>Where each one is checked</summary>
                    <p className="small muted">The job page lists each one in these words; why it matters and where it is checked stay with your team. "Evidenced in" says where each one is checked; a must-have marked "screen" is asked about in the AI interview.</p>
                  </details>
                  {editPacket ? <div className="row mt-4"><Button size="sm" icon="edit" onClick={() => openEditor("must-haves")}>Change the must-haves</Button></div> : null}
                </Card>
                <Card title="What we look for">
                  <ul className={ROWS}>{p.competencies.map((c) => <li key={c.key} className={cn(ROW, "grid gap-1")}><span className="flex flex-wrap items-center gap-x-2 gap-y-1"><strong>{c.name}</strong> <span className="sbar-tag">{importanceLabel(c)}</span> <Chip>{checkedInLabel(c.evaluatedIn)}</Chip></span><span className="small muted">{c.definition}</span></li>)}</ul>
                  <p className="small muted mt-4">{SCORE_WEIGHTS_LINE}</p>
                  {editPacket ? <div className="row mt-4"><Button size="sm" icon="edit" onClick={() => openEditor("skills")}>Change the skills or how much each counts</Button>{mayTryWeights ? <Button size="sm" onClick={() => setWeightsOpen(true)}>Try different weights</Button> : null}</div> : null}
                </Card>
                <Card title="Nice-to-haves" aside={<CandidatesSeeThis />}><RequirementList items={p.requirements.niceToHaves} empty="None listed." /></Card>
                <Card title={`Screening questions (about ${p.screening.maxMinutes} minutes)`}>
                  <ol className={ROWS}>{p.screening.questions.map((q, i) => <li key={q.key} className={cn(ROW, "flex items-start gap-3")}><span aria-hidden="true" className={ORDINAL}>{i + 1}</span><span className="min-w-0 flex-1">{q.question} <Chip>{q.kind}</Chip></span></li>)}</ol>
                </Card>
              </div>
              {/* Wave S7: the quick questions on the form and the written questions in the chat, changed here. */}
              <ApplicantQuestions
                roleId={r.id}
                packet={p}
                editBase={editPacket && editSource && r.status !== "closed" ? { version: editSource.version, packet: editSource.packet } : null}
                whoPosts={r.whoPosts}
                onEditEligibility={editPacket && editSource && r.status !== "closed" ? () => openEditor() : undefined}
              />
              <details className="more">
                <summary>Eligibility questions, interview rounds, messages and notices</summary>
                <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                  <Card title="Eligibility questions (the only automatic holds)">
                    <p className="small muted mb-2">Candidates answer these when they apply. A "no" on a required one holds them for you to decide; nobody is declined automatically.</p>
                    <p className="small muted mb-3">After you decline: {SAFETY_NET_NOTE.charAt(0).toLowerCase()}{SAFETY_NET_NOTE.slice(1)}</p>
                    <ul className={ROWS}>{p.requirements.eligibility.map((e) => <li key={e.key} className={cn(ROW, "grid gap-1")}><span>{e.question} <Chip tone={e.knockout ? "needs" : "neutral"}>{e.knockout ? "required" : "asked"}</Chip></span><span className="small muted">{e.rationale}</span></li>)}</ul>
                  </Card>
                  <Card title="Interview rounds"><p className="small text-ink-2">{p.interviews.plan.map((s) => s.title).join(", ")}.</p><p className="small muted mt-1.5">Who interviews in each round is on the Interview plan tab.</p><div className="row mt-4"><Button size="sm" onClick={() => pickTab("plan")}>Open the interview plan</Button></div></Card>
                  <Card title="How candidates are messaged"><p className="small text-ink-2">{p.communication.disclosureText}</p><p className="small muted mt-1.5">{p.communication.humanAlternativeText}</p></Card>
                  <Card title="Notices candidates see"><div className="row">{p.compliance.notices.map((n) => <Chip key={n}>{n.replace(/_/g, " ")}</Chip>)}</div><p className="small muted mt-3">Jurisdictions: {p.compliance.jurisdictions.join(", ") || "none"}</p></Card>
                </div>
              </details>
            </div>
          ) : null}

          {visibleTab === "plan" ? <InterviewPlanTab roleId={r.id} canEdit={editPacket} /> : null}

          {visibleTab === "share" ? <PostingTab roleId={r.id} roleStatus={r.status} canManage={manage} canShare={share} roleTitle={r.title} companyName={companyName} /> : null}
          {/* ITS's "apply and talk in one visit" switch is hidden since 20 Oct 2026 (R20-12): every applicant takes the same path. */}

          {visibleTab === "report" ? <ReportTab roleId={r.id} /> : null}

          {visibleTab === "activity" ? (
            <div className="stack gap-5">
              {activity ? <ActivityTab roleId={r.id} /> : null}
              <Card title="Versions of the job">
                <ul className={ROWS}>
                  {r.packetVersions.map((v) => <li key={v.version} className={cn(ROW, "text-sm text-ink-2")}><strong className="text-ink">Version {v.version}</strong> · {v.status} · {v.source.replace("_", " ")} · {new Date(v.createdAt).toLocaleString()} · {v.createdBy.name ?? v.createdBy.kind}{v.changeSummary ? ` · ${v.changeSummary}` : ""}</li>)}
                </ul>
                <p className="small muted mt-4">Every version is kept. Nothing is overwritten.</p>
              </Card>
            </div>
          ) : null}
        </>
      ) : null}

      {editBase ? <EditPacket key={editBase.version} open onClose={() => setEditBase(null)} roleId={r.id} packet={editBase.packet} version={editBase.version} proposed={editBase.proposed} currentVersion={current?.version ?? null} newerVersion={newestVersion > editBase.newestAtOpen ? newestVersion : null} advanced={canEditPacketJson(myRole)} roleStatus={r.status} mayApprove={canApproveRole(myRole)} whoPosts={r.whoPosts} closingDate={r.closingDate ?? null} canManage={manage} focus={editBase.focus} /> : null}
      {/* "Use these weights" closes the preview and opens the editor at the part that changed; nothing is carried over. */}
      {weightsOpen && current ? <WeightsPreview roleId={r.id} packet={current.packet} onClose={() => setWeightsOpen(false)} onUse={(focus) => { setWeightsOpen(false); openEditor(focus); }} /> : null}
      {afterApproval ? <AfterApproval open onClose={() => setAfterApproval(null)} roleId={r.id} roleTitle={r.title} companyName={companyName} editWhileOpen={afterApproval.editWhileOpen} canManage={manage} canShare={share} canEditPacket={editPacket} onOpenTab={(t) => pickTab(t)} /> : null}
      {/* The preview shows pay, so it is offered to the roles that see pay (everyone but an interviewer). */}
      {shown && talent ? <CandidatePreview open={previewOpen} onClose={() => setPreviewOpen(false)} path={`/api/v1/roles/${r.id}/preview?version=${shown.version}`} /> : null}
    </div>
  );
}

function money(p: RolePacket): string {
  return formatPayRange(p.compensation);
}

/** The basics as label-over-value rows split by hairlines, like the side card's facts in screenshot 7. */
const FACTS = "m-0 grid grid-cols-1";
function Fact(props: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      <dt className="text-[12.5px] text-ink-3">{props.term}</dt>
      <dd className="m-0 text-[14.5px] font-medium text-ink [overflow-wrap:anywhere]">{props.children}</dd>
    </div>
  );
}

// Lists inside a card as rows divided by hairlines, and the round number beside an ordered one, come from RolePlan.tsx
// (ROWS, ROW, ORDINAL), so this page, the approval card and the questions card read alike.

// The packet editor lives in RoleEditor.tsx; the approval card, the preferences card and the Interview plan and Activity
// tabs in RolePlan.tsx; the header, the tab strip and the More menu in JobHeader.tsx (shared with the Candidates page).
