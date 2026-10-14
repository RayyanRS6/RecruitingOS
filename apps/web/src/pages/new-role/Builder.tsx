"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IntakeAnswer, IntakeFactsPatch, IntakeSessionView, PacketRevisionProposal, PlanRoom, RequirementsCheck } from "@ros/contracts";
import { Alert, Button, EmptyState, ErrorState, Eyebrow, Icon, Menu, Pill, ProgressSteps, Skeleton, SplitView } from "@ros/ui";
import { api, ApiError, type IntakeApprovalResponse, type IntakeTurnReply, type IntakeTurnResponse, type Me } from "../../api/client";
import { Link, useNavigate } from "../../nav";
import { dockFocusDue, focusLost } from "../../focus-after";
import { scrollBehavior } from "../../motion";
import { closingDateRequiredFor, readDraftClosingDate, writeDraftClosingDate } from "../../publishing";
import { activeCompanyOf } from "../../rail";
import { canManageRole } from "../../roles";
import { browserStorage, QUICK_START_HREF } from "../../start-hire";
import { toast } from "../../toast";
import { AskRecruiter } from "../../components/AskRecruiter";
import { presetOf } from "../../recruiter-access";
import { CandidatePreview } from "./CandidatePreview";
import { Composer } from "./Composer";
import { Conversation, type LocalLine } from "./Conversation";
import { DraftPanel } from "./DraftPanel";
import type { TeamPick } from "./FactsEditor";
import { ProposalCard } from "./ProposalCard";
import { QuestionCard } from "./QuestionCard";
import { quickStartDraftKey } from "./quick-start";
import { RoomAlert } from "./StartView";
import {
  NEW_ROLE_FRESH_HREF, TAKEN_OVER_TOAST, answersPayload, approvalHelp, askFromDetails, cardsKey, cardsToShow, changedSections, composerPlaceholder, draftRecruiterAsk, draftSections,
  draftSteps, draftTitle, draftingNow, echoText, errorWords, initialCards, mayTakeOverDrafts, turnProblem,
  type CardState, type DraftSection, type RecruiterAction, type SectionId, type payPayload,
} from "./rules";
import { CHANGE_REQUEST_MAX, asksBack, checkSignature, proposalSections, refinePaths } from "./refine-api";

type Problem = { message: string; ask: RecruiterAction | null };
type Member = { userId: string; role: string; status: string; email: string; name: string | null };
type Pay = NonNullable<ReturnType<typeof payPayload>>;
type SessionData = { session: IntakeSessionView };

/**
 * The job builder with a draft under way (plan C4 to C15): the conversation on the left, the draft taking shape on the
 * right (one or the other on a phone, with a switch). The assistant asks with tap-to-answer cards docked where the
 * message box is; the picks go back as one summary message. "Write the draft" puts the job together, with each real
 * step shown as it happens; after that, typed words ask for a change, which is shown and saved only on Confirm. "Ask for
 * approval" stays greyed, listing what is missing, until the server says the essentials are in. Whenever the assistant
 * fails, "Bring in a recruiter" hands the draft and the conversation to ITS.
 */
