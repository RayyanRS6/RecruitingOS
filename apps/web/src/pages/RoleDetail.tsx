"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "../nav";
import { Alert, Button, Card, Chip, ErrorState, PageHeader, Pill, Skeleton, TabPanel, Tabs } from "@ros/ui";
import { formatPayRange } from "@ros/contracts";
import { api, ApiError, type Me, type RoleDetail as RoleDetailT, type RolePacket } from "../api/client";
import { toast } from "../toast";
import { ROLE_WAITS_FOR_CHECK } from "../company-check";
import { isItsStaff } from "../apply-flow";
import { AskRecruiter } from "../components/AskRecruiter";
import { RoleApplyMode } from "../components/ApplyMode";
import { useCompanyCheck } from "../components/use-company-check";
import { canApproveRole, canDecline, canEditPacket, canEditPacketJson, canManageRole, canRecordOutcome, canSeeActivity, canSeePay, canSeeTalent, canShareJob, canStartHire } from "../roles";
import { outdatedBoardsLine } from "../publishing";
import { payShownLabel } from "../role-words";
import { REASON_WORD } from "./new-role/rules";
import { roleStatus } from "../role-status";
import { MUST_HAVES_SCORE_LINE, SCORE_WEIGHTS_LINE, checkedInLabel, editorFocusFrom, importanceLabel, type EditorFocus } from "../skills-form";
import { CloseRoleCard, ClosingMessageCard } from "../components/ClosingMessage";
import { AfterApproval } from "./AfterApproval";
import { AcceptingSwitch, ClosedBanner, PostingTab, StillUpAlert } from "./RolePosting";
import { ActivityTab, CandidatesSeeThis, InterviewPlanTab, PacketApprovalCard, PreferencesCard, RequirementList, workModelLabel } from "./RolePlan";
import { EditPacket } from "./RoleEditor";
import { ReportTab } from "./RoleReport";
import { CandidatePreview } from "./new-role/CandidatePreview";
import { RoleRefine } from "./new-role/RoleRefine";
import { RoomAlert } from "./new-role/StartView";
import { mayHireAgain } from "./new-role/rules";
import { useStartDraft } from "./new-role/use-start-draft";

/** Statuses in which the packet is still worked on, so a change can be asked for by chat (plan C10). */
const REFINABLE = ["draft", "pending_approval", "open", "paused"];

type Tab = "overview" | "requirements" | "evaluation" | "plan" | "posting" | "activity" | "history" | "report";
const TABS: readonly Tab[] = ["overview", "requirements", "evaluation", "plan", "posting", "activity", "history", "report"];
/** `?tab=posting` opens the Posting tab straight from a notification or a brief card. */
function tabFrom(value: string | null): Tab {
  return value && (TABS as readonly string[]).includes(value) ? (value as Tab) : "overview";
}

