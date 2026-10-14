"use client";

import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { IntakeFacts, IntakePayCard, IntakeQuestion, IntakeSessionSummary, IntakeSessionView, PlanRoom } from "@ros/contracts";
import { Alert, Button, Eyebrow, Field, Icon } from "@ros/ui";
import { api, ApiError, type IntakeStartResponse, type IntakeTurnResponse } from "../../api/client";
import { Link, useNavigate } from "../../nav";
import { writeDraftClosingDate } from "../../publishing";
import { browserStorage } from "../../start-hire";
import { toast } from "../../toast";
import { AssistantMark } from "./Conversation";
import { PayFields } from "./PayCard";
import {
  BELOW_CHOICES, DEAL_BREAKERS_MAX, EMPLOYMENT_CHOICES, EXPERIENCE_CHOICES, MUST_HAVES_MAX, OWN_QUESTIONS_MAX, QUICK_STEPS, STEP_HINT, STEP_LABEL, STEP_QUESTION, WORK_MODEL_CHOICES,
  addItem, allMustHaves, clearQuickStart, closingDateAsked, emptyQuickState, enterMovesOn, experienceMustHave, fillFromAd, firstMessage, firstUnfinished, hasAnswers, mustHavesRoom, openDealBreakers,
  quickStartDraftKey, quickStartPatch, readQuickStart, reviewRows, skippedAnswers, stepProblem, suggestedMustHaves, suggestedQuestions, todayDay, toggleItem, writeQuickStart,
  type QuickAnswers, type QuickScope, type QuickState,
} from "./quick-start";
import { NEW_ROLE_FRESH_HREF, errorWords, startHireHref, type RecruiterAction } from "./rules";
import { RoomAlert } from "./StartView";

/** The company's business type, for the suggestions (GET /companies/current, the query Setup reads too). */
type CompanyLite = { name?: string; vertical?: string; settings: Record<string, unknown> };

/** The pay boxes without a market figure: the quick start sets the pay; the builder's pay card compares it with the market. */
const NO_MARKET: IntakePayCard = { basis: null, benchmark: null, gap: null, stated: { min: null, max: null, ceiling: null }, confirmed: null, belowMarket: false, summary: "" };

/**
 * The quick start for a new job (Wave S2, K2), at /roles/new?way=quick: ten small steps, one question a screen with
 * "Step 3 of 10", Enter to move on, Back, and a review where every answer has its Edit. "Write the job post" starts a
 * draft in the existing job builder with the plain facts as the first message, puts every answer on it in one edit (the
 * server's fairness check reads each must-have, deal-breaker and question), keeps the closing date for the role, and
 * opens the builder, which writes the post at once. The answers are kept in this browser until then, so a reload loses
 * nothing; "Start over" clears them. Suggestions come from our hiring guides; nothing here calls the AI.
 */
