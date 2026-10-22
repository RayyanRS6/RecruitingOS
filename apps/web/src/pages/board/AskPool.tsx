"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Avatar, Button, Drawer, ErrorState, Icon, IconChip, Skeleton } from "@ros/ui";
import { api, type BoardCard, type BoardView, type PoolAnswer, type PoolQuestion } from "../../api/client";
import { CompareTable } from "../compare/ComparePanel";
import type { CompareView } from "../compare/compare-view";
import { resumeOnlyChip } from "../../talent-list";
import { ASK_INTRO, ASK_SOON, ASK_TITLE, COMPARE_MAX, answerPath, boardOrder, lookedAtLine, sourceWords, togglePick } from "./board-model";

/** A person named in an answer: initials and name in an outlined pill that opens their panel (its score styled from here). */
const PERSON_CHIP = "person-chip inline-flex min-h-9 max-w-full items-center gap-2 justify-self-start rounded-full border border-line-2 bg-surface py-1 ps-1 pe-3.5 text-left text-[14px] font-semibold text-ink transition-colors duration-150 ease-soft hover:border-line-tint hover:bg-tint pointer-coarse:min-h-10 [&>.person-chip-score]:font-normal [&>.person-chip-score]:text-ink-2 [&>.person-chip-score]:tabular-nums";
/** Lines up the questions and the picker under the assistant's message (its 32px mark and the gap beside it). */
const UNDER_MARK = "sm:ps-[42px]";

/**
 * "Ask about this pool" (plan F10; founder decision B5): one-click questions about the role's finished applications,
 * answered from the checked findings already on file, never by asking the AI anything new. Each answer names the people
 * it is about, as chips that open their panel, with why and the quotes it rests on, and a "Looked at" line saying what
 * was read. "Compare these" asks for up to five people first. Typing your own question is not offered yet, and the
 * panel says so in one line instead of showing a box that does nothing.
 *
 * It reads like the guided conversation (screenshot 3): the assistant's opening line as a bubble beside its sparkle,
 * the questions as reply rows, the question picked as the person's own bubble and the answer as the assistant's card.
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
    <Drawer open onClose={props.onClose} title={ASK_TITLE} sub="Answers come from the checked findings already on file." leading={<span className="ask-mark" aria-hidden="true"><IconChip icon="message-circle" /></span>}>
      <div className="grid gap-5">
        <div className="flex items-start gap-2.5">
          <IconChip icon="assistant" tone="peach" size="sm" />
          <p className="bubble assistant text-[14.5px]">{ASK_INTRO}</p>
        </div>
        {questions.isLoading ? <Skeleton lines={3} /> : questions.error ? <ErrorState message="Could not load the questions." onRetry={() => questions.refetch()} /> : (
          <fieldset className="ask-questions" aria-label="Questions you can ask">
            <div className={`grid gap-2 ${UNDER_MARK}`}>
              {(questions.data?.questions ?? []).map((q) => (
                <button key={q.id} type="button" className="suggestion min-h-11 w-full justify-start gap-2.5 rounded-xl px-4 py-2.5 text-[14px] aria-pressed:border-primary aria-pressed:bg-tint-2 aria-pressed:text-primary" aria-pressed={asked?.id === q.id} onClick={() => ask(q)}>
                  <Icon name={q.kind === "compare" ? "grid" : "search"} size={16} className="shrink-0" />
                  <span>{q.label}</span>
                </button>
              ))}
            </div>
          </fieldset>
        )}
        {asked?.kind === "compare" && !compareIds.length ? (
          <fieldset className={`grid gap-3 ${UNDER_MARK}`}>
            <legend className="mb-3 text-[14px] font-semibold text-ink">Choose up to {COMPARE_MAX} people to compare</legend>
            <div className="flex flex-wrap gap-2">
              {people.map((c) => {
                const on = picked.includes(c.applicationId);
                return (
                  <label key={c.applicationId} className="inline-flex min-h-10 max-w-full cursor-pointer items-center gap-2 rounded-[20px] border border-line-2 bg-surface py-1 ps-3 pe-3.5 text-[14px] font-medium text-ink transition-colors duration-150 ease-soft not-data-[checked=true]:hover:bg-surface-2 data-[checked=true]:border-primary data-[checked=true]:bg-tint-2 data-[checked=true]:text-primary has-disabled:cursor-not-allowed has-disabled:opacity-55" data-checked={on}>
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
        <div aria-live="polite">
          {path ? (
            answer.isLoading ? <Skeleton lines={4} /> : answer.error ? <ErrorState message="Could not answer that just now." onRetry={() => answer.refetch()} /> : answer.data ? (
              <AnswerView answer={answer.data} onOpen={props.onOpen} onShow={props.onShow} onCompareAgain={asked?.kind === "compare" ? () => setCompareIds([]) : null} />
            ) : null
          ) : null}
        </div>
        <p className="border-t border-line pt-4 text-[13px] text-ink-3">{ASK_SOON}</p>
      </div>
    </Drawer>
  );
}

/** " · Résumé only" after a person's score whose AI interview is not in it (R20-9); nothing once it is, or on an older answer. */
function personScoreNote(p: PoolAnswer["people"][number]) {
  const chip = resumeOnlyChip(p);
  return chip ? <span className="muted"> · {chip.label}</span> : null;
}