export function Builder({ sessionId, companyName }: { sessionId: string; companyName: string | null }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const key = useMemo(() => ["intake", "session", sessionId], [sessionId]);
  const base = `/api/v1/intake/sessions/${encodeURIComponent(sessionId)}`;
  const paths = refinePaths({ kind: "draft", sessionId });
  // While a draft is being written the page asks every second how far it has got (the server records each step).
  const [polling, setPolling] = useState(false);
  const session = useQuery({
    queryKey: key,
    queryFn: () => api.get<SessionData>(base),
    refetchInterval: (q) => (polling || draftingNow(q.state.data?.session.progress ?? null) ? 1000 : false),
  });
  const members = useQuery({ queryKey: ["members"], queryFn: () => api.get<Member[]>("/api/v1/companies/current/members") });
  const team: TeamPick[] = (members.data ?? []).filter((m) => m.status === "active").map((m) => ({ userId: m.userId, name: m.name ?? m.email, role: m.role }));
  const view = session.data?.session ?? null;

  const [problem, setProblem] = useState<Problem | null>(() => {
    const p = turnProblem(qc.getQueryData<IntakeTurnReply>(["intake", "first-reply", sessionId]) ?? null);
    return p ? { message: p.message, ask: p.ask ?? draftRecruiterAsk(sessionId) } : null;
  });
  const [pending, setPending] = useState<LocalLine | null>(null);
  const [thinking, setThinking] = useState<string | null>(null);
  const [local, setLocal] = useState<LocalLine[]>([]);
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement | null>(null);
  /** Set when the cards' answers are sent: the cards they were sent from, so the next dock can take the focus. */
  const handOff = useRef<{ from: string } | null>(null);
  const [deck, setDeck] = useState<{ key: string; state: CardState; closed: boolean }>({ key: "", state: initialCards(), closed: false });
  const [pane, setPane] = useState<"primary" | "secondary">("primary");
  const [proposal, setProposal] = useState<PacketRevisionProposal | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [blockers, setBlockers] = useState<string[] | null>(null);
  const [room, setRoom] = useState<{ room: PlanRoom | null; ask: RecruiterAction | null } | null>(null);
  const [patchDone, setPatchDone] = useState(0);
  // The closing date (plan D7) belongs to the role, which does not exist yet: kept on this draft in this browser and set
  // on the role the moment "Ask for approval" creates it.
  const [closesOn, setClosesOnState] = useState("");
  useEffect(() => { setClosesOnState(readDraftClosingDate(browserStorage(), sessionId)); }, [sessionId]);
  const setClosesOn = (value: string) => { setClosesOnState(value); writeDraftClosingDate(browserStorage(), sessionId, value); };

  // A section that changed lights up for a moment (plan: "a brief highlight as they change").
  const [changed, setChanged] = useState<SectionId[]>([]);
  const seen = useRef<DraftSection[] | null>(null);
  const sections = useMemo(() => (view ? draftSections(view) : null), [view]);
  useEffect(() => {
    if (!sections) return;
    const ids = changedSections(seen.current, sections);
    seen.current = sections;
    if (ids.length) setChanged(ids);
  }, [sections]);
  useEffect(() => {
    if (!changed.length) return;
    const t = window.setTimeout(() => setChanged([]), 2400);
    return () => window.clearTimeout(t);
  }, [changed]);

  const apply = (s: IntakeSessionView) => qc.setQueryData<SessionData>(key, { session: s });
  // Whatever fails, a person can take over: "Bring in a recruiter" hands them this draft and its conversation (C12).
  const recruiter = draftRecruiterAsk(sessionId);
  const afterTurn = (r: IntakeTurnResponse) => {
    apply(r.session);
    const p = turnProblem(r.reply);
    setProblem(p ? { message: p.message, ask: p.ask ?? recruiter } : null);
    qc.invalidateQueries({ queryKey: ["intake", "mine"] });
  };
  const failed = (err: unknown) => setProblem({ message: errorWords(err), ask: (err instanceof ApiError ? askFromDetails(err.details) : null) ?? recruiter });

  const send = useMutation({
    mutationFn: (message: string) => api.post<IntakeTurnResponse>(`${base}/messages`, { message }),
    onMutate: (message) => { setPending({ key: "pending", role: "owner", content: message }); setThinking("Thinking…"); setProblem(null); setText(""); },
    onSuccess: afterTurn,
    onError: (err, message) => { setText(message); failed(err); },
    onSettled: () => { setPending(null); setThinking(null); },
  });
  const answer = useMutation({
    mutationFn: (input: { answers: IntakeAnswer[]; echo: string }) => api.post<IntakeTurnResponse>(`${base}/answers`, { answers: input.answers }),
    onMutate: (input) => { setPending({ key: "pending", role: "owner", content: input.echo, kind: "answers" }); setThinking("Thinking about your answers…"); setProblem(null); },
    onSuccess: (r) => {
      afterTurn(r);
      if (r.refused?.length) toast("Some words were not used.", "The reason is in the conversation.");
    },
    onError: (err) => {
      failed(err);
      // A card answered after newer ones arrived: show the newer ones.
      if (err instanceof ApiError && err.code === "unknown_question") qc.invalidateQueries({ queryKey: key });
    },
    onSettled: () => { setPending(null); setThinking(null); },
  });
  const patch = useMutation({
    mutationFn: (p: IntakeFactsPatch) => api.post<IntakeTurnResponse>(`${base}/answers`, { patch: p, reply: false }),
    onSuccess: (r) => {
      apply(r.session);
      setPatchDone((n) => n + 1);
      if (r.refused?.length) toast("Saved, except what could not be used.", r.refused.map((x) => `"${x.text}": ${x.reason}`).join(" "));
      else toast("Saved.", "Noted in the conversation; the assistant was not asked anything.");
    },
  });
  const pay = useMutation({
    // Set on the draft's pay card: the open pay question is answered with it, or the pay is set as an edit.
    mutationFn: (p: Pay) => {
      const card = view?.questions.find((q) => q.mode === "pay");
      return api.post<IntakeTurnResponse>(`${base}/answers`, card ? { answers: [{ questionId: card.id, pay: p }], reply: false } : { patch: { set: { pay: p } }, reply: false });
    },
    onSuccess: (r) => { apply(r.session); toast("Pay set.", "Recorded as set by you."); },
  });
  const draft = useMutation({
    mutationFn: () => api.post<SessionData>(`${base}/draft`),
    onMutate: () => { setPolling(true); setProblem(null); },
    onSuccess: (r) => { apply(r.session); toast("The draft is written.", "Check it beside the conversation. Nothing is sent to anyone."); },
    onError: failed,
    onSettled: () => { setPolling(false); qc.invalidateQueries({ queryKey: key }); },
  });
  // A draft the quick start just made (Wave S2, K2): the answers are all on it, so the job post is written as soon as the
  // builder opens, once, with the usual steps shown. A reload never writes it again (the mark lives in this page only).
  const autoDraft = useRef(false);
  useEffect(() => {
    if (autoDraft.current || !view) return;
    const mark = quickStartDraftKey(sessionId);
    if (!qc.getQueryData(mark)) return;
    autoDraft.current = true;
    qc.removeQueries({ queryKey: mark, exact: true });
    if (view.status === "active" && view.readiness.mayDraft && !view.readiness.hasDraft && !draftingNow(view.progress)) draft.mutate();
  }, [view, qc, sessionId, draft]);
  const approve = useMutation({
    mutationFn: () => api.post<IntakeApprovalResponse>(`${base}/request-approval`),
    onMutate: () => { setPolling(true); setBlockers(null); setProblem(null); setRoom(null); },
    onSuccess: async (r) => {
      // The chosen closing date goes on the new role; if that fails the role is still waiting for approval, and the
      // Share tab can set the date.
      let dateProblem: string | null = null;
      if (closesOn && mayManage) {
        try {
          await api.post(`/api/v1/roles/${r.roleId}/closing-date`, { closesOn });
          writeDraftClosingDate(browserStorage(), sessionId, "");
        } catch (e) {
          dateProblem = e instanceof ApiError ? e.message : "The closing date could not be set.";
        }
      }
      toast("Sent for approval.", dateProblem ? `The job is created, but the closing date was not set: ${dateProblem} Set it on the job's Share tab.` : "The job is created. Nothing is posted until it is approved.");
      for (const k of [["roles"], ["brief"], ["intake", "mine"]]) qc.invalidateQueries({ queryKey: k });
      nav(`/roles/${r.roleId}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "not_ready") {
        setBlockers((err.details as { blockers?: string[] } | undefined)?.blockers ?? [err.message]);
        qc.invalidateQueries({ queryKey: key });
        return;
      }
      if (err instanceof ApiError && err.code === "limit_reached") {
        const d = err.details as { room?: PlanRoom; actions?: Array<{ label: string; body?: Record<string, unknown> }> } | undefined;
        const a = d?.actions?.[0];
        setRoom({ room: d?.room ?? null, ask: a ? { label: a.label, body: a.body ?? {} } : null });
        return;
      }
      failed(err);
    },
    onSettled: () => setPolling(false),
  });
  const keep = useMutation({
    mutationFn: (input: { flagId: string; reason: string }) => api.post<SessionData>(`${base}/flags/keep`, input),
    onSuccess: (r) => { apply(r.session); toast("Kept, with your reason.", "Whoever approves the role sees why."); },
    onError: (err) => toast(errorWords(err)),
  });
  const abandon = useMutation({
    mutationFn: () => api.post(`${base}/abandon`),
    onSuccess: () => {
      toast("Draft discarded.", "Nothing was sent to anyone.");
      for (const k of [["intake", "mine"], ["brief"]]) qc.invalidateQueries({ queryKey: k });
      nav("/");
    },
    onError: (err) => toast(errorWords(err)),
  });
  const takeOver = useMutation({
    mutationFn: () => api.post<SessionData>(`${base}/take-over`),
    onSuccess: (r) => { apply(r.session); toast(TAKEN_OVER_TOAST.title, TAKEN_OVER_TOAST.body); qc.invalidateQueries({ queryKey: ["intake"] }); },
    onError: (err) => toast(errorWords(err)),
  });
  // Only owners and admins may take a draft over (an ITS recruiter helping with it may not).
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const mayTakeOver = mayTakeOverDrafts(activeCompanyOf(me.data).role);
  // Setting the closing date needs role.manage, so the builder offers it only to those who hold it.
  const mayManage = canManageRole(activeCompanyOf(me.data).role);

  // "Change it by asking" (C10): a proposed change, shown field by field; saved only on Confirm. The request and what
  // became of it stay in the conversation for this visit; the server records both on the draft's history.
  const revise = useMutation({
    mutationFn: (message: string) => api.post<PacketRevisionProposal>(paths.revise, { message }),
    onMutate: (message) => { setPending({ key: "pending", role: "owner", content: message }); setThinking("Working out the change…"); setProblem(null); setText(""); setProposal(null); },
    onSuccess: (r, message) => {
      setLocal((l) => [...l, { key: `ask-${r.revisionId}`, role: "owner", content: message }]);
      // Asked back instead of changing anything: the question is the reply, and there is nothing to confirm.
      if (asksBack(r)) setLocal((l) => [...l, { key: `q-${r.revisionId}`, role: "assistant", content: r.question! }]);
      else setProposal(r);
    },
    onError: (err, message) => { setText(message); failed(err); },
    onSettled: () => { setPending(null); setThinking(null); },
  });
  const confirm = useMutation({
    mutationFn: (p: PacketRevisionProposal) => api.post<{ session?: IntakeSessionView | null }>(paths.apply(p.revisionId)),
    onSuccess: (r, p) => {
      if (r.session) apply(r.session);
      else qc.invalidateQueries({ queryKey: key });
      setLocal((l) => [...l, { key: `done-${p.revisionId}`, role: "system", content: `Changed: ${p.summary}` }]);
      setProposal(null);
      toast("Change saved.", "The draft has it now. Nothing was sent to anyone.");
    },
    onError: (err) => {
      failed(err);
      // Worked out on a draft that has changed since: it cannot be saved; ask again.
      if (err instanceof ApiError && ["stale_revision", "already_decided", "revision_not_found"].includes(err.code)) setProposal(null);
    },
  });
  const keepAsIs = useMutation({
    // Recorded on the server; the change is dropped here even if the server already had it set aside.
    mutationFn: (p: PacketRevisionProposal) => api.post(paths.discard(p.revisionId)).catch(() => null),
    onSettled: (_r, _e, p) => {
      setLocal((l) => [...l, { key: `kept-${p.revisionId}`, role: "system", content: "Kept as it was." }]);
      setProposal(null);
    },
  });

  // The requirements check (C16): suggestions only, read again whenever the requirements or the wording change.
  const check = useQuery({
    queryKey: ["intake", "check", sessionId, checkSignature(view?.draft)],
    queryFn: () => api.get<RequirementsCheck>(paths.check),
    enabled: !!view?.draft && view.status === "active",
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  // One tap applies a suggestion's fix to the draft the check ran on.
  const fix = useMutation({
    mutationFn: (fixId: string) => api.post<{ session: IntakeSessionView | null; applied: string[] }>(paths.applyFixes, { base: check.data?.base ?? "", fixIds: [fixId] }),
    onSuccess: (r) => {
      if (r.session) apply(r.session);
      toast("Changed.", r.applied.join(" ") || "The draft has the fix.");
    },
    onError: (err) => {
      toast(errorWords(err));
      if (err instanceof ApiError && err.code === "stale_check") check.refetch();
    },
  });

  // After the cards' answers are sent, the Send button that had the focus goes with its card. Whatever replaces it takes
  // the focus: the next card's question, or the message box when no cards are left (or the same card's question when
  // the send failed). Only after a send, never on a fresh load, and never when the person has moved focus elsewhere.
  const dockKey = view ? cardsKey(cardsToShow(view)) : "";
  useEffect(() => {
    if (!dockFocusDue(handOff.current, { dockKey, pending: answer.isPending, failed: answer.isError })) return;
    handOff.current = null;
    if (!focusLost(document.activeElement, document.body)) return;
    (document.querySelector<HTMLElement>(".chat-dock .qcard-prompt") ?? box.current)?.focus();
  }, [dockKey, answer.isPending, answer.isError]);

  if (session.isLoading) return <Skeleton lines={6} />;
  if (session.error || !view) {
    if (session.error instanceof ApiError && session.error.status === 404) return <EmptyState icon="roles" title="We could not find that draft" body="It may have been discarded. You can start a new role." action={<Link to={NEW_ROLE_FRESH_HREF} className="btn primary">Start a new role</Link>} />;
    return <ErrorState message={errorWords(session.error, "Could not load this draft.")} onRetry={() => session.refetch()} />;
  }
  if (view.status === "compiled") return <EmptyState icon="roles" title="This draft is now a role" body="It was sent for approval. Open the role to see where it stands." action={view.roleId ? <Link to={`/roles/${view.roleId}`} className="btn primary">Open the role</Link> : undefined} />;
  if (view.status !== "active") return <EmptyState icon="roles" title="This draft was set aside" body="It stays in your records, but it no longer continues. Start a new role to hire." action={<Link to={NEW_ROLE_FRESH_HREF} className="btn primary">Start a new role</Link>} />;

  const title = draftTitle(view);
  const hasDraft = view.readiness.hasDraft;
  const cards = cardsToShow(view);
  const deckKey = cardsKey(cards);
  const live = deck.key === deckKey ? deck : { key: deckKey, state: initialCards(), closed: false };
  const showCards = cards.length > 0 && !live.closed;
  const draftRunning = draft.isPending || draftingNow(view.progress) || (approve.isPending && draftingNow(view.progress));
  const busy = send.isPending || answer.isPending || revise.isPending || draft.isPending || approve.isPending;
  const lastReply = [...view.messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const announce = thinking ? "The assistant is thinking." : problem ? problem.message : proposal ? `Proposed change: ${proposal.summary}` : lastReply;
  const help = approvalHelp(view.readiness);
  // Once the draft is written, words typed in the box ask for a change to it; before that they go to the conversation.
  const asks = !!hasDraft;
  const submitText = (t: string) => (asks ? revise.mutate(t) : send.mutate(t));
  const sendCards = () => { handOff.current = { from: deckKey }; answer.mutate({ answers: answersPayload(cards, live.state), echo: echoText(cards, live.state) }); };
  const showInDraft = (ids: SectionId[]) => {
    setPane("secondary");
    window.setTimeout(() => document.getElementById(`draft-${ids[0]}-h`)?.scrollIntoView({ block: "center", behavior: scrollBehavior() }), 50);
  };

  const above = (
    <>
      {room?.room && !room.room.ok ? <RoomAlert room={room.room} ask={room.ask} /> : null}
      {blockers ? (
        <Alert tone="caution">
          <strong>Not ready to ask for approval yet.</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </Alert>
      ) : null}
      {problem ? (
        <Alert tone="caution">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>{problem.message}</span>
            {problem.ask ? <AskRecruiter label={problem.ask.label} size="sm" variant="primary" preset={presetOf(problem.ask.body)} /> : null}
          </div>
        </Alert>
      ) : null}
      {draftRunning ? (
        <div className="draft-progress">
          <ProgressSteps live label="Writing the draft" steps={draftSteps(view.progress?.stage === "done" || view.progress?.stage === "failed" ? "starting" : view.progress?.stage ?? "starting")} />
        </div>
      ) : null}
      {proposal ? (
        <ProposalCard
          proposal={proposal}
          onConfirm={() => confirm.mutate(proposal)}
          onKeep={() => keepAsIs.mutate(proposal)}
          onShow={() => showInDraft(proposalSections(proposal))}
          confirming={confirm.isPending}
          keeping={keepAsIs.isPending}
        />
      ) : null}
      {!hasDraft && view.readiness.mayDraft && !draftRunning && !busy ? (
        <div className="draft-ready">
          <span><Icon name="sparkle" size={16} /> There is enough for a first draft. Keep answering, or write it now.</span>
          <Button size="sm" variant="primary" onClick={() => draft.mutate()}>Write the draft</Button>
        </div>
      ) : null}
      {cards.length && live.closed ? (
        <Button size="sm" variant="ghost" icon="chevron-up" onClick={() => setDeck({ ...live, closed: false })}>Show the questions ({cards.length})</Button>
      ) : null}
    </>
  );

  const dock = showCards ? (
    <QuestionCard
      key={deckKey}
      questions={cards}
      state={live.state}
      onState={(state) => setDeck({ ...live, state })}
      onSend={sendCards}
      onClose={() => setDeck({ ...live, closed: true })}
      onTypeInstead={hasDraft ? undefined : () => { setDeck({ ...live, closed: true }); window.setTimeout(() => box.current?.focus(), 0); }}
      sending={answer.isPending}
      pay={view.pay}
    />
  ) : (
    <Composer
      inputRef={box}
      value={text}
      onChange={setText}
      onSend={submitText}
      sending={send.isPending || revise.isPending}
      disabled={busy && !send.isPending && !revise.isPending}
      label={asks ? "Ask for a change to the draft" : "Message to the assistant"}
      placeholder={composerPlaceholder({ started: true, hasDraft: asks })}
      hint={asks ? "A change is shown to you before it is saved." : view.readiness.draftBlocker ?? "Tap the answers, or type your own."}
      changeMax={asks ? CHANGE_REQUEST_MAX : undefined}
    />
  );

  return (
    <div className="builder">
      <header className="builder-head">
        <div className="builder-head-title">
          <Eyebrow>{companyName ? `Drafting · ${companyName}` : "Drafting"}</Eyebrow>
          <div className="row" style={{ flexWrap: "nowrap", minWidth: 0 }}>
            <h1 className={title ? undefined : "placeholder"}>{title ?? "Untitled role"}</h1>
            <Pill size="sm" tone="neutral">Draft</Pill>
          </div>
        </div>
        <div className="builder-head-actions">
          <Menu
            label="More"
            ariaLabel="More for this draft"
            align="end"
            items={[{ id: "new", label: "Start a different role", icon: "plus" }, { id: "quick", label: "New role from quick questions", icon: "arrow-right" }, { id: "preview", label: "See what candidates will see", icon: "eye", disabled: !view.draft, reason: "Once the draft is written." }, { id: "discard", label: "Discard this draft", icon: "x", danger: true }]}
            onSelect={(id) => {
              if (id === "new") nav(NEW_ROLE_FRESH_HREF);
              else if (id === "quick") nav(QUICK_START_HREF);
              else if (id === "preview") setPreviewOpen(true);
              else setConfirmDiscard(true);
            }}
          />
          <ApprovalButton help={help} loading={approve.isPending} onAsk={() => approve.mutate()} />
        </div>
      </header>

      {confirmDiscard ? (
        <Alert tone="caution">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>Discard this draft? It stays in your records but cannot be continued. Nothing has been sent to anyone.</span>
            <span className="row">
              <Button size="sm" variant="danger" loading={abandon.isPending} onClick={() => abandon.mutate()}>Discard it</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>Keep it</Button>
            </span>
          </div>
        </Alert>
      ) : null}
      {!view.startedBy.mine ? (
        <Alert tone="info">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>{view.startedBy.name ?? "Someone on your team"} started this draft. You can work on it; it stays theirs{mayTakeOver ? " unless you take it over" : ""}.</span>
            {mayTakeOver ? <Button size="sm" loading={takeOver.isPending} onClick={() => takeOver.mutate()}>Take it over</Button> : null}
          </div>
        </Alert>
      ) : null}

      <SplitView
        primaryLabel="Conversation"
        secondaryLabel="Draft"
        switchLabel="Show"
        pane={pane}
        onPaneChange={setPane}
        primary={<Conversation messages={view.messages} local={local} pending={pending} thinking={thinking} announce={announce} above={above} dock={dock} />}
        secondary={
          <DraftPanel
            view={view}
            companyName={companyName}
            team={team}
            changed={changed}
            proposal={proposal}
            check={check.data ?? null}
            onFix={(fixId) => fix.mutate(fixId)}
            fixing={fix.isPending ? fix.variables ?? null : null}
            onPatch={(p) => patch.mutate(p)}
            patching={patch.isPending}
            patchError={patch.error ? errorWords(patch.error) : null}
            patchDone={patchDone}
            onPay={(p) => pay.mutate(p)}
            paying={pay.isPending}
            payError={pay.error ? errorWords(pay.error) : null}
            onKeepFlag={(flagId, reason) => keep.mutate({ flagId, reason })}
            keepingFlag={keep.isPending ? keep.variables?.flagId ?? null : null}
            onAsk={(instruction) => { setPane("primary"); revise.mutate(instruction); }}
            onRedraft={() => draft.mutate()}
            drafting={draft.isPending}
            onPreview={() => setPreviewOpen(true)}
            closing={mayManage ? { value: closesOn, onChange: setClosesOn, required: closingDateRequiredFor({ locations: view.draft?.identity.locations, remotePolicy: view.draft?.identity.remotePolicy ?? view.facts.remotePolicy, locationText: view.facts.locationText }) } : null}
          />
        }
      />
      {view.draft ? <CandidatePreview open={previewOpen} onClose={() => setPreviewOpen(false)} path={paths.preview} /> : null}
    </div>
  );
}

/**
 * "Ask for approval": near-black, and greyed until the server says the role is ready. Pointing at it, focusing it or
 * pressing it while greyed lists what is still missing, in the server's words (a tooltip a keyboard can reach too).
 */
function ApprovalButton(props: { help: ReturnType<typeof approvalHelp>; loading: boolean; onAsk: () => void }) {
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const { help } = props;
  return (
    <span className="tip-wrap">
      <button
        type="button"
        className="btn primary"
        aria-disabled={help.ready ? undefined : true}
        aria-describedby={help.ready ? undefined : tipId}
        aria-expanded={help.ready ? undefined : open}
        disabled={props.loading}
        aria-busy={props.loading || undefined}
        onClick={() => (help.ready ? props.onAsk() : setOpen(!open))}
        onBlur={() => setOpen(false)}
      >
        {props.loading ? (
          <>
            <span className="spinner" aria-hidden="true" />
            Working…
          </>
        ) : (
          "Ask for approval"
        )}
      </button>
      {help.ready ? null : (
        <span className="tip" id={tipId} role="tooltip" data-open={open ? "true" : undefined}>
          <strong>{help.heading}</strong>
          <span className="tip-lines">{help.lines.map((l) => <span key={l}>{l}</span>)}</span>
        </span>
      )}
    </span>
  );
}