export function QuickStart({ companyName, scope }: { companyName: string | null; scope: QuickScope | null }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const company = useQuery({ queryKey: ["company"], queryFn: () => api.get<CompanyLite>("/api/v1/companies/current") });
  const drafts = useQuery({ queryKey: ["intake", "mine"], queryFn: () => api.get<{ sessions: IntakeSessionSummary[]; room: PlanRoom }>("/api/v1/intake/sessions?mine=1") });
  const vertical = company.data?.vertical ?? null;
  const name = companyName ?? company.data?.name ?? null;

  // The first draw is the first step, the same on the server and in the browser; what this browser kept comes after.
  // Kept per company and per person: with nobody known (never on this page in practice) nothing is kept at all. The
  // scope is read again only when the person or the company changes (scopeKey), not on every draw.
  const [state, setState] = useState<QuickState>(() => emptyQuickState(scope?.companyId ?? null));
  const [loaded, setLoaded] = useState(false);
  const scopeKey = scope ? `${scope.companyId}:${scope.userId}` : "";
  useEffect(() => {
    if (!scope) return;
    const kept = readQuickStart(browserStorage(), scope);
    if (kept) setState(kept);
    setLoaded(true);
  }, [scopeKey]);
  useEffect(() => {
    if (loaded && scope) writeQuickStart(browserStorage(), state, scope);
  }, [state, loaded, scopeKey]);

  const [problem, setProblem] = useState<string | null>(null);
  const [notARole, setNotARole] = useState<string | null>(null);
  const [limit, setLimit] = useState<{ room: PlanRoom | null; ask: RecruiterAction | null } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  const step = QUICK_STEPS[state.step] ?? "title";
  const a = state.answers;
  // Moving to another step takes the reader to its question (never on the first draw).
  useEffect(() => {
    if (moved.current) heading.current?.focus();
  }, [state.step]);

  const set = (patch: Partial<QuickAnswers>) => { setProblem(null); setState((s) => ({ ...s, answers: { ...s.answers, ...patch } })); };
  const goTo = (index: number, fromReview = false) => {
    moved.current = true;
    setProblem(null);
    setState((s) => ({ ...s, step: Math.max(0, Math.min(index, QUICK_STEPS.length - 1)), fromReview }));
  };
  const review = QUICK_STEPS.indexOf("review");

  const write = useMutation({
    mutationFn: async () => {
      const answers = state.answers;
      let sessionId = state.sessionId;
      let facts: Pick<IntakeFacts, "mustHaves"> | null = null;
      let open: IntakeQuestion[] = [];
      if (sessionId) {
        // Made on an earlier try whose answers did not go through: the answers go on that draft, not a second one. A
        // draft that is gone since (discarded, or no longer theirs) is left alone, and a new one is started.
        const r = await api.get<{ session: IntakeSessionView }>(`/api/v1/intake/sessions/${encodeURIComponent(sessionId)}`).catch((err: unknown) => {
          if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return null;
          throw err;
        });
        if (r && r.session.status === "active") {
          facts = r.session.facts;
          open = r.session.questions;
        } else {
          sessionId = null;
        }
      }
      if (!sessionId) {
        const r = await api.post<IntakeStartResponse>("/api/v1/intake/sessions", { initialMessage: firstMessage(answers) });
        if (!r.session) return { kind: "not_a_role" as const, message: r.reply?.assistantMessage ?? "That does not read as a new job, so no draft was started. Check the job title." };
        sessionId = r.session.id;
        facts = r.session.facts;
        open = r.session.questions;
        if (r.reply) qc.setQueryData(["intake", "first-reply", sessionId], r.reply);
        const made = sessionId;
        setState((s) => ({ ...s, sessionId: made }));
      }
      const id = sessionId;
      const edited = await api.post<IntakeTurnResponse>(`/api/v1/intake/sessions/${encodeURIComponent(id)}/answers`, {
        answers: skippedAnswers(open),
        patch: quickStartPatch(answers, vertical, facts),
        draftIt: true,
        reply: false,
      });
      return { kind: "written" as const, sessionId: id, edited };
    },
    onMutate: () => { setProblem(null); setNotARole(null); setLimit(null); },
    onSuccess: (r) => {
      if (r.kind === "not_a_role") {
        setNotARole(r.message);
        return;
      }
      const storage = browserStorage();
      // The closing date belongs to the role, which "Ask for approval" creates: kept on the draft until then (as the builder does).
      if (!state.answers.noClosingDate && state.answers.closesOn) writeDraftClosingDate(storage, r.sessionId, state.answers.closesOn);
      qc.setQueryData(["intake", "session", r.sessionId], { session: r.edited.session });
      qc.setQueryData(quickStartDraftKey(r.sessionId), true);
      for (const k of [["intake", "mine"], ["brief"]]) qc.invalidateQueries({ queryKey: k });
      // A deal-breaker counted as a must-have is checked twice (once for each list): it is named once.
      const refused = (r.edited.refused ?? []).filter((x, i, all) => all.findIndex((y) => y.text.toLowerCase() === x.text.toLowerCase()) === i);
      if (refused.length) toast("Some answers were not used.", refused.map((x) => `"${x.text}": ${x.reason}`).join(" "));
      clearQuickStart(storage, scope);
      setLoaded(false);
      nav(startHireHref(r.sessionId), { replace: true });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "limit_reached") {
        const d = err.details as { room?: PlanRoom; actions?: Array<{ label: string; body?: Record<string, unknown> }> } | undefined;
        const act = d?.actions?.[0];
        setLimit({ room: d?.room ?? null, ask: act ? { label: act.label, body: act.body ?? {} } : null });
        return;
      }
      setProblem(errorWords(err));
    },
  });

  const room = limit?.room ?? drafts.data?.room ?? null;
  const full = !!room && !room.ok;

  const next = () => {
    if (write.isPending) return;
    const today = todayDay();
    if (step === "review") {
      const gap = firstUnfinished(state.answers, today);
      if (gap !== null) {
        goTo(gap, true);
        setProblem(stepProblem(QUICK_STEPS[gap], state.answers, today));
        return;
      }
      if (!full) write.mutate();
      return;
    }
    const p = stepProblem(step, a, today);
    if (p) {
      setProblem(p);
      return;
    }
    goTo(state.fromReview ? review : state.step + 1, false);
  };
  const back = () => goTo(state.fromReview ? review : state.step - 1, false);
  const startOver = () => {
    clearQuickStart(browserStorage(), scope);
    setNotARole(null);
    setLimit(null);
    goTo(0);
    setState(emptyQuickState(scope?.companyId ?? null));
  };
  const onSubmit = (e: FormEvent) => { e.preventDefault(); next(); };
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (!enterMovesOn({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }, e.target as HTMLElement)) return;
    e.preventDefault();
    next();
  };

  const primary = step === "review" ? "Write the job post" : state.fromReview ? "Back to review" : "Next";

  return (
    <div className="start">
      <Eyebrow>{name ? `New job · ${name}` : "New job"}</Eyebrow>
      <p className="small muted" aria-live="polite">Step {state.step + 1} of {QUICK_STEPS.length} · {STEP_LABEL[step]}</p>
      <h1 ref={heading} tabIndex={-1}>{STEP_QUESTION[step]}</h1>
      <p className="start-lede">{STEP_HINT[step]}</p>
      {full && room ? <RoomAlert room={room} ask={limit?.ask ?? null} /> : null}
      <form className="stack" style={{ gap: 14 }} onSubmit={onSubmit} onKeyDown={onKeyDown} noValidate>
        <StepBody step={step} a={a} set={set} vertical={vertical} onEdit={(i) => goTo(i, true)} />
        {problem ? <Alert tone="caution">{problem}</Alert> : null}
        {notARole ? (
          <div className="chat-msg assistant">
            <AssistantMark />
            <div className="bubble assistant">{notARole}</div>
          </div>
        ) : null}
        <div className="row" style={{ justifyContent: "space-between" }}>
          {state.step === 0 && !state.fromReview ? (
            <Link to={NEW_ROLE_FRESH_HREF} className="btn ghost">Other ways to start</Link>
          ) : (
            <Button variant="ghost" icon="arrow-left" onClick={back}>{state.fromReview ? "Review" : "Back"}</Button>
          )}
          <Button type="submit" variant="primary" iconEnd={step === "review" ? "sparkle" : "arrow-right"} loading={write.isPending} disabled={step === "review" && full}>{primary}</Button>
        </div>
      </form>
      <p className="small muted start-note">
        <Icon name="check" size={14} /> Press Enter to go on. Your answers are kept in this browser.
        {hasAnswers(a) || state.step > 0 ? <> <button type="button" className="link-btn" onClick={startOver}>Start over</button></> : null}
      </p>
    </div>
  );
}