/** One answer: what was asked, the answer, the people (each opens their panel) with why and the quotes, and what was read. */
export function AnswerView(props: { answer: PoolAnswer; onOpen: (applicationId: string) => void; onShow: (applicationIds: string[], label: string) => void; onCompareAgain: (() => void) | null }) {
  const { answer } = props;
  // "Compare these" answers with the comparison view itself (pages/compare), the same table as the Talent page's Compare.
  const compare = answer.kind === "compare" ? (answer.compare as CompareView | undefined) : undefined;
  return (
    <section className="grid gap-3 motion-safe:animate-enter" aria-label={`Answer: ${answer.question}`}>
      {/* the question picked, as the person's own message */}
      <p className="bubble user justify-self-end text-[14.5px]">{answer.question}</p>
      <div className="flex items-start gap-2.5">
        <IconChip icon="assistant" tone="peach" size="sm" />
        <div className="grid min-w-0 flex-1 gap-4 rounded-2xl border border-line bg-surface p-4 shadow-xs sm:p-5">
          <p className="text-[15px] leading-relaxed text-ink">{answer.answer}</p>
          {answer.people.length && !compare ? (
            <ul className="grid gap-4">
              {answer.people.map((p) => (
                <li key={p.applicationId} className="grid gap-2">
                  <button type="button" className={PERSON_CHIP} onClick={() => props.onOpen(p.applicationId)}>
                    <Avatar name={p.name} size="sm" />
                    <span>{p.name}</span>
                    {/* R20-9: a score with no AI interview in it says so, the full label on hover */}
                    {p.score !== null ? <span className="person-chip-score" title={p.basis ?? undefined}>{p.score}<span className="sr-only"> out of 100</span>{personScoreNote(p)}</span> : null}
                  </button>
                  <p className="text-[14px] leading-snug text-ink-2">{p.why}</p>
                  {p.quotes.map((q) => (
                    <blockquote key={`${q.criterion}-${q.quote}`} className="rounded-e-xl border-s-2 border-primary bg-tint px-3.5 py-2.5 text-[14px] leading-snug text-ink-2">
                      “{q.quote}”
                      <span className="mt-1 block text-[12px] text-ink-3">{q.criterion} · {sourceWords(q.source)}</span>
                    </blockquote>
                  ))}
                </li>
              ))}
            </ul>
          ) : null}
          {compare ? (
            <>
              <div className="flex flex-wrap gap-2">
                {answer.people.map((p) => (
                  <button key={p.applicationId} type="button" className={PERSON_CHIP} onClick={() => props.onOpen(p.applicationId)}>
                    <Avatar name={p.name} size="sm" />
                    <span>{p.name}</span>
                  </button>
                ))}
              </div>
              <CompareTable data={compare} />
            </>
          ) : null}
          <p className="flex items-start gap-1.5 text-[13px] leading-snug text-ink-3"><Icon name="eye" size={14} className="mt-[3px] shrink-0" />{lookedAtLine(answer.lookedAt)}</p>
          <div className="row">
            {answer.applicationIds.length ? <Button size="sm" onClick={() => props.onShow(answer.applicationIds, answer.question)}>Show {answer.applicationIds.length === 1 ? "this person" : `these ${answer.applicationIds.length}`} on the board</Button> : null}
            {props.onCompareAgain ? <Button size="sm" variant="ghost" onClick={props.onCompareAgain}>Choose other people</Button> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
