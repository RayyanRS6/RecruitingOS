"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "../nav";
import { Alert, Button, Card, Chip, EmptyState, ErrorState, EvidenceChip, Field, Segmented, Sheet, Skeleton, StatusChip, Timeline } from "@ros/ui";
import { api, ApiError, type ApplicationCapability, type ApplicationDetail, type ApplicationSummary, type AssessmentResult, type RoleSummary, type Screen } from "../api/client";
import { toast } from "../toast";
import { AskRecruiter } from "../components/AskRecruiter";

type Group = "all" | "waiting_on_you" | "in_process" | "not_moving_forward" | "hired";

/** People: candidates grouped in plain language, evidence first, decisions as buttons, and "Ask a recruiter" on every one. */
export function People() {
  const params = useParams();
  const nav = useNavigate();
  const [search] = useSearchParams();
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles") });
  const roleId = params.id ?? roles.data?.find((r) => r.status === "open")?.id ?? roles.data?.[0]?.id;
  const [group, setGroup] = useState<Group>("all");
  const stage = search.get("stage");
  const apps = useQuery({ queryKey: ["applications", roleId, stage], queryFn: () => api.get<ApplicationSummary[]>(`/api/v1/roles/${roleId}/applications${stage ? `?stage=${stage}` : ""}`), enabled: !!roleId });
  // A deep link (`?open=<applicationId>`, used by every notification and brief card about one candidate) opens that sheet.
  const openParam = search.get("open");
  const [openId, setOpenId] = useState<string | null>(openParam);
  useEffect(() => { if (openParam) setOpenId(openParam); }, [openParam]);
  const closeSheet = () => {
    setOpenId(null);
    if (!openParam) return;
    const rest = new URLSearchParams(search);
    rest.delete("open");
    const qs = rest.toString();
    nav(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
  };
  const role = roles.data?.find((r) => r.id === roleId);
  const list = (apps.data ?? []).filter((a) => group === "all" || a.group === group);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <h1>Talent{role ? ` · ${role.title}` : ""}</h1>
          <p>Who applied, what the evidence says, and what needs you. Nobody is declined automatically on judgment.</p>
        </div>
        <div className="row">
          {roles.data && roles.data.length > 1 ? (
            <select className="select" style={{ width: "auto" }} value={roleId ?? ""} onChange={(e) => nav(`/roles/${e.target.value}/talent`)} aria-label="Role">
              {roles.data.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </select>
          ) : null}
          {roleId ? <AskRecruiter roleId={roleId} /> : null}
        </div>
      </div>
      {!roleId ? <EmptyState title="No roles yet" body="Open a role first." action={<Link to="/" className="btn primary">Go to Home</Link>} /> : (
        <>
          <Segmented value={group} onChange={setGroup} ariaLabel="Group" options={[{ value: "all", label: `All (${apps.data?.length ?? 0})` }, { value: "waiting_on_you", label: "Waiting on you" }, { value: "in_process", label: "In process" }, { value: "not_moving_forward", label: "Not moving forward" }, { value: "hired", label: "Hired" }]} />
          {apps.isLoading ? <Skeleton lines={4} /> : apps.error ? <ErrorState message="Could not load candidates." onRetry={() => apps.refetch()} /> : list.length === 0 ? (
            <EmptyState title="Nobody here yet" body={group === "all" ? "Applicants appear here as soon as they apply. Share your careers page or forward applications to the role's intake address." : "Nothing in this group."} />
          ) : (
            <div className="stack">
              {list.map((a) => (
                <Card key={a.id} needsYou={a.group === "waiting_on_you"}>
                  <div className="card-title">
                    <h2 style={{ fontSize: 16 }}><button type="button" className="btn quiet" style={{ padding: 0, fontFamily: "var(--display)", fontSize: 16 }} onClick={() => setOpenId(a.id)}>{a.candidate?.name ?? "Unknown"}</button></h2>
                    <div className="row"><Chip tone="source">{a.source.replace("_", " ")}</Chip><StatusChip stage={a.stage} label={a.stageLabel} group={a.group} /></div>
                  </div>
                  <div className="row small" style={{ color: "var(--ink-2)" }}>
                    {a.extractionSummary?.positions.slice(0, 2).map((p, i) => <span key={i}>{p}</span>)}
                    {a.extractionSummary?.years ? <Chip>{a.extractionSummary.years} yrs</Chip> : null}
                    {a.extractionSummary?.licenses.map((l) => <Chip key={l} tone="good">{l}</Chip>)}
                    {a.extractionSummary?.anomalies.map((an, i) => <Chip key={i} tone="caution">{an.kind.replace(/_/g, " ")}</Chip>)}
                    {a.candidate?.locationText ? <span className="muted">{a.candidate.locationText}</span> : null}
                  </div>
                  {a.eligibility && !a.eligibility.passed ? <p className="small" style={{ color: "var(--needs-you)", marginTop: 6 }}>Did not meet: {a.eligibility.failedRules.map((f) => f.question).join("; ")}</p> : null}
                  {a.eligibility?.unverifiable.length ? <p className="small muted" style={{ marginTop: 6 }}>Not yet answered: {a.eligibility.unverifiable.map((u) => u.question).join("; ")}</p> : null}
                  {a.assessment ? (
                    <div className="small" style={{ marginTop: 8 }}>
                      <strong>{overallLabel(a.assessment.overall)}</strong> <span className="muted">({a.assessment.confidence} confidence)</span> · {a.assessment.summary}
                    </div>
                  ) : null}
                  <div className="row" style={{ marginTop: 10 }}>
                    <Button size="sm" variant="primary" onClick={() => setOpenId(a.id)}>Review</Button>
                    <AskRecruiter roleId={roleId} applicationId={a.id} size="sm" />
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      {openId && roleId ? <ApplicationSheet id={openId} roleId={roleId} onClose={closeSheet} /> : null}
    </div>
  );
}

function overallLabel(o: string): string {
  return { strong: "Strong match", potential: "Potential match", weak: "Weak match", unknown: "Insufficient evidence" }[o] ?? o;
}

const REJECT_REASONS: Array<[string, string]> = [
  ["not_a_match_experience", "Experience isn't the right fit"],
  ["not_a_match_skills", "Missing skills we need"],
  ["compensation_mismatch", "Pay expectations don't match"],
  ["location_or_schedule", "Location or schedule"],
  ["position_filled", "Position filled"],
  ["other", "Other"],
];

function ApplicationSheet({ id, roleId, onClose }: { id: string; roleId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["application", id], queryFn: () => api.get<ApplicationDetail>(`/api/v1/applications/${id}`) });
  const [reason, setReason] = useState("not_a_match_experience");
  const [note, setNote] = useState("");
  const [overrideNote, setOverrideNote] = useState("");
  const [confirmReject, setConfirmReject] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(false);
  const [outcome, setOutcome] = useState<{ outcome: string; hireDate: string; offerAcceptedAt: string; reason: string; note: string; confirming: boolean }>({ outcome: "hired_externally", hireDate: "", offerAcceptedAt: "", reason: "", note: "", confirming: false });
  const [closeRolePrompt, setCloseRolePrompt] = useState<{ roleId: string } | null>(null);
  const recordOutcome = useMutation({
    mutationFn: () => api.post<{ roleStillOpen: boolean; roleId: string }>(`/api/v1/applications/${id}/outcome`, { outcome: outcome.outcome, confirm: true, hireDate: outcome.hireDate || undefined, offerAcceptedAt: outcome.offerAcceptedAt || undefined, reason: outcome.reason || undefined, note: outcome.note || undefined }),
    onSuccess: async (r) => { toast("Outcome recorded with your name."); setOutcomeOpen(false); setOutcome({ outcome: "hired_externally", hireDate: "", offerAcceptedAt: "", reason: "", note: "", confirming: false }); if (r.roleStillOpen && outcome.outcome === "hired_externally") setCloseRolePrompt({ roleId: r.roleId }); await qc.invalidateQueries({ queryKey: ["application", id] }); await qc.invalidateQueries({ queryKey: ["applications", roleId] }); await qc.invalidateQueries({ queryKey: ["brief"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record the outcome."),
  });
  const closeRole = useMutation({
    mutationFn: (rid: string) => api.post(`/api/v1/roles/${rid}/outcome`, { outcome: "filled", confirm: true }),
    onSuccess: async () => { toast("Role closed as filled."); setCloseRolePrompt(null); await qc.invalidateQueries({ queryKey: ["role", roleId] }); await qc.invalidateQueries({ queryKey: ["roles"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not close the role."),
  });
  const act = useMutation({
    mutationFn: (body: { action: string; reason?: string; note?: string; channel?: string }) => api.post(`/api/v1/applications/${id}/actions`, body),
    onSuccess: async (_r, body) => { toast(body.action === "reject" ? "Declined. A courteous message is on its way." : body.action === "invite_screen" ? "Invitation on its way." : body.action === "advance_to_interview" ? "Marked for interview." : "Done."); await qc.invalidateQueries({ queryKey: ["application", id] }); await qc.invalidateQueries({ queryKey: ["applications", roleId] }); await qc.invalidateQueries({ queryKey: ["brief"] }); await qc.invalidateQueries({ queryKey: ["notifications"] }); setConfirmReject(false); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "That didn't work."),
  });
  const decide = useMutation({
    mutationFn: (approvalId: string) => api.post(`/api/v1/approvals/${approvalId}/decide`, { decision: "approve" }),
    onSuccess: async () => { toast("Done."); await qc.invalidateQueries({ queryKey: ["application", id] }); await qc.invalidateQueries({ queryKey: ["applications", roleId] }); await qc.invalidateQueries({ queryKey: ["brief"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "That didn't work."),
  });
  const a = q.data;
  const openScreen = a?.screens.find((s) => ["invited", "reminded", "in_progress"].includes(s.status)) ?? null;
  const latestScreen = a?.screens[0] ?? null;
  /** The API decides what may be done right now; the page only shows it. */
  const can = (action: ApplicationCapability) => !!a && a.allowedActions.includes(action);
  const canInvite = can("invite_screen");
  const canInterview = can("interview");
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["application", id] }); await qc.invalidateQueries({ queryKey: ["applications", roleId] }); await qc.invalidateQueries({ queryKey: ["interviews"] }); await qc.invalidateQueries({ queryKey: ["brief"] }); };
  const [interviewOpen, setInterviewOpen] = useState(false);
  const members = useQuery({ queryKey: ["members"], queryFn: () => api.get<Array<{ userId: string; name: string | null; email: string; role: string; status: string; schedulable: boolean }>>("/api/v1/companies/current/members"), enabled: interviewOpen });
  const nextRound = a ? a.interviewPlan.find((r) => !a.interviews.some((i) => i.roundKey === r.key && ["completed"].includes(i.status))) ?? a.interviewPlan[0] : undefined;
  const [roundKey, setRoundKey] = useState<string | null>(null);
  const [interviewers, setInterviewers] = useState<string[] | null>(null);
  const [linkSource, setLinkSource] = useState<"calendar" | "pasted">("calendar");
  const [meetingUrl, setMeetingUrl] = useState("");
  const requestInterview = useMutation({
    mutationFn: () => api.post(`/api/v1/applications/${id}/interviews`, { roundKey: roundKey ?? nextRound?.key, interviewerUserIds: interviewers ?? nextRound?.interviewerUserIds ?? [], linkSource, meetingUrl: linkSource === "pasted" ? meetingUrl : undefined }),
    onSuccess: async () => { toast("Interview approved. Times go out to the candidate as soon as they exist."); setInterviewOpen(false); await qc.invalidateQueries({ queryKey: ["application", id] }); await qc.invalidateQueries({ queryKey: ["applications", roleId] }); await qc.invalidateQueries({ queryKey: ["interviews"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not start the interview."),
  });
  const chosenRound = a?.interviewPlan.find((r) => r.key === (roundKey ?? nextRound?.key));
  const chosenInterviewers = interviewers ?? chosenRound?.interviewerUserIds ?? [];
  return (
    <Sheet open onClose={onClose} title={a ? `${a.candidate.firstName} ${a.candidate.lastName}` : "Candidate"}>
      {q.isLoading || !a ? <Skeleton lines={6} /> : (
        <div className="stack" style={{ gap: 14 }}>
          <div className="row"><StatusChip stage={a.stage} label={a.stageLabel} group={a.group} /><Chip tone="source">{a.source.replace("_", " ")}</Chip><span className="small muted">applied {new Date(a.createdAt).toLocaleDateString()}</span></div>

          {a.pendingApprovals.filter((p) => ["application.invite_screen", "application.recommend_interview"].includes(p.actionType)).map((p) => (
            <Card key={p.id} needsYou lift title={p.actionType === "application.invite_screen" ? "The assistant suggests a screen" : "The assistant suggests an interview"}>
              <p className="small" style={{ color: "var(--ink-2)" }}>{p.rationale}</p>
              <div className="row" style={{ marginTop: 10 }}>
                <Button variant="primary" size="sm" loading={decide.isPending} onClick={() => decide.mutate(p.id)}>{p.actionType === "application.invite_screen" ? "Yes, invite to a screen" : "Yes, interview"}</Button>
                <AskRecruiter roleId={roleId} applicationId={a.id} size="sm" />
              </div>
            </Card>
          ))}
          {a.interviews.length ? (
            <Card title="Interviews">
              {a.interviews.map((i) => <p key={i.id} className="small"><Link to={`/interviews/${i.id}`}>{i.title}</Link> · {i.status.replace(/_/g, " ")}{i.startsAt ? ` · ${new Date(i.startsAt).toLocaleString("en-US", { timeZone: i.timezone ?? undefined, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : i.status === "scheduling" ? ` · ${i.offeredSlots.length} times offered` : ""}{i.decision ? ` · decision: ${i.decision.replace(/_/g, " ")}` : ""}</p>)}
            </Card>
          ) : null}
          {can("record_decision") ? <DecisionCard a={a} roleId={roleId} onDone={refresh} onNextRound={(key) => { setRoundKey(key); setInterviewers(null); setInterviewOpen(true); }} /> : null}
          {interviewOpen ? (
            <Card needsYou lift title="Approve an interview">
              <p className="small" style={{ color: "var(--ink-2)" }}>Your approval is what starts scheduling; the assistant never does this on its own. Times are offered to the candidate from the interviewers' calendars or declared hours.</p>
              <Field label="Round" htmlFor="iv-round"><select id="iv-round" className="select" value={roundKey ?? nextRound?.key ?? ""} onChange={(e) => { setRoundKey(e.target.value); setInterviewers(null); }}>{a.interviewPlan.map((r) => <option key={r.key} value={r.key}>{r.title} · {r.durationMinutes} min · {r.format.replace("_", " ")}</option>)}</select></Field>
              <fieldset style={{ border: 0, padding: 0, margin: "10px 0" }}>
                <legend className="small muted">Interviewers</legend>
                {members.isLoading ? <Skeleton lines={2} /> : (members.data ?? []).filter((m) => m.status === "active").map((m) => (
                  <label key={m.userId} className="row small" style={{ gap: 8 }}>
                    <input type="checkbox" checked={chosenInterviewers.includes(m.userId)} onChange={(e) => setInterviewers(e.target.checked ? [...chosenInterviewers, m.userId] : chosenInterviewers.filter((x) => x !== m.userId))} />
                    {m.name ?? m.email} <Chip tone={m.schedulable ? "good" : "caution"}>{m.schedulable ? "availability known" : "no calendar or hours yet"}</Chip>
                  </label>
                ))}
              </fieldset>
              {chosenInterviewers.length && (members.data ?? []).some((m) => chosenInterviewers.includes(m.userId) && !m.schedulable) ? <Alert tone="caution">An interviewer has neither a connected calendar nor declared hours. Times cannot be offered until they add one in Setup; they will be asked.</Alert> : null}
              <Field label="Meeting link" htmlFor="iv-link"><select id="iv-link" className="select" value={linkSource} onChange={(e) => setLinkSource(e.target.value as "calendar" | "pasted")}><option value="calendar">Create it with the calendar event</option><option value="pasted">I'll paste a link</option></select></Field>
              {linkSource === "pasted" ? <Field label="Link" htmlFor="iv-url"><input id="iv-url" className="input" type="url" value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} placeholder="https://" /></Field> : null}
              <div className="row" style={{ marginTop: 10 }}>
                <Button variant="primary" size="sm" loading={requestInterview.isPending} disabled={!chosenInterviewers.length || (linkSource === "pasted" && !meetingUrl)} onClick={() => requestInterview.mutate()}>Approve and offer times</Button>
                <Button size="sm" variant="quiet" onClick={() => setInterviewOpen(false)}>Not now</Button>
              </div>
            </Card>
          ) : null}
          {a.group === "waiting_on_you" || a.stage === "eligible" || canInterview || canInvite ? (
            <Card needsYou={a.group === "waiting_on_you" || a.stage === "eligible"} title="What would you like to do?">
              <div className="row">
                <Button variant="primary" size="sm" disabled={!canInvite} loading={act.isPending && act.variables?.action === "invite_screen"} title={openScreen ? "A screening invitation is already open" : canInvite ? (a.candidate.consent.sms?.granted && a.candidate.phone ? "By text and email" : "By email, answered on the web") : "Not available at this stage"} onClick={() => act.mutate({ action: "invite_screen" })}>Invite to a screen</Button>
                <Button size="sm" disabled={!canInterview} title={canInterview ? "Approve an interview round and pick the interviewers; times go out to the candidate" : a?.interviews.some((i) => ["proposed", "scheduling", "scheduled"].includes(i.status)) ? "An interview is already in motion" : "Not available at this stage"} onClick={() => setInterviewOpen(true)}>Interview</Button>
                <Button size="sm" disabled={!can("hold")} onClick={() => act.mutate({ action: "hold", note: "Holding for now" })}>Hold</Button>
                <Button size="sm" variant="destructive" disabled={!can("reject")} onClick={() => setConfirmReject(true)}>Decline</Button>
                <AskRecruiter roleId={roleId} applicationId={a.id} size="sm" />
              </div>
              {confirmReject ? (
                <div className="stack" style={{ marginTop: 12 }}>
                  <Alert tone="caution">Declining is your decision and it is recorded with your reason. The candidate gets a respectful message.</Alert>
                  <Field label="Reason" htmlFor="reason"><select id="reason" className="select" value={reason} onChange={(e) => setReason(e.target.value)}>{REJECT_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
                  <Field label="Note (kept internally)" htmlFor="note"><input id="note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                  <div className="row"><Button variant="destructive" loading={act.isPending} onClick={() => act.mutate({ action: "reject", reason, note })}>Confirm decline</Button><Button onClick={() => setConfirmReject(false)}>Cancel</Button></div>
                </div>
              ) : null}
            </Card>
          ) : null}
          {closeRolePrompt ? (
            <Card needsYou title="Close the role too?">
              <p className="small" style={{ color: "var(--ink-2)" }}>The hire is recorded. The role is still open; closing it is a separate decision. Other active candidates are kept in your talent pool.</p>
              <div className="row" style={{ marginTop: 10 }}><Button variant="primary" size="sm" loading={closeRole.isPending} onClick={() => closeRole.mutate(closeRolePrompt.roleId)}>Yes, close it as filled</Button><Button size="sm" variant="quiet" onClick={() => setCloseRolePrompt(null)}>Keep it open</Button></div>
            </Card>
          ) : null}
          {["hired", "withdrawn", "rejected", "talent_pool", "declined"].includes(a.stage) ? <RecordedOutcome id={a.id} /> : null}
          {can("record_outcome") ? (
            <Card title="Record what happened">
              <p className="small muted">Hired, withdrew, declined, or no hire. You record it; the platform never makes or sends an offer, and it asks for no pay, tax, identity or banking details.</p>
              {!outcomeOpen ? <div className="row" style={{ marginTop: 8 }}><Button size="sm" onClick={() => setOutcomeOpen(true)}>Record an outcome</Button></div> : (
                <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                  <Field label="What happened" htmlFor="oc-outcome"><select id="oc-outcome" className="select" value={outcome.outcome} onChange={(e) => setOutcome({ ...outcome, outcome: e.target.value, confirming: false })}>
                    <option value="hired_externally">Hired (offer accepted outside the platform)</option>
                    {a.stage !== "talent_pool" ? <>
                      <option value="offer_declined_externally">Declined an offer made outside the platform</option>
                      <option value="candidate_withdrew">The candidate withdrew</option>
                      <option value="employer_declined">We declined the candidate (they receive a respectful message)</option>
                      <option value="no_hire">No hire for this candidate</option>
                    </> : null}
                  </select></Field>
                  {outcome.outcome === "hired_externally" ? <>
                    <Field label="Hire date (start date agreed)" htmlFor="oc-date"><input id="oc-date" className="input" type="date" value={outcome.hireDate} onChange={(e) => setOutcome({ ...outcome, hireDate: e.target.value })} /></Field>
                    <Field label="Date the offer was accepted (optional)" htmlFor="oc-acc"><input id="oc-acc" className="input" type="date" value={outcome.offerAcceptedAt} onChange={(e) => setOutcome({ ...outcome, offerAcceptedAt: e.target.value })} /></Field>
                  </> : null}
                  {outcome.outcome === "employer_declined" ? <Field label="Reason (recorded with your name)" htmlFor="oc-reason"><input id="oc-reason" className="input" value={outcome.reason} onChange={(e) => setOutcome({ ...outcome, reason: e.target.value })} /></Field> : null}
                  <Field label="Note (kept internally, optional)" htmlFor="oc-note"><input id="oc-note" className="input" value={outcome.note} onChange={(e) => setOutcome({ ...outcome, note: e.target.value })} /></Field>
                  {outcome.confirming ? (
                    <Alert tone="caution"><div className="row" style={{ justifyContent: "space-between" }}><span>Record this outcome under your name? It is audited and can only be corrected by an administrator.</span><span className="row"><Button size="sm" variant="primary" loading={recordOutcome.isPending} onClick={() => recordOutcome.mutate()}>Yes, record it</Button><Button size="sm" variant="quiet" onClick={() => setOutcome({ ...outcome, confirming: false })}>No</Button></span></div></Alert>
                  ) : <div className="row"><Button size="sm" variant="primary" disabled={(outcome.outcome === "hired_externally" && !outcome.hireDate) || (outcome.outcome === "employer_declined" && !outcome.reason.trim())} onClick={() => setOutcome({ ...outcome, confirming: true })}>Continue</Button><Button size="sm" variant="quiet" onClick={() => setOutcomeOpen(false)}>Cancel</Button></div>}
                </div>
              )}
            </Card>
          ) : null}
          {a.stage === "ineligible" ? (
            <Card needsYou title="Held on an eligibility answer">
              <p className="small" style={{ color: "var(--ink-2)" }}>{a.eligibility?.failedRules.map((f) => `${f.question} → ${f.reason}`).join("; ")}</p>
              <p className="small muted" style={{ marginTop: 6 }}>Held for your decision. Nothing is sent to them unless you decline; override if the answer was a mistake. You are reminded daily, and an ITS recruiter is brought in after three days. Say why if you keep them in; it is recorded and the system learns from it.</p>
              <Field label="Why keep them in?" htmlFor="ovnote"><input id="ovnote" className="input" value={overrideNote} onChange={(e) => setOverrideNote(e.target.value)} placeholder="e.g. Sitting the licensing exam next week" /></Field>
              <div className="row" style={{ marginTop: 10 }}><Button variant="primary" size="sm" disabled={!overrideNote.trim()} loading={act.isPending} onClick={() => act.mutate({ action: "override_eligibility", note: overrideNote })}>Keep them in</Button><Button size="sm" variant="destructive" onClick={() => act.mutate({ action: "reject", reason: "eligibility", note: "Confirmed by owner" })}>Decline now</Button></div>
            </Card>
          ) : null}
          {a.stage === "rejected" && a.rejectReason === "eligibility" ? (
            <Card title="Declined on an eligibility answer">
              <p className="small" style={{ color: "var(--ink-2)" }}>{a.eligibility?.failedRules.map((f) => `${f.question} → ${f.reason}`).join("; ") || "An eligibility rule you authored was not met."} <span className="muted">Policy: send a courteous message after the review window.</span></p>
              <div className="row" style={{ marginTop: 10 }}><Button size="sm" variant="primary" loading={act.isPending} onClick={() => act.mutate({ action: "review_anyway", note: "Reopened by the owner" })}>Review anyway</Button></div>
            </Card>
          ) : null}

          <Card title="Contact and consent">
            <dl className="kv">
              <dt>Email</dt><dd>{a.candidate.email ?? "none"}</dd>
              <dt>Phone</dt><dd>{a.candidate.phone ?? "none"}</dd>
              <dt>Location</dt><dd>{a.candidate.locationText ?? "not given"}</dd>
              <dt>Text messages</dt><dd>{a.candidate.consent.sms?.granted ? `Consented (${a.candidate.consent.sms.source})` : "No consent; email only"}</dd>
              <dt>AI notice</dt><dd>{a.candidate.consent.ai_notice ? `Shown ${new Date(a.candidate.consent.ai_notice.at).toLocaleDateString()}` : "not recorded"}</dd>
            </dl>
          </Card>

          {latestScreen ? <ScreenCard screen={latestScreen} /> : null}
          {a.assessments.map((as) => <AssessmentCard key={as.id} applicationId={a.id} assessmentId={as.id} kind={as.kind} overall={as.overall} confidence={as.confidence} result={as.result} createdAt={as.createdAt} labels={a.packetLabels} />)}

          <Card title="What the resume says">
            {a.extraction ? (
              <div className="stack" style={{ gap: 8 }}>
                {a.extraction.positions.map((p, i) => <div key={i} className="small"><strong>{p.title}</strong>{p.employer ? ` at ${p.employer}` : ""}{p.startDate ? ` · ${p.startDate}–${p.endDate ?? "present"}` : ""}{p.quote ? <><br /><span className="muted">"{p.quote}"</span> <EvidenceChip source="resume" /></> : null}</div>)}
                {a.extraction.licenses.length ? <div className="row">{a.extraction.licenses.map((l, i) => <Chip key={i} tone="good">{l.name}{l.jurisdiction ? ` (${l.jurisdiction})` : ""}</Chip>)}</div> : null}
                {a.extraction.skills.length ? <p className="small muted">Skills mentioned: {a.extraction.skills.join(", ")}</p> : null}
                {a.extraction.anomalies.length ? <Alert tone="caution">{a.extraction.anomalies.map((an) => `${an.kind.replace(/_/g, " ")}: ${an.detail}`).join("; ")} — flagged for a human look, never used to decline.</Alert> : null}
              </div>
            ) : a.answers.noResume?.summary ? <p className="small" style={{ whiteSpace: "pre-wrap" }}>{a.answers.noResume.summary}</p> : <p className="muted small">No resume text available{a.documents.some((d) => d.status === "clean") ? " (the file could not be read; open it below)" : ""}.</p>}
            {a.documents.length ? (
              <ul className="small" style={{ margin: "10px 0 0", paddingLeft: 18 }}>
                {a.documents.map((d) => (
                  <li key={d.id}>
                    {d.status === "clean" ? (
                      <><a href={`/api/v1/applications/${a.id}/documents/${d.id}/file`} target="_blank" rel="noopener noreferrer">Open {d.filename}</a> <span className="muted">({Math.max(1, Math.round(d.sizeBytes / 1024))} KB; this open is recorded)</span></>
                    ) : d.status === "quarantined" ? (
                      <span className="muted">{d.filename}: being checked and scanned before anyone can open it.</span>
                    ) : d.status === "rejected" ? (
                      <span className="muted">{d.filename}: refused ({(d.rejectedReason ?? "unknown").replace(/_/g, " ")}) and removed. The candidate can send another.</span>
                    ) : (
                      <span className="muted">{d.filename}: removed.</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          <Card title="Eligibility answers">
            {a.eligibility ? (
              <div className="small">
                <p>{a.eligibility.passed ? "Met every required answer." : "Did not meet a required answer."}</p>
                {a.eligibility.failedRules.map((f) => <p key={f.key} style={{ color: "var(--needs-you)" }}>{f.question}: {f.reason}</p>)}
                {a.eligibility.unverifiable.map((u) => <p key={u.key} className="muted">{u.question}: not answered</p>)}
              </div>
            ) : <p className="muted small">Not evaluated yet.</p>}
          </Card>

          <Card title="Messages">
            {a.communications.length ? a.communications.map((m) => <div key={m.id} className="small" style={{ borderTop: "1px solid var(--line)", padding: "8px 0" }}><strong>{m.direction === "outbound" ? "We sent" : "They wrote"}: {m.subject ?? (m.direction === "inbound" ? `"${m.bodyText.slice(0, 90)}${m.bodyText.length > 90 ? "…" : ""}"` : m.templateKey)}</strong> <Chip tone={m.status === "sent" || m.status === "received" ? "good" : m.status === "failed" ? "critical" : "neutral"}>{m.channel}{m.status === "failed" ? " · failed" : ""}</Chip><br /><span className="muted">{new Date(m.createdAt).toLocaleString()}</span></div>) : <p className="muted small">No messages yet.</p>}
          </Card>

          <Card title="What happened">
            <Timeline items={a.timeline.slice().reverse().map((e) => ({ when: e.occurredAt, what: describeEvent(e.type, e.payload), who: e.actor.name ?? (e.actor.kind === "agent" ? `AI (${e.actor.id})` : e.actor.kind) }))} />
          </Card>
        </div>
      )}
    </Sheet>
  );
}

/**
 * The decision after an interview is a person's (docs/06; release 1 records it, scorecards and debriefs come later).
 * Shown when the last interview is over and nobody has decided yet: next round, finalist, or not moving forward with a reason.
 * "Next round" hands the round key to the sheet, which opens the interview approval with that round and its interviewers.
 */
function DecisionCard({ a, roleId, onDone, onNextRound }: { a: ApplicationDetail; roleId: string; onDone: () => Promise<void>; onNextRound: (roundKey: string) => void }) {
  const [decision, setDecision] = useState<"finalist" | "not_moving_forward" | null>(null);
  const [reason, setReason] = useState("not_a_match_experience");
  const [note, setNote] = useState("");
  const record = useMutation({
    mutationFn: (body: { decision: "next_round" | "finalist" | "not_moving_forward"; reason?: string; note?: string }) => api.post<{ stage: string; nextRoundKey: string | null; dispositionSent?: boolean }>(`/api/v1/applications/${a.id}/decision`, body),
    onSuccess: async (r, body) => {
      if (body.decision === "finalist") toast("Marked as a finalist.");
      else if (body.decision === "next_round") toast(r.nextRoundKey ? "Next round. Check the interviewers below and approve; times go out from there." : "Next round recorded.");
      else toast(r.dispositionSent ? "Recorded. The candidate gets a respectful message." : "Recorded. No message has gone to the candidate yet; it is waiting on a review or a retry.");
      setDecision(null);
      setNote("");
      if (body.decision === "next_round" && r.nextRoundKey) onNextRound(r.nextRoundKey);
      await onDone();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record the decision."),
  });
  const last = a.interviews.find((i) => ["completed", "no_show"].includes(i.status) && !i.decision);
  const idx = last ? a.interviewPlan.findIndex((r) => r.key === last.roundKey) : -1;
  const hasNextRound = idx >= 0 && idx + 1 < a.interviewPlan.length;
  return (
    <Card needsYou lift title="How did the interview go?">
      <p className="small" style={{ color: "var(--ink-2)" }}>{last ? `${last.title}${last.outcome === "no_show_candidate" ? " (the candidate did not attend)" : last.outcome === "no_show_interviewer" ? " (the interviewer did not attend)" : ""}. ` : ""}The decision is yours and is recorded with your name; nothing here is scored by software.</p>
      {!decision ? (
        <div className="row" style={{ marginTop: 10 }}>
          {hasNextRound ? <Button size="sm" variant="primary" loading={record.isPending} onClick={() => record.mutate({ decision: "next_round" })}>Next round</Button> : null}
          <Button size="sm" variant={hasNextRound ? undefined : "primary"} onClick={() => setDecision("finalist")}>Finalist</Button>
          <Button size="sm" variant="destructive" onClick={() => setDecision("not_moving_forward")}>Not moving forward</Button>
          <AskRecruiter roleId={roleId} applicationId={a.id} size="sm" />
        </div>
      ) : (
        <div className="stack" style={{ marginTop: 12 }}>
          {decision === "not_moving_forward" ? (
            <>
              <Alert tone="caution">Declining after an interview is your decision and is recorded with your reason. The candidate gets a respectful message.</Alert>
              <Field label="Reason" htmlFor="decision-reason"><select id="decision-reason" className="select" value={reason} onChange={(e) => setReason(e.target.value)}>{REJECT_REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            </>
          ) : null}
          <Field label={decision === "finalist" ? "What stood out (kept internally)" : "Note (kept internally)"} htmlFor="decision-note"><input id="decision-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="row">
            <Button variant={decision === "finalist" ? "primary" : "destructive"} loading={record.isPending} onClick={() => record.mutate({ decision, reason: decision === "not_moving_forward" ? reason : undefined, note: note.trim() || undefined })}>{decision === "finalist" ? "Confirm finalist" : "Confirm decline"}</Button>
            <Button variant="quiet" onClick={() => setDecision(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** Owner Mode never shows raw stage names (docs/07); mirrors STAGE_LABEL in packages/core. */
const STAGE_LABEL: Record<string, string> = { applied: "Just applied", received: "Received", ineligible: "Doesn't meet eligibility", eligible: "Eligible", triaged: "Ready for your review", screen_invited: "Invited to a screen", screening: "Being screened", screen_complete: "Screen complete", interview_recommended: "Recommended for interview", interview_scheduled: "Interviewing", interview_complete: "Interview done: decision needed", debrief: "Deciding", finalist: "Finalist", reference_check: "Checking references", offer_draft: "Offer being prepared", offer_approval: "Offer needs your approval", offer_sent: "Offer out", negotiation: "Negotiating", accepted: "Accepted", declined: "Declined the offer", hired: "Hired", onboarding: "Starting soon", withdrawn: "Withdrew", rejected: "Not moving forward", talent_pool: "In your talent pool" };

const SCREEN_STATUS: Record<string, string> = { invited: "Invited", reminded: "Reminded", in_progress: "Answering", completed: "Completed", expired: "No response", abandoned: "Withdrawn", human_requested: "Asked for a person" };

function ScreenCard({ screen }: { screen: Screen }) {
  const answered = Object.keys(screen.answers).length;
  const asked = screen.progress.askedKeys.length;
  return (
    <Card title="Screening conversation" aside={<div className="row"><Chip>{screen.channel === "sms" ? "text + web" : "web chat"}</Chip><Chip tone={screen.status === "completed" ? "good" : screen.status === "human_requested" ? "needs" : screen.status === "expired" ? "caution" : "accent"}>{SCREEN_STATUS[screen.status] ?? screen.status}</Chip></div>}>
      <p className="small muted">{screen.invitedAt ? `Invited ${new Date(screen.invitedAt).toLocaleDateString()}` : ""}{screen.remindedAt ? ` · reminded ${new Date(screen.remindedAt).toLocaleDateString()}` : ""}{screen.completedAt ? ` · completed ${new Date(screen.completedAt).toLocaleDateString()}` : ""} · {answered} answered{asked > answered ? `, ${asked - answered} asked` : ""}</p>
      {screen.transcript.length ? (
        <details style={{ marginTop: 8 }}>
          <summary className="small">Read the conversation ({screen.transcript.length} messages)</summary>
          <div className="stack" style={{ gap: 6, marginTop: 8 }}>
            {screen.transcript.map((t, i) => <div key={i} className={`bubble ${t.role === "candidate" ? "user" : t.role === "assistant" ? "assistant" : "system"}`} style={{ whiteSpace: "pre-wrap" }}>{t.content}</div>)}
          </div>
        </details>
      ) : <p className="small muted" style={{ marginTop: 6 }}>They have not opened it yet.</p>}
    </Card>
  );
}

const REC_LABEL: Record<string, string> = { screen: "Worth a screen", hold: "Hold", review_manually: "Needs a human look", strong_interview: "Strong: interview", interview: "Interview", decline_recommended: "Concern raised" };
const MET_TONE: Record<string, "good" | "accent" | "neutral" | "caution"> = { yes: "good", partially: "accent", no: "caution", unknown: "neutral", evidenced: "good", partially_evidenced: "accent", not_evidenced: "neutral", contradicted: "caution" };

type PacketLabels = ApplicationDetail["packetLabels"];

const FLAG_KINDS: Array<[string, string]> = [
  ["wrong_evidence", "Cited the wrong evidence"],
  ["hallucination", "Made something up"],
  ["policy_error", "Broke a rule we set"],
  ["bias_concern", "Bias concern"],
  ["poor_communication", "Poorly worded"],
  ["wrong_workflow_action", "Took the wrong next step"],
  ["false_negative", "Missed a good candidate"],
  ["false_positive", "Overrated this candidate"],
  ["missing_context", "Missed context we gave"],
];

/** One-click flag with the founder context's taxonomy (§23). It records; it never retrains anything on its own. */
function FlagAssessment({ applicationId, assessmentId }: { applicationId: string; assessmentId: string }) {
  const [kind, setKind] = useState("");
  const [done, setDone] = useState(false);
  const flag = useMutation({
    mutationFn: (k: string) => api.post(`/api/v1/applications/${applicationId}/assessments/${assessmentId}/flag`, { kind: k }),
    onSuccess: () => { setDone(true); toast("Flagged. A person reviews these and they improve the system."); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not flag this."),
  });
  if (done) return <span className="small muted">Flagged, thank you.</span>;
  return (
    <span className="row" style={{ gap: 6 }}>
      <select className="select" style={{ width: "auto", padding: "4px 8px", fontSize: 12.5 }} value={kind} onChange={(e) => { setKind(e.target.value); if (e.target.value) flag.mutate(e.target.value); }} aria-label="Something wrong with this assessment?">
        <option value="">Something wrong?</option>
        {FLAG_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </span>
  );
}

function AssessmentCard({ applicationId, assessmentId, kind, overall, confidence, result, createdAt, labels }: { applicationId: string; assessmentId: string; kind: string; overall: string; confidence: string; result: AssessmentResult; createdAt: string; labels: PacketLabels }) {
  const mustHave = (key: string) => labels.mustHaves.find((m) => m.key === key)?.text ?? key.replace(/^mh_\d+_/, "").replace(/_/g, " ");
  const competency = (key: string) => labels.competencies.find((c) => c.key === key)?.name ?? key.replace(/_/g, " ");
  const question = (key: string) => labels.questions.find((q) => q.key === key)?.question ?? key.replace(/_/g, " ");
  return (
    <Card title={kind === "screen" ? "Screen scorecard" : "Resume assessment"} className="assessment" aside={<span className="row"><span className="small muted">{new Date(createdAt).toLocaleDateString()}</span><FlagAssessment applicationId={applicationId} assessmentId={assessmentId} /></span>}>
      <div className="row"><Chip tone={overall === "strong" ? "good" : overall === "weak" ? "caution" : "accent"}>{overallLabel(overall)}</Chip><Chip tone={result.recommendation === "decline_recommended" ? "caution" : "neutral"}>{REC_LABEL[result.recommendation] ?? result.recommendation}</Chip><Chip>{confidence} confidence</Chip></div>
      <p style={{ marginTop: 8 }}>{result.summary}</p>
      {kind === "screen" && (result.compensationExpectation?.stated || result.availability?.stated) ? (
        <dl className="kv" style={{ marginTop: 8 }}>
          {result.compensationExpectation?.stated ? <><dt>Pay expectation</dt><dd>{result.compensationExpectation.stated} <Chip tone={result.compensationExpectation.withinRange === "yes" ? "good" : result.compensationExpectation.withinRange === "above" ? "caution" : "neutral"}>{result.compensationExpectation.withinRange === "yes" ? "within range" : result.compensationExpectation.withinRange}</Chip></dd></> : null}
          {result.availability?.stated ? <><dt>Availability</dt><dd>{result.availability.stated} <Chip tone={MET_TONE[result.availability.matchesSchedule] ?? "neutral"}>{result.availability.matchesSchedule.replace("_", " ")}</Chip></dd></> : null}
        </dl>
      ) : null}
      {result.requirementFindings?.length ? <div className="block"><h3>Must-haves</h3><ul>{result.requirementFindings.map((r, j) => <li key={j}>{mustHave(r.requirementKey)} <Chip tone={MET_TONE[r.met] ?? "neutral"}>{r.met}</Chip>{r.evidence?.quote ? <span className="small muted"> "{r.evidence.quote}"</span> : null}</li>)}</ul></div> : null}
      {result.questionFindings?.length ? <div className="block"><h3>Answers</h3><ul>{result.questionFindings.map((f, j) => <li key={j}><span className="muted small">{question(f.questionKey)}</span><br />{f.finding} {f.answered ? <Chip tone={MET_TONE[f.meetsModelAnswer] ?? "neutral"}>{f.meetsModelAnswer === "unknown" ? "recorded" : f.meetsModelAnswer}</Chip> : null}</li>)}</ul></div> : null}
      {result.competencyFindings?.length ? <div className="block"><h3>Competencies</h3><div className="row">{result.competencyFindings.map((c, j) => <Chip key={j} tone={MET_TONE[c.finding] ?? "neutral"}>{competency(c.competencyKey)}: {c.finding.replace(/_/g, " ")}</Chip>)}</div></div> : null}
      <div className="block"><h3>Strengths</h3>{result.strengths.length ? <ul>{result.strengths.map((s, j) => <li key={j}>{s.claim} <EvidenceChip source={s.evidence.source} />{s.evidence.quote ? <span className="small muted"> "{s.evidence.quote}"</span> : null}</li>)}</ul> : <p className="muted small">None recorded.</p>}</div>
      <div className="block"><h3>Concerns</h3>{result.concerns.length ? <ul>{result.concerns.map((s, j) => <li key={j}>{s.claim} <EvidenceChip source={s.evidence.source} />{s.evidence.quote ? <span className="small muted"> "{s.evidence.quote}"</span> : null}</li>)}</ul> : <p className="muted small">None recorded.</p>}</div>
      <div className="block"><h3>Unknown</h3>{result.unknowns.length ? <ul>{result.unknowns.map((u, j) => <li key={j}>{u.question} <span className="muted small">— {u.whyItMatters}</span></li>)}</ul> : <p className="muted small">Nothing outstanding.</p>}</div>
      {result.anomalies?.length ? <p className="small muted" style={{ marginTop: 8 }}>Flags (never used to decline): {result.anomalies.map((an) => `${an.kind.replace(/_/g, " ")}: ${an.detail}`).join("; ")}</p> : null}
      <p className="small muted" style={{ marginTop: 8 }}>{result.rationale}</p>
    </Card>
  );
}

function describeEvent(type: string, payload: Record<string, unknown>): string {
  const p = payload as Record<string, string | undefined>;
  return ({
    "application.triaged": `Assessed: ${REC_LABEL[p.recommendation ?? ""] ?? p.recommendation ?? "done"}`,
    "assessment.created": p.kind === "screen" ? "Screen scorecard written" : "Resume assessment written",
    "screen.invited": `Invited to a screen (${p.channel})`,
    "screen.started": "Started the screening conversation",
    "screen.completed": "Completed the screen",
    "screen.assessed": "Screen scorecard ready",
    "screen.expired": "Did not respond to the screen",
    "screen.human_requested": "Asked for a person during the screen",
    "screen.abandoned": "Left the screen",
    "candidate.recommended": p.by === "human" ? "Marked for interview by you" : "Recommended for interview",
    "application.withdrawn": "Withdrew",
    "message.received": "Wrote to us",
    "message.sent": "Message sent",
    "application.received": "Application received",
    "application.acknowledged": "Confirmation sent to the candidate",
    "resume.ingested": "Resume read",
    "resume.extraction_failed": "Resume could not be read",
    "eligibility.evaluated": `Eligibility checked (${(payload.passed as boolean) ? "met" : "not met"})`,
    "application.ineligible": "Held on an eligibility answer",
    "application.stage_changed": `Now "${STAGE_LABEL[p.to ?? ""] ?? p.to}"${p.reason ? ` (${p.reason})` : ""}`,
    "application.rejected": `Declined${p.reason ? `: ${p.reason.replace(/_/g, " ")}` : ""}${payload.afterInterview ? " (after the interview)" : ""}`,
    "interview.decision_recorded": `Decision after the interview: ${(p.decision ?? "").replace(/_/g, " ")}${p.note ? ` — ${p.note}` : ""}`,
    "application.duplicate_detected": "Applied again (kept the original)",
    "human.override": `Human decision: ${p.action}${p.note ? ` — ${p.note}` : ""}`,
    "recruiter.requested": "Sent to a recruiter",
    "recruiter.claimed": "An ITS recruiter picked this up",
    "recruiter.resolved": `ITS recruiter responded${p.resolution ? `: ${p.resolution}` : ""}`,
    "recruiter.access_granted": `ITS recruiter ${p.recruiter ?? ""} given access (${p.purpose ?? ""}) until ${p.expiresAt ? new Date(p.expiresAt).toLocaleDateString() : ""}`,
    "recruiter.access_ended": "ITS recruiter access ended",
    "application.moved_to_talent_pool": "Added to the talent pool",
  } as Record<string, string>)[type] ?? type.replace(/[._]/g, " ");
}

type OutcomeRecord = { id: string; outcome: string; hireDate: string | null; offerAcceptedAt: string | null; recordedBy: { name?: string; id: string }; recordedAt: string; correctedAt: string | null; correctionReason: string | null; correctionOf: string | null };

/** What was recorded, by whom, with the sentence that keeps it honest about where the offer happened. */
function RecordedOutcome({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["outcomes", id], queryFn: () => api.get<{ statement: string; outcomes: OutcomeRecord[] }>(`/api/v1/applications/${id}/outcomes`) });
  const latest = q.data?.outcomes.find((o) => !o.correctedAt);
  if (!latest) return null;
  return (
    <Card title="Recorded outcome">
      <p><strong>{latest.outcome.replace(/_/g, " ")}</strong>{latest.hireDate ? ` · hire date ${latest.hireDate}` : ""}{latest.offerAcceptedAt ? ` · offer accepted ${latest.offerAcceptedAt}` : ""}</p>
      <p className="small muted">Recorded by {latest.recordedBy.name ?? "a team member"} on {new Date(latest.recordedAt).toLocaleDateString()}{latest.correctionOf ? " (a correction by an ITS administrator)" : ""}.</p>
      <p className="small muted" style={{ marginTop: 6 }}>{q.data!.statement}</p>
    </Card>
  );
}