/** A group of choices, one or several, as rows to tick (the question card's look). */
function Choices(props: { legend: string; name: string; multi?: boolean; options: ReadonlyArray<{ value: string; label: string; note?: string }>; checked: (value: string) => boolean; onPick: (value: string) => void; disabled?: boolean }) {
  return (
    <fieldset className="qfield">
      <legend className="sr-only">{props.legend}</legend>
      <div className="qopts">
        {props.options.map((o) => {
          const on = props.checked(o.value);
          return (
            <label key={o.value} className="qopt" data-checked={on ? "true" : undefined}>
              <input type={props.multi ? "checkbox" : "radio"} name={props.name} value={o.value} aria-label={o.label} checked={on} disabled={props.disabled} onChange={() => props.onPick(o.value)} />
              <span className="qopt-label">{o.label}</span>
              {o.note ? <span className="qopt-origin">{o.note}</span> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** "Add your own": a box and Add; Enter adds the words, or moves on when the box is empty. The items added sit above it as chips. */
function AddOwn(props: { id: string; label: string; placeholder: string; items: readonly string[]; max: number; onAdd: (text: string) => void; onRemove: (text: string) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const add = () => { props.onAdd(text); setText(""); };
  return (
    <div className="own-box">
      {props.items.length ? (
        <ul className="own-items" aria-label="Added by you">
          {props.items.map((t) => (
            <li key={t} className="chip accent">
              {t}
              <button type="button" className="chip-x" aria-label={`Remove ${t}`} onClick={() => props.onRemove(t)}><Icon name="x" size={12} /></button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row" style={{ flexWrap: "nowrap" }}>
        <label htmlFor={props.id} className="sr-only">{props.label}</label>
        <input
          id={props.id}
          className="input"
          value={text}
          maxLength={300}
          placeholder={props.placeholder}
          disabled={props.disabled || props.items.length >= props.max}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing || !text.trim()) return;
            e.preventDefault();
            e.stopPropagation();
            add();
          }}
        />
        <Button size="sm" disabled={props.disabled || !text.trim() || props.items.length >= props.max} onClick={add}>Add</Button>
      </div>
    </div>
  );
}

function StepBody({ step, a, set, vertical, onEdit }: { step: (typeof QUICK_STEPS)[number]; a: QuickAnswers; set: (patch: Partial<QuickAnswers>) => void; vertical: string | null; onEdit: (step: number) => void }): ReactNode {
  switch (step) {
    case "title":
      return <TitleStep a={a} set={set} />;
    case "type":
      return <Choices legend={STEP_QUESTION.type} name="qs-type" options={EMPLOYMENT_CHOICES} checked={(v) => a.employmentType === v} onPick={(v) => set({ employmentType: v })} />;
    case "where": {
      const placeLabel = a.remotePolicy === "remote" ? "Where can they live?" : a.remotePolicy === "hybrid" ? "Where is the office?" : "Where is the job?";
      return (
        <>
          <Choices legend={STEP_QUESTION.where} name="qs-where" options={WORK_MODEL_CHOICES} checked={(v) => a.remotePolicy === v} onPick={(v) => set({ remotePolicy: v })} />
          <Field label={placeLabel} htmlFor="qs-place">
            <input id="qs-place" className="input" value={a.place} maxLength={200} autoComplete="off" placeholder={a.remotePolicy === "remote" ? "e.g. Anywhere in the US" : "e.g. Irvine, CA"} onChange={(e) => set({ place: e.target.value })} />
          </Field>
        </>
      );
    }
    case "experience":
      return (
        <>
          <Choices legend={STEP_QUESTION.experience} name="qs-experience" options={EXPERIENCE_CHOICES} checked={(v) => a.experience === v} onPick={(v) => set({ experience: v, below: v === "none" ? "" : a.below })} />
          {a.experience && a.experience !== "none" ? (
            <>
              <h2 className="qcard-prompt" id="qs-below-h">Anyone with less?</h2>
              <Choices legend="Anyone with less?" name="qs-below" options={BELOW_CHOICES} checked={(v) => a.below === v} onPick={(v) => set({ below: v as QuickAnswers["below"] })} />
            </>
          ) : null}
        </>
      );
    case "pay":
      return <PayFields form={a.pay} onChange={(pay) => set({ pay })} card={NO_MARKET} idBase="qs-pay" />;
    case "closing":
      return (
        <>
          <Field label="Last day to apply" htmlFor="qs-closes">
            <input id="qs-closes" className="input" type="date" min={todayDay()} value={a.closesOn} disabled={a.noClosingDate} onChange={(e) => set({ closesOn: e.target.value })} />
          </Field>
          <Choices legend="No closing date" name="qs-no-close" multi options={[{ value: "none", label: "No closing date" }]} checked={() => a.noClosingDate} onPick={() => set({ noClosingDate: !a.noClosingDate })} />
          {closingDateAsked(a) ? <p className="small muted">Colorado law asks job ads for a closing date. Without one, a date is set for you; you can change it.</p> : null}
        </>
      );
    case "musts": {
      const guide = suggestedMustHaves(vertical, a.title);
      const fromAd = a.adMustHaves.filter((m) => !guide.some((s) => s.toLowerCase() === m.toLowerCase()));
      const suggested = [...guide, ...fromAd];
      const own = a.mustHaves.filter((m) => !suggested.some((s) => s.toLowerCase() === m.toLowerCase()));
      const room = Math.max(0, mustHavesRoom(a));
      const count = allMustHaves(a).length;
      const dealCount = openDealBreakers(a).length;
      return (
        <>
          {suggested.length ? (
            <Choices legend={STEP_QUESTION.musts} name="qs-musts" multi options={[...guide.map((s) => ({ value: s, label: s, note: "Our hiring guide" })), ...fromAd.map((s) => ({ value: s, label: s, note: "Your job ad" }))]} checked={(v) => a.mustHaves.some((m) => m.toLowerCase() === v.toLowerCase())} onPick={(v) => set({ mustHaves: toggleItem(a.mustHaves, v) })} />
          ) : null}
          <AddOwn id="qs-must-own" label="Add a must-have" placeholder={suggested.length ? "Add your own…" : "e.g. Two years in a busy dental office"} items={own} max={room} onAdd={(t) => set({ mustHaves: addItem(a.mustHaves, t, room) })} onRemove={(t) => set({ mustHaves: a.mustHaves.filter((m) => m !== t) })} />
          <p className="small muted" aria-live="polite">{count} of {MUST_HAVES_MAX} chosen{experienceMustHave(a) ? ", with the experience" : ""}{dealCount ? `, with ${dealCount} deal-breaker${dealCount === 1 ? "" : "s"}` : ""}.</p>
        </>
      );
    }
    case "dealbreakers": {
      // Founder decision Q19: each deal-breaker counts openly as a must-have unless unticked; an unticked one judges nobody.
      const roomLeft = MUST_HAVES_MAX - allMustHaves(a).length;
      const isOpen = (d: string) => !a.dealBreakersPrivate.some((p) => p.toLowerCase() === d.toLowerCase());
      const add = (t: string) => {
        const list = addItem(a.dealBreakers, t, DEAL_BREAKERS_MAX);
        const added = list.length > a.dealBreakers.length ? list[list.length - 1] : null;
        // ticked by default, unless the six must-haves are already full
        set({ dealBreakers: list, noDealBreakers: false, ...(added && roomLeft <= 0 ? { dealBreakersPrivate: [...a.dealBreakersPrivate, added] } : {}) });
      };
      const remove = (t: string) => set({ dealBreakers: a.dealBreakers.filter((d) => d !== t), dealBreakersPrivate: a.dealBreakersPrivate.filter((d) => d.toLowerCase() !== t.toLowerCase()) });
      return (
        <>
          <Choices legend={STEP_QUESTION.dealbreakers} name="qs-none" multi options={[{ value: "none", label: "None" }]} checked={() => a.noDealBreakers} onPick={() => set({ noDealBreakers: !a.noDealBreakers })} />
          <AddOwn id="qs-deal-own" label="Add a deal-breaker" placeholder="e.g. Cannot work Saturdays" items={a.dealBreakers} max={DEAL_BREAKERS_MAX} disabled={a.noDealBreakers} onAdd={add} onRemove={remove} />
          {a.dealBreakers.length && !a.noDealBreakers ? (
            <fieldset className="qfield">
              <legend className="small">Count it openly as a must-have</legend>
              <div className="qopts">
                {a.dealBreakers.map((d) => {
                  const on = isOpen(d);
                  return (
                    <label key={d} className="qopt" data-checked={on ? "true" : undefined}>
                      <input type="checkbox" checked={on} aria-label={`Count "${d}" openly as a must-have`} disabled={!on && roomLeft <= 0} onChange={() => set({ dealBreakersPrivate: toggleItem(a.dealBreakersPrivate, d) })} />
                      <span className="qopt-label">{d}</span>
                      <span className="qopt-origin">{on ? "Must-have" : "Not used to judge"}</span>
                    </label>
                  );
                })}
              </div>
              <p className="small muted">Everyone is checked openly against must-haves. An unticked one is not used to judge anyone.</p>
            </fieldset>
          ) : null}
        </>
      );
    }
    case "questions": {
      const suggested = suggestedQuestions(vertical, a.title);
      return (
        <>
          <Choices legend={STEP_QUESTION.questions} name="qs-questions" multi options={suggested.map((q) => ({ value: q, label: q }))} checked={(v) => !a.questionsOff.some((x) => x.toLowerCase() === v.toLowerCase())} onPick={(v) => set({ questionsOff: toggleItem(a.questionsOff, v) })} />
          <AddOwn id="qs-question-own" label="Add a question for the screening chat" placeholder="Add your own question…" items={a.ownQuestions} max={OWN_QUESTIONS_MAX} onAdd={(t) => set({ ownQuestions: addItem(a.ownQuestions, t, OWN_QUESTIONS_MAX) })} onRemove={(t) => set({ ownQuestions: a.ownQuestions.filter((q) => q !== t) })} />
        </>
      );
    }
    case "review":
      return (
        <>
          <ul className="list" aria-label="Your answers" style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {reviewRows(a, vertical).map((r) => (
              <li key={r.label} className="list-item">
                <span className="list-item-main">
                  <strong>{r.label}</strong>
                  <span className="sub">{r.value}</span>
                </span>
                <span className="list-item-end">
                  <Button size="sm" variant="ghost" icon="edit" ariaLabel={`Edit ${r.label.toLowerCase()}`} onClick={() => onEdit(r.step)}>Edit</Button>
                </span>
              </li>
            ))}
          </ul>
          <p className="small muted">The assistant drafts the post in the job builder; you check it there. Nothing is posted until someone approves the job.</p>
        </>
      );
  }
}

/** The first step: the job title, or a job ad to fill in the steps from (pasted, or a text file dropped on the box). */
function TitleStep({ a, set }: { a: QuickAnswers; set: (patch: Partial<QuickAnswers>) => void }) {
  const ad = a.ad;
  const setAd = (text: string) => set({ ad: text });
  const [note, setNote] = useState<string | null>(null);
  const use = (text: string) => {
    const r = fillFromAd(a, text);
    set(r.answers);
    setNote(r.filled.length ? `Filled in: ${r.filled.join(", ")}. Check each step.` : "Nothing new to fill in. The ad still goes with your answers.");
  };
  const onDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    e.preventDefault();
    if (!/^text\//.test(file.type) && !/\.(txt|md)$/i.test(file.name)) {
      setNote("Drop a plain text file, or copy the ad's words and paste them here.");
      return;
    }
    void file.text().then((t) => { setAd(t.slice(0, 20_000)); setNote(null); }).catch(() => setNote("That file could not be read. Paste the words instead."));
  };
  return (
    <>
      <Field label="Job title" htmlFor="qs-title">
        <input id="qs-title" className="input" value={a.title} maxLength={120} autoComplete="off" placeholder="e.g. Dental hygienist" onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <details className="more">
        <summary>{ad.trim() ? "Your job ad (it goes with your answers)" : "Paste a job ad instead"}</summary>
        <div className="stack" style={{ gap: 8 }}>
          <textarea className="textarea" aria-label="Paste a job ad" value={ad} maxLength={20_000} rows={6} placeholder="Paste the ad here, or drop a text file on this box." onChange={(e) => setAd(e.target.value)} onDrop={onDrop} />
          <div className="row">
            <Button size="sm" disabled={!ad.trim()} onClick={() => use(ad)}>Fill in from this ad</Button>
            <span className="small muted" aria-live="polite">{note ?? ""}</span>
          </div>
        </div>
      </details>
    </>
  );
}
