"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  appPaths,
  type IntakeAnswer, type IntakeAnswersRequest, type IntakeMessageRequest, type IntakeSessionResponse, type IntakeSessionView, type IntakeTurnReply, type IntakeTurnResponse,
  type KeepPacketFlag, type PublishResult, type SetClosingDate,
} from "@ros/contracts";
import { Alert, Button, EmptyState, ErrorState, Icon, Menu, Pill, ProgressSteps, Skeleton, SplitView } from "@ros/ui";
import { ApiError, api, errorCode, errorWords, type Me, planLimitOf } from "../../api/client";
import {
  answersPayload, answersToCarry, cardsKey, cardsToShow, carriedLine, closeDeck, composerPlaceholder, deckFor, draftSteps, draftTitle, draftingNow, echoText,
  firstReplyKey, initialCards, publishHelp, refusedLines, sessionKey, turnProblem, typedWithCards, typeInstead, writeHelp,
  type ButtonHelp, type Deck, type Problem,
} from "../../builder";
import { Upgrade } from "../../components/Upgrade";
import { dockFocusDue, focusLost } from "../../focus-after";
import { Link, useNavigate } from "../../nav";
import { activeCompanyOf } from "../../rail";
import { managesCompany } from "../../roles";
import { toast } from "../../toast";
import { JobEditor } from "../job/JobEditor";
import { Composer } from "./Composer";
import { Conversation, type LocalLine } from "./Conversation";
import { DraftPane } from "./DraftPane";
import { QuestionCard } from "./QuestionCard";

/**
 * The job builder with a draft under way: the conversation on the left, the job taking shape on the right (one or the
 * other on a phone, with a switch). The assistant asks for what is missing with tap-to-answer cards docked where the
 * message box is; the picks go back as one summary message. "Write the job" has the assistant write the description and
 * the posting, with each real step shown as the server records it. Then every field can be changed in the one editor,
 * and "Publish job" opens the job. Each of the two buttons waits, greyed, until the server says it may be pressed, and
 * says in the server's words what is still needed.
 */
