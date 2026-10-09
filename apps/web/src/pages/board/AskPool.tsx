"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Avatar, Button, Drawer, ErrorState, Icon, Skeleton } from "@ros/ui";
import { api, type BoardCard, type BoardView, type PoolAnswer, type PoolQuestion } from "../../api/client";
import { CompareTable } from "../compare/ComparePanel";
import type { CompareView } from "../compare/compare-view";
import { ASK_INTRO, ASK_SOON, ASK_TITLE, COMPARE_MAX, answerPath, boardOrder, lookedAtLine, sourceWords, togglePick } from "./board-model";

/**
 * "Ask about this pool" (plan F10; founder decision B5): one-click questions about the role's finished applications,
 * answered from the checked findings already on file, never by asking the AI anything new. Each answer names the people
 * it is about, as chips that open their panel, with why and the quotes it rests on, and a "Looked at" line saying what
 * was read. "Compare these" asks for up to five people first. Typing your own question is not offered yet, and the
 * panel says so in one line instead of showing a box that does nothing.
 */
export function AskPool(props: { roleId: string; board: BoardView; onClose: () => void; onOpen: (applicationId: string) => void; onShow: (applicationIds: string[], label: string) => void }) {
  const questions = useQuery({ queryKey: ["applications", props.roleId, "questions"], queryFn: () => api.get<{ questions: PoolQuestion[] }>(`/api/v1/roles/${props.roleId}/questions`) });
  const [asked, setAsked] = useState<PoolQuestion | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const path = asked && (asked.kind !== "compare" || compareIds.length) ? answerPath(props.roleId, asked, compareIds) : null;
  const answer = useQuery({ queryKey: ["applications", props.roleId, "answer", path], queryFn: () => api.get<PoolAnswer>(path!), enabled: !!path });
  const byId = new Map(Object.values(props.board.columns).flat().map((c) => [c.applicationId, c]));
  const people = boardOrder(props.board).map((id) => byId.get(id)).filter((c): c is BoardCard => !!c);
  const ask = (q: PoolQuestion) => {
    setAsked(q);
    setCompareIds([]);
  };
  return (
    <Drawer open onClose={props.onClose} title={ASK_TITLE} sub="Answers come from the checked findings already on file." leading={<span className="ask-mark" aria-hidden="true"><Icon name="assistant" size={18} /></span>}>
      <div className="ask">
        <p className="ask-intro">{ASK_INTRO}</p>
        {questions.isLoading ? <Skeleton lines={3} /> : questions.error ? <ErrorState message="Could not load the questions." onRetry={() => questions.refetch()} /> : (
          <fieldset className="ask-questions" aria-label="Questions you can ask">
            {(questions.data?.questions ?? []).map((q) => (
              <button key={q.id} type="button" className="ask-question" aria-pressed={asked?.id === q.id} onClick={() => ask(q)}>
                <Icon name={q.kind === "compare" ? "grid" : "search"} size={16} />
                <span>{q.label}</span>
              </button>
            ))}
          </fieldset>
        )}
        {asked?.kind === "compare" && !compareIds.length ? (
          <fieldset className="ask-pick">
            <legend>Choose up to {COMPARE_MAX} people to compare</legend>
            <div className="team-chips">
              {people.map((c) => {
                const on = picked.includes(c.applicationId);
                return (
                  <label key={c.applicationId} className="team-chip" data-checked={on}>
                    <input type="checkbox" checked={on} disabled={!on && picked.length >= COMPARE_MAX} onChange={(e) => setPicked((p) => togglePick(p, c.applicationId, e.target.checked))} />
                    <Avatar name={c.name} size="sm" />
                    {c.name}
                  </label>
                );
              })}
            </div>
            <div className="row">
              <Button size="sm" variant="primary" disabled={!picked.length} onClick={() => setCompareIds(picked)}>Compare {picked.length ? picked.length : ""}</Button>
              <span className="small muted">{picked.length} of {COMPARE_MAX} chosen</span>
            </div>
          </fieldset>
        ) : null}
        {/* Always there, so a screen reader hears each new answer as it arrives. */}
        <div className="ask-answer-area" aria-live="polite">
          {path ? (
            answer.isLoading ? <Skeleton lines={4} /> : answer.error ? <ErrorState message="Could not answer that just now." onRetry={() => answer.refetch()} /> : answer.data ? (
              <AnswerView answer={answer.data} onOpen={props.onOpen} onShow={props.onShow} onCompareAgain={asked?.kind === "compare" ? () => setCompareIds([]) : null} />
            ) : null
          ) : null}
        </div>
        <p className="ask-own small muted">{ASK_SOON}</p>
      </div>
    </Drawer>
  );
}

/** One answer: what was asked, the answer, the people (each opens their panel) with why and the quotes, and what was read. */
export function AnswerView(props: { answer: PoolAnswer; onOpen: (applicationId: string) => void; onShow: (applicationIds: string[], label: string) => void; onCompareAgain: (() => void) | null }) {
  const { answer } = props;
  // "Compare these" answers with the comparison view itself (pages/compare), the same table as the Talent page's Compare.
  const compare = answer.kind === "compare" ? (answer.compare as CompareView | undefined) : undefined;
  return (
    <section className="ask-answer" aria-label={`Answer: ${answer.question}`}>
      <p className="ask-asked">{answer.question}</p>
      <p>{answer.answer}</p>
      {answer.people.length && !compare ? (
        <ul className="ask-people">
          {answer.people.map((p) => (
            <li key={p.applicationId}>
              <button type="button" className="person-chip" onClick={() => props.onOpen(p.applicationId)}>
                <Avatar name={p.name} size="sm" />
                <span>{p.name}</span>
                {p.score !== null ? <span className="person-chip-score">{p.score}<span className="sr-only"> out of 100</span></span> : null}
              </button>
              <p className="small">{p.why}</p>
              {p.quotes.map((q) => (
                <blockquote key={`${q.criterion}-${q.quote}`} className="ask-quote">
                  “{q.quote}”
                  <span className="ask-quote-from">{q.criterion} · {sourceWords(q.source)}</span>
                </blockquote>
              ))}
            </li>
          ))}
        </ul>
      ) : null}
      {compare ? (
        <>
          <div className="person-chips">
            {answer.people.map((p) => (
              <button key={p.applicationId} type="button" className="person-chip" onClick={() => props.onOpen(p.applicationId)}>
                <Avatar name={p.name} size="sm" />
                <span>{p.name}</span>
              </button>
            ))}
          </div>
          <CompareTable data={compare} />
        </>
      ) : null}
      <p className="ask-looked"><Icon name="eye" size={14} />{lookedAtLine(answer.lookedAt)}</p>
      <div className="row">
        {answer.applicationIds.length ? <Button size="sm" onClick={() => props.onShow(answer.applicationIds, answer.question)}>Show {answer.applicationIds.length === 1 ? "this person" : `these ${answer.applicationIds.length}`} on the board</Button> : null}
        {props.onCompareAgain ? <Button size="sm" variant="ghost" onClick={props.onCompareAgain}>Choose other people</Button> : null}
      </div>
    </section>
  );
}