/** The role page: approve the packet as one thing, see where it is posted, and edit without losing history. */
export function RoleDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const role = useQuery({ queryKey: ["role", id], queryFn: () => api.get<RoleDetailT>(`/api/v1/roles/${id}`) });
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const wantedTab = search.get("tab");
  const [tab, setTab] = useState<Tab>(tabFrom(wantedTab));
  // A notification or a brief card followed while this page is already open only changes the query string: follow it.
  useEffect(() => { if (wantedTab) setTab(tabFrom(wantedTab)); }, [wantedTab]);
  // A tab picked by hand keeps the address honest, so the next `?tab=posting` link is seen as a change.
  const pickTab = (next: Tab) => { setTab(next); if (wantedTab && wantedTab !== next) navigate(`/roles/${id}?tab=${next}`, { replace: true }); };
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
  // "See what candidates will see" (plan C9) and "Hire for this role again" (C14).
  const [previewOpen, setPreviewOpen] = useState(false);
  const again = useStartDraft();
  // The screen right after approval (plan D2): where the job is going, opened by the approval card.
  const [afterApproval, setAfterApproval] = useState<{ editWhileOpen: boolean } | null>(null);

  const status = useMutation({
    mutationFn: (action: "pause" | "resume") => api.post(`/api/v1/roles/${id}/${action}`, {}),
    // The roles list too: the rail's dot and count for this role follow its status.
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ["role", id] }); await qc.invalidateQueries({ queryKey: ["roles"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not change the role."),
  });
  const [closing, setClosing] = useState<{ outcome: string } | null>(null);
  // "Close the role" on Today's closing-date card links here with `?close=1`: the close form opens, nothing is closed yet.
  const wantsClose = search.get("close") === "1";
  const closeAsked = useRef(false);
  useEffect(() => {
    if (!wantsClose || closeAsked.current || !role.data || !me.data) return;
    closeAsked.current = true;
    const mine = me.data.memberships.find((m) => m.companyId === me.data?.activeCompanyId)?.role ?? null;
    if (canRecordOutcome(mine) && ["open", "paused"].includes(role.data.status)) setClosing({ outcome: "no_hire" });
  }, [wantsClose, role.data, me.data]);
  // "Send the closing message" on Today's card for a closed role links here with `?closingMessage=1` (founder decision Q30).
  const wantsClosingMessage = search.get("closingMessage") === "1";
  const [closingMessage, setClosingMessage] = useState(wantsClosingMessage);
  useEffect(() => { if (wantsClosingMessage) setClosingMessage(true); }, [wantsClosingMessage]);
  // `?edit=must-haves` (the role report's and the pool summary's "stricter than needed" prompt) or `?edit=skills` opens
  // the editor at that section for someone who may edit; nothing is saved until they save a new version.
  const wantsEdit = editorFocusFrom(search.get("edit"));
  const editAsked = useRef(false);
  useEffect(() => {
    if (!wantsEdit || editAsked.current || !role.data || !me.data) return;
    editAsked.current = true;
    const mine = me.data.memberships.find((m) => m.companyId === me.data?.activeCompanyId)?.role ?? null;
    const d = role.data;
    const pending = d.packetApproval?.pending?.editWhileOpen ? d.proposedPacket : null;
    const from = pending ?? d.currentPacket;
    if (canEditPacket(mine) && from) setEditBase({ version: from.version, packet: from.packet, proposed: !!pending, newestAtOpen: Math.max(0, ...d.packetVersions.map((v) => v.version)), focus: wantsEdit });
  }, [wantsEdit, role.data, me.data]);
  if (role.isLoading) return <Skeleton lines={5} />;
  if (role.error || !role.data) return <ErrorState message="Could not load this role." onRetry={() => role.refetch()} />;
  const r = role.data;
  const manage = canManageRole(myRole);
  const editPacket = canEditPacket(myRole);
  const talent = canSeeTalent(myRole);
  const activity = canSeeActivity(myRole);
  const current = r.currentPacket;
  const proposed = r.packetApproval?.pending?.editWhileOpen ? r.proposedPacket : null;
  const shown = showProposed && proposed ? proposed : current;
  const p = shown?.packet;
  const head = current?.packet;
  const editSource = proposed ?? current;
  const newestVersion = Math.max(0, ...r.packetVersions.map((v) => v.version));
  const openEditor = (focus: EditorFocus | null = null) => { if (editSource) setEditBase({ version: editSource.version, packet: editSource.packet, proposed: !!proposed && editSource === proposed, newestAtOpen: newestVersion, focus }); };
  const share = canShareJob(myRole);
  // "Apply by …" (plan D7): the line the job and careers pages show, beside the role's facts.
  const applyBy = r.closingDate?.closesOn && r.status !== "closed" ? r.closingDate.applyBy : null;
  const tabOptions = ([{ value: "overview", label: "Overview" }, { value: "requirements", label: "Requirements" }, { value: "evaluation", label: "How we'll evaluate" }, { value: "plan", label: "Interview plan" }, { value: "posting", label: "Posting" }, { value: "activity", label: "Activity" }, { value: "history", label: "History" }, { value: "report", label: "Report" }] as Array<{ value: Tab; label: string }>).filter((o) => (o.value !== "report" || talent) && (o.value !== "activity" || activity));
  const visibleTab: Tab = tabOptions.some((o) => o.value === tab) ? tab : "overview";
  const shownStatus = roleStatus(r.status);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader
        eyebrow={companyName ? `Job · ${companyName}` : "Job"}
        title={r.title}
        status={<Pill tone={shownStatus.tone} pulse={r.status === "open" && r.acceptingApplications}>{shownStatus.label}</Pill>}
        sub={head ? `${[head.identity.locations[0]?.city, head.identity.locations[0]?.region].filter(Boolean).join(", ")} · ${head.identity.employmentType.replace("_", " ")} · ${workModelLabel(head.identity.remotePolicy)} · ${money(head)}${applyBy ? ` · ${applyBy}` : ""}` : "No packet yet."}
        actions={
          <>
            <AskRecruiter roleId={r.id} />
            {canStartHire(myRole) && mayHireAgain(r.status) ? <Button variant="primary" icon="refresh" loading={again.pending} onClick={() => again.hireAgain(r.id)}>Hire for this role again</Button> : null}
            {manage ? <AcceptingSwitch role={r} /> : null}
            {manage && r.status === "open" ? <Button loading={status.isPending} onClick={() => status.mutate("pause")}>Pause</Button> : null}
            {manage && r.status === "paused" ? <Button loading={status.isPending} onClick={() => status.mutate("resume")}>Resume</Button> : null}
            {canRecordOutcome(myRole) && ["open", "paused"].includes(r.status) ? <Button variant="danger" onClick={() => setClosing({ outcome: "filled_outside_platform" })}>Close</Button> : null}
            {/* Not while the close card is up (it shows the closing message, then its Undo): the sheet would not open under it. */}
            {r.status === "closed" && canDecline(myRole) && !closingMessage && !closing ? <Button icon="send" onClick={() => setClosingMessage(true)}>Closing message</Button> : null}
          </>
        }
      />

      {again.limit?.room && !again.limit.room.ok ? <RoomAlert room={again.limit.room} ask={again.limit.ask} /> : null}
      {again.problem ? <Alert tone="critical">{again.problem}</Alert> : null}
      <StillUpAlert channels={r.boardsStillUp ?? []} roleStatus={r.status} onOpen={() => pickTab("posting")} canManage={manage} whoPosts={r.whoPosts} />
      {/* An approved change is live on the job page; the boards posted by hand still show the earlier version (plan D4). */}
      {(r.status === "open" || r.status === "paused") && r.boardsShowingOldVersion?.length ? <Alert tone="caution">{outdatedBoardsLine(r.boardsShowingOldVersion, r.whoPosts)} <Button size="sm" onClick={() => pickTab("posting")}>Go to the Posting tab</Button></Alert> : null}
      <ClosedBanner role={r} canManage={manage} onOpenPosting={() => pickTab("posting")} />
      {check === "waiting" && ["open", "paused"].includes(r.status) ? <Alert tone="caution">{ROLE_WAITS_FOR_CHECK}</Alert> : null}

      {/* Closing lists who is still in process, then shows the one closing message for them all (founder decision Q30). */}
      {closing ? <CloseRoleCard roleId={r.id} initialOutcome={closing.outcome} mayTell={canDecline(myRole)} onClose={() => setClosing(null)} /> : null}
      {closingMessage && !closing && r.status === "closed" && canDecline(myRole) ? <ClosingMessageCard roleId={r.id} onDone={() => { setClosingMessage(false); if (search.get("closingMessage")) navigate(`/roles/${r.id}`, { replace: true }); }} /> : null}

      {p ? <PacketApprovalCard role={r} onEdit={() => openEditor()} canEdit={editPacket} canManage={manage} canSeePay={canSeePay(myRole)} showingProposed={shown === proposed && !!proposed} onShowProposed={setShowProposed} onApproved={(info) => { setShowProposed(false); setAfterApproval(info); }} /> : null}

      {p ? (
        <>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 320px", minWidth: 0 }}>
              <Tabs idBase="role-sections" label="Role packet sections" value={visibleTab} onChange={(v) => pickTab(v as Tab)} items={tabOptions.map((o) => ({ id: o.value, label: o.label }))} />
            </div>
            <div className="row">
              <Chip>Packet v{shown!.version}</Chip>
              {talent ? <Button size="sm" icon="eye" onClick={() => setPreviewOpen(true)}>Candidate view</Button> : null}
              {editPacket ? <Button size="sm" icon="edit" onClick={() => openEditor()}>Edit</Button> : null}
              {talent ? <Link to={`/roles/${r.id}/talent`} className="btn primary sm">Talent ({r.counts ? Object.values(r.counts).reduce((a, b) => a + b, 0) : 0})</Link> : null}
            </div>
          </div>
          {proposed && shown === proposed ? <Alert tone="info">Showing v{proposed.version}, the version waiting for approval. The role still runs on v{current?.version ?? "?"} until it is approved. <Button size="sm" onClick={() => setShowProposed(false)}>Back to v{current?.version ?? "?"}</Button></Alert> : null}

          <TabPanel idBase="role-sections" value={visibleTab}>
            {visibleTab === "overview" ? (
              <div className="grid-2">
                <div className="stack">
                  <Card title="Public description"><p style={{ whiteSpace: "pre-wrap", color: "var(--ink-2)" }}>{p.description.publicJobDescription}</p></Card>
                  {editPacket && REFINABLE.includes(r.status) ? <RoleRefine roleId={r.id} packet={editSource?.packet ?? p} whoPosts={r.whoPosts} /> : null}
                </div>
                <div className="stack">
                  <Card title="Pay">
                    <dl className="kv">
                      <dt>Range</dt><dd>{money(p)}</dd>
                      <dt>Ceiling</dt><dd>{p.compensation.basis === "hourly" ? `$${p.compensation.ceiling}/hr` : `$${p.compensation.ceiling.toLocaleString()}`} <span className="muted small">(never exceeded without your approval)</span></dd>
                      <dt>Shown to candidates</dt><dd>{payShownLabel(shown!, p.compensation.discloseRange)}</dd>
                      <dt>Sources</dt><dd>{p.compensation.sources.map((s) => s.name).join("; ") || "owner-stated"}</dd>
                    </dl>
                  </Card>
                  <Card title="Why and when">
                    <dl className="kv">
                      <dt>Reason</dt><dd>{REASON_WORD[p.business.reason] ?? p.business.reason.replace(/_/g, " ")}{p.business.reasonDetail ? ` · ${p.business.reasonDetail}` : ""}</dd>
                      <dt>Target start</dt><dd>{p.business.timeline.targetStartDate ?? "Flexible"}</dd>
                      <dt>Urgency</dt><dd>{p.business.timeline.urgency}</dd>
                      <dt>Schedule</dt><dd>{p.identity.schedule ?? "As posted"}</dd>
                      <dt>Work model</dt><dd>{workModelLabel(p.identity.remotePolicy)}</dd>
                    </dl>
                  </Card>
                  <PreferencesCard packet={p} decisionMaker={r.decisionMaker ?? null} />
                  <Card title="Where candidates will come from"><p className="small" style={{ color: "var(--ink-2)" }}>{p.sourcing.summary}</p><div className="row" style={{ marginTop: 8 }}>{p.sourcing.channels.map((c) => <Chip key={c}>{c.replace("_", " ")}</Chip>)}</div></Card>
                </div>
              </div>
            ) : null}

            {visibleTab === "requirements" ? (
              <div className="grid-2">
                <Card title="Must-haves" aside={<CandidatesSeeThis />}>
                  <RequirementList items={p.requirements.mustHaves} empty="None listed." />
                  <p className="small muted" style={{ marginTop: 8 }}>The job page lists each one in these words; why it matters and where it is checked stay with your team. "Evidenced in" says where each one is checked; a must-have marked "screen" is asked about in the screening conversation.</p>
                  <p className="small muted" style={{ marginTop: 6 }}>{MUST_HAVES_SCORE_LINE}</p>
                  {editPacket ? <div className="row" style={{ marginTop: 8 }}><Button size="sm" icon="edit" onClick={() => openEditor("must-haves")}>Change the must-haves</Button></div> : null}
                </Card>
                <Card title="Nice-to-haves" aside={<CandidatesSeeThis />}><RequirementList items={p.requirements.niceToHaves} empty="None listed." /></Card>
                <Card title="Eligibility questions (the only automatic holds)">
                  <p className="small muted" style={{ marginBottom: 8 }}>Candidates answer these when they apply. A "no" on a required one holds the application for your decision: you are reminded, and nothing is sent to the candidate, even if you decline, until someone sends the decision message. Nothing is ever declined automatically.</p>
                  <ul style={{ paddingLeft: 18, margin: 0 }}>{p.requirements.eligibility.map((e) => <li key={e.key}>{e.question} <Chip tone={e.knockout ? "needs" : "neutral"}>{e.knockout ? "required" : "asked"}</Chip><br /><span className="small muted">{e.rationale}</span></li>)}</ul>
                </Card>
                <Card title="Notices candidates see"><div className="row">{p.compliance.notices.map((n) => <Chip key={n}>{n.replace(/_/g, " ")}</Chip>)}</div><p className="small muted" style={{ marginTop: 8 }}>Jurisdictions: {p.compliance.jurisdictions.join(", ") || "none"}</p></Card>
              </div>
            ) : null}

            {visibleTab === "evaluation" ? (
              <div className="grid-2">
                <Card title="What we look for">
                  <ul style={{ paddingLeft: 18, margin: 0 }}>{p.competencies.map((c) => <li key={c.key}><strong>{c.name}</strong> <span className="sbar-tag">{importanceLabel(c)}</span> <Chip>{checkedInLabel(c.evaluatedIn)}</Chip><br /><span className="small muted">{c.definition}</span></li>)}</ul>
                  <p className="small muted" style={{ marginTop: 8 }}>{SCORE_WEIGHTS_LINE}</p>
                  {editPacket ? <div className="row" style={{ marginTop: 8 }}><Button size="sm" icon="edit" onClick={() => openEditor("skills")}>Change the skills or how much each counts</Button></div> : null}
                </Card>
                <Card title={`Screening questions (about ${p.screening.maxMinutes} minutes)`}>
                  <ol style={{ paddingLeft: 18, margin: 0 }}>{p.screening.questions.map((q) => <li key={q.key}>{q.question} <Chip>{q.kind}</Chip></li>)}</ol>
                </Card>
                <Card title="Interview rounds"><p className="small" style={{ color: "var(--ink-2)" }}>{p.interviews.plan.map((s) => s.title).join(", ")}.</p><p className="small muted" style={{ marginTop: 6 }}>Who interviews in each round, and whether times can be offered to them, is on the Interview plan tab.</p><div className="row" style={{ marginTop: 8 }}><Button size="sm" onClick={() => pickTab("plan")}>Open the interview plan</Button></div></Card>
                <Card title="How candidates are messaged"><p className="small" style={{ color: "var(--ink-2)" }}>{p.communication.disclosureText}</p><p className="small muted" style={{ marginTop: 6 }}>{p.communication.humanAlternativeText}</p></Card>
              </div>
            ) : null}

            {visibleTab === "plan" ? <InterviewPlanTab roleId={r.id} canEdit={editPacket} /> : null}

            {/* ITS only (plan E1): whether this role's applicants apply and talk in one visit, or get the conversation later. */}
            {visibleTab === "posting" && isItsStaff(me.data) ? <div style={{ marginBottom: 14 }}><RoleApplyMode roleId={r.id} roleTitle={r.title} /></div> : null}
            {visibleTab === "posting" ? <PostingTab roleId={r.id} roleStatus={r.status} canManage={manage} canShare={share} roleTitle={r.title} companyName={companyName} /> : null}

            {visibleTab === "activity" ? <ActivityTab roleId={r.id} /> : null}

            {visibleTab === "report" ? <ReportTab roleId={r.id} /> : null}

            {visibleTab === "history" ? (
              <Card title="Packet versions">
                <ul style={{ paddingLeft: 18, margin: 0 }}>
                  {r.packetVersions.map((v) => <li key={v.version}>v{v.version} · {v.status} · {v.source.replace("_", " ")} · {new Date(v.createdAt).toLocaleString()} · {v.createdBy.name ?? v.createdBy.kind}{v.changeSummary ? ` · ${v.changeSummary}` : ""}</li>)}
                </ul>
                <p className="small muted" style={{ marginTop: 8 }}>Every version is kept. Nothing is overwritten.</p>
              </Card>
            ) : null}
          </TabPanel>
        </>
      ) : null}

      {editBase ? <EditPacket key={editBase.version} open onClose={() => setEditBase(null)} roleId={r.id} packet={editBase.packet} version={editBase.version} proposed={editBase.proposed} currentVersion={current?.version ?? null} newerVersion={newestVersion > editBase.newestAtOpen ? newestVersion : null} advanced={canEditPacketJson(myRole)} roleStatus={r.status} mayApprove={canApproveRole(myRole)} whoPosts={r.whoPosts} closingDate={r.closingDate ?? null} canManage={manage} focus={editBase.focus} /> : null}
      {afterApproval ? <AfterApproval open onClose={() => setAfterApproval(null)} roleId={r.id} roleTitle={r.title} companyName={companyName} editWhileOpen={afterApproval.editWhileOpen} canManage={manage} canShare={share} canEditPacket={editPacket} onOpenTab={(t) => pickTab(t)} /> : null}
      {/* The preview shows pay, so it is offered to the roles that see pay (everyone but an interviewer). */}
      {shown && talent ? <CandidatePreview open={previewOpen} onClose={() => setPreviewOpen(false)} path={`/api/v1/roles/${r.id}/preview?version=${shown.version}`} /> : null}
    </div>
  );
}

function money(p: RolePacket): string {
  return formatPayRange(p.compensation);
}

// The packet editor lives in RoleEditor.tsx; the approval card, the preferences card and the Interview plan and Activity tabs in RolePlan.tsx.