export function Builder({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const key = useMemo(() => sessionKey(sessionId), [sessionId]);
  const base = `/api/v1/intake/sessions/${encodeURIComponent(sessionId)}`;
  // While the job is being written the page asks every second how far it has got (the server records each step).
  const [polling, setPolling] = useState(false);
  const session = useQuery({
    queryKey: key,
    queryFn: () => api.get<IntakeSessionResponse>(base),
    retry: (count, e) => !(e instanceof ApiError && (e.status === 403 || e.status === 404)) && count < 1,
    refetchInterval: (q) => (polling || draftingNow(q.state.data?.session.progress ?? null) ? 1000 : false),
  });
  const view = session.data?.session ?? null;
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  // an owner or an admin sets the closing date and may take over a draft someone else started
  const manages = managesCompany(activeCompanyOf(me.data).role);

  const [problem, setProblem] = useState<Problem | null>(() => turnProblem(qc.getQueryData<IntakeTurnReply>(firstReplyKey(sessionId)) ?? null));
  const [notUsed, setNotUsed] = useState<string[]>([]);
  const [pending, setPending] = useState<LocalLine | null>(null);
  const [thinking, setThinking] = useState<string | null>(null);
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement | null>(null);
  /** Set when the cards' answers are sent: the cards they were sent from, so the next dock can take the focus. */
  const handOff = useRef<{ from: string } | null>(null);
  const [deck, setDeck] = useState<Deck>({ key: "", state: initialCards(), closed: false });
  const [pane, setPane] = useState<"primary" | "secondary">("primary");
  const [editing, setEditing] = useState(false);
  const [guardChanges, setGuardChanges] = useState<string[]>([]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** The main button was pressed while greyed: what it waits for is said beside it until something changes. */
  const [helpShown, setHelpShown] = useState(false);
  const helpId = useId();

  const apply = (s: IntakeSessionView) => qc.setQueryData<IntakeSessionResponse>(key, { session: s });
  const failed = (err: unknown) => setProblem({ message: errorWords(err), ask: planLimitOf(err)?.ask ?? null });
  const afterTurn = (r: IntakeTurnResponse) => {
    apply(r.session);
    setProblem(turnProblem(r.reply));
    setNotUsed(refusedLines(r.refused));
    qc.invalidateQueries({ queryKey: ["intake", "sessions"] });
  };
  const starting = () => {
    setProblem(null);
    setNotUsed([]);
    setHelpShown(false);
  };

  const send = useMutation({
    mutationFn: (message: string) => api.post<IntakeTurnResponse>(`${base}/messages`, { message } satisfies IntakeMessageRequest),
    onMutate: (message) => {
      starting();
      setPending({ key: "pending", role: "owner", content: message });
      setThinking("Thinking…");
      setText("");
    },
    onSuccess: afterTurn,
    onError: (err, message) => {
      setText(message);
      failed(err);
    },
    onSettled: () => {
      setPending(null);
      setThinking(null);
    },
  });
  const answer = useMutation({
    mutationFn: (input: { answers: IntakeAnswer[]; echo: string; note?: string }) => api.post<IntakeTurnResponse>(`${base}/answers`, { answers: input.answers, ...(input.note ? { note: input.note } : {}) } satisfies IntakeAnswersRequest),
    onMutate: (input) => {
      starting();
      setPending({ key: "pending", role: "owner", content: input.echo, kind: "answers" });
      setThinking("Thinking about your answers…");
      if (input.note) setText("");
    },
    onSuccess: afterTurn,
    onError: (err, input) => {
      if (input.note) setText(input.note);
      failed(err);
      // a card answered after newer ones arrived: show the newer ones
      qc.invalidateQueries({ queryKey: key });
    },
    onSettled: () => {
      setPending(null);
      setThinking(null);
    },
  });
  const write = useMutation({
    // what is answered on the open cards goes first, or the job would be written without it
    mutationFn: async (carried: { answers: IntakeAnswer[] } | null) => {
      if (carried) {
        const r = await api.post<IntakeTurnResponse>(`${base}/answers`, { answers: carried.answers } satisfies IntakeAnswersRequest);
        apply(r.session);
        setNotUsed(refusedLines(r.refused));
      }
      return api.post<IntakeSessionResponse>(`${base}/draft`);
    },
    onMutate: () => {
      starting();
      setPolling(true);
    },
    onSuccess: (r) => {
      apply(r.session);
      setPane("secondary");
      toast("The job is written.", "Check it, then publish.");
    },
    // said in the conversation, which a phone may have folded away behind the job
    onError: (err) => {
      setPane("primary");
      failed(err);
    },
    onSettled: () => {
      setPolling(false);
      qc.invalidateQueries({ queryKey: key });
    },
  });
  const publish = useMutation({
    mutationFn: () => api.post<PublishResult>(`${base}/publish`),
    onMutate: starting,
    onSuccess: (r) => {
      toast("Job published.", "Share it to bring in applicants.");
      for (const k of [["roles"], ["home"], ["intake", "sessions"]]) qc.invalidateQueries({ queryKey: k });
      nav(appPaths.jobShare(r.roleId));
    },
    onError: (err) => {
      // what is still needed is listed beside the job, from the draft itself
      if (errorCode(err) === "not_ready") {
        qc.invalidateQueries({ queryKey: key });
        setPane("secondary");
        setHelpShown(true);
      } else failed(err);
    },
  });
  const keep = useMutation({
    mutationFn: (input: KeepPacketFlag) => api.post<IntakeSessionResponse>(`${base}/flags/keep`, input),
    onSuccess: (r) => {
      apply(r.session);
      toast("Kept, with your reason.");
    },
    onError: (err) => toast(errorWords(err), { tone: "critical" }),
  });
  const closing = useMutation({
    mutationFn: (closesOn: string | null) => api.put<IntakeSessionResponse>(`${base}/closing-date`, { closesOn } satisfies SetClosingDate),
    onSuccess: (r) => {
      apply(r.session);
      toast(r.session.closesOn ? "Closing date saved." : "Closing date taken off.");
    },
  });
  const abandon = useMutation({
    mutationFn: () => api.post<IntakeSessionResponse>(`${base}/abandon`),
    onSuccess: () => {
      toast("Draft discarded.");
      for (const k of [["intake", "sessions"], ["home"]]) qc.invalidateQueries({ queryKey: k });
      nav(appPaths.jobs);
    },
    onError: (err) => toast(errorWords(err), { tone: "critical" }),
  });
  const takeOver = useMutation({
    mutationFn: () => api.post<IntakeSessionResponse>(`${base}/take-over`),
    onSuccess: (r) => {
      apply(r.session);
      toast("The draft is yours now.");
      qc.invalidateQueries({ queryKey: ["intake", "sessions"] });
    },
    onError: (err) => toast(errorWords(err), { tone: "critical" }),
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
  const startAgain = <Link to={appPaths.newJob} className="btn primary">Start a hire</Link>;
  if (session.error || !view) {
    if (session.error instanceof ApiError && session.error.status === 404) return <EmptyState icon="roles" title="We could not find that draft" action={startAgain} />;
    return <ErrorState message={errorWords(session.error, "Could not load this draft.")} onRetry={() => session.refetch()} />;
  }
  if (view.status === "compiled") return <EmptyState icon="roles" title="This draft is now a job" action={view.roleId ? <Link to={appPaths.job(view.roleId)} className="btn primary">Open the job</Link> : undefined} />;
  if (view.status !== "active") return <EmptyState icon="roles" title="This draft was discarded" action={startAgain} />;

  const title = draftTitle(view);
  const written = !!view.draft;
  const cards = cardsToShow(view);
  const deckKey = cardsKey(cards);
  const live = deckFor(deck, cards);
  const showCards = cards.length > 0 && !live.closed;
  const writing = write.isPending || draftingNow(view.progress);
  const busy = send.isPending || answer.isPending || write.isPending || publish.isPending;
  const lastReply = [...view.messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const announce = thinking ? "The assistant is thinking." : problem ? problem.message : lastReply;
  // The page's one main action: write the job, then publish it. A written job whose answers changed since is written
  // again from the Job pane, which asks first when edits would be replaced.
  const main: { label: string; help: ButtonHelp; loading: boolean; run: () => void } = written
    ? { label: "Publish job", help: publishHelp(view.readiness), loading: publish.isPending, run: () => publish.mutate() }
    : { label: "Write the job", help: writeHelp(view.readiness), loading: write.isPending, run: () => write.mutate(answersToCarry(cards, live)) };
  const pressMain = () => {
    if (main.help.ready) return main.run();
    setHelpShown(true);
    if (written) setPane("secondary");
  };
  // After "Or type your own answer…" what is answered on the cards goes with typed words (the reply's new cards would
  // start the deck afresh); after the X it stays on the cards.
  const submitText = (typed: string) => {
    const withCards = typedWithCards(cards, live, typed);
    return withCards ? answer.mutate(withCards) : send.mutate(typed);
  };
  const sendCards = () => {
    handOff.current = { from: deckKey };
    answer.mutate({ answers: answersPayload(cards, live.state), echo: echoText(cards, live.state) });
  };

  const above = (
    <>
      {problem ? (
        <Alert tone="caution">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{problem.message}</span>
            {problem.ask ? <Upgrade label={problem.ask.label} size="sm" variant="primary" reason={problem.ask.reason} /> : null}
          </div>
        </Alert>
      ) : null}
      {notUsed.length ? (
        <Alert tone="caution">
          <ul className="grid gap-0.5">{notUsed.map((line) => <li key={line}>{line}</li>)}</ul>
        </Alert>
      ) : null}
      {writing ? (
        <div className="rounded-xl border border-line-tint bg-tint px-4 py-3.5 motion-safe:animate-fade">
          <ProgressSteps live label="Writing the job" steps={draftSteps(view.progress?.stage === "writing" || view.progress?.stage === "checking" ? view.progress.stage : "starting")} />
        </div>
      ) : null}
      {!written && view.readiness.mayDraft && !writing && !busy ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line-tint bg-linear-110 from-tint to-peach px-4 py-3 text-[14px] text-ink motion-safe:animate-enter">
          <span className="flex min-w-0 items-start gap-2"><Icon name="sparkle" size={16} className="mt-0.5 text-accent" /> Everything needed is in.</span>
          <Button size="sm" variant="primary" onClick={() => write.mutate(answersToCarry(cards, live))}>Write the job</Button>
        </div>
      ) : null}
      {cards.length && live.closed ? <Button size="sm" variant="ghost" icon="chevron-up" onClick={() => setDeck({ ...live, closed: false })}>{`Show the questions (${cards.length})`}</Button> : null}
    </>
  );

  const dock = showCards ? (
    <QuestionCard
      key={deckKey}
      questions={cards}
      state={live.state}
      onState={(state) => setDeck({ ...live, state })}
      onSend={sendCards}
      onClose={() => setDeck(closeDeck(live))}
      onTypeInstead={() => {
        setDeck(typeInstead(live));
        window.setTimeout(() => box.current?.focus(), 0);
      }}
      sending={answer.isPending}
      pay={view.pay}
    />
  ) : (
    <Composer
      inputRef={box}
      value={text}
      onChange={setText}
      onSend={submitText}
      sending={send.isPending || answer.isPending}
      disabled={busy && !send.isPending && !answer.isPending}
      label="Message to the assistant"
      placeholder={composerPlaceholder(true)}
      carried={answer.isPending ? null : carriedLine(cards, live)}
    />
  );

  return (
    // .builder is a hook only: the frame (AppShell) gives a page holding it 1440px
    <div className="builder grid gap-5">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-4">
        <div className="flex min-w-0 flex-1 basis-[min(100%,26rem)] items-center gap-3 [&>h1]:min-w-0 [&>h1]:wrap-anywhere md:[&>h1]:text-[40px]">
          <h1 className={title ? undefined : "text-ink-3"}>{title ?? "Untitled job"}</h1>
          <Pill size="sm" tone="caution">Draft</Pill>
        </div>
        <div className="ml-auto flex w-full items-center justify-end gap-2 sm:w-auto">
          <Menu
            label="More"
            ariaLabel="More for this draft"
            buttonClassName="btn ghost"
            align="end"
            items={[{ id: "discard", label: "Discard this draft", icon: "x", danger: true }]}
            onSelect={() => setConfirmDiscard(true)}
          />
          <Button variant="primary" loading={main.loading} disabled={busy && !main.loading} ariaDisabled={!main.help.ready && !busy} describedBy={helpId} onClick={pressMain}>{main.label}</Button>
        </div>
      </header>
      {/* what the main button waits for: read with it by a screen reader, and shown once it is pressed while greyed */}
      <div id={helpId} className={helpShown && !main.help.ready ? undefined : "sr-only"}>
        {main.help.ready ? null : (
          <Alert tone="caution">
            <ul className="grid gap-0.5">{main.help.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          </Alert>
        )}
      </div>

      {confirmDiscard ? (
        <Alert tone="caution">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Discard this draft? It cannot be continued afterwards.</span>
            <span className="row">
              <Button size="sm" variant="danger" loading={abandon.isPending} onClick={() => abandon.mutate()}>Discard it</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>Keep it</Button>
            </span>
          </div>
        </Alert>
      ) : null}
      {!view.startedBy.mine ? (
        <Alert tone="info">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{view.startedBy.name ?? "Someone on your team"} started this draft.</span>
            {manages ? <Button size="sm" loading={takeOver.isPending} onClick={() => takeOver.mutate()}>Take it over</Button> : null}
          </div>
        </Alert>
      ) : null}

      <SplitView
        primaryLabel="Conversation"
        secondaryLabel="Job"
        switchLabel="Show"
        pane={pane}
        onPaneChange={setPane}
        primary={<Conversation messages={view.messages} pending={pending} thinking={thinking} announce={announce} above={above} dock={dock} />}
        secondary={
          <DraftPane
            view={view}
            guardChanges={guardChanges}
            previewHref={`${base}/preview/page`}
            onEdit={() => setEditing(true)}
            onRewrite={() => write.mutate(answersToCarry(cards, live))}
            rewriting={write.isPending}
            onKeepFlag={(flagId, reason) => keep.mutate({ flagId, reason })}
            keepingFlag={keep.isPending ? keep.variables?.flagId ?? null : null}
            closing={manages ? { onSave: (closesOn) => closing.mutate(closesOn), saving: closing.isPending, error: closing.error ? errorWords(closing.error) : null } : null}
          />
        }
      />
      {editing && view.draft ? (
        <JobEditor
          packet={view.draft}
          target={{ kind: "draft", sessionId }}
          onClose={() => setEditing(false)}
          onSaved={(changes) => {
            setGuardChanges(changes);
            setEditing(false);
            setHelpShown(false);
            toast("Saved.");
          }}
        />
      ) : null}
    </div>
  );
}
