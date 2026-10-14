"use client";

import { Avatar, Button, Chip, cx, EmptyState, Eyebrow, Icon, Segmented } from "@ros/ui";
import type { BoardCard, BoardView } from "../../api/client";
import { Link } from "../../nav";
import { AskRecruiter } from "../../components/AskRecruiter";
import { BOARD_COLUMNS, RECRUITER_CHECK, SORT_TEXT, SORT_TITLE, cardChip, cardFacts, confidenceChip, evidenceLines, headerCounts, reasonLine, scoreText, sortedText, summarySentences, type TalentMode } from "./board-model";

/**
 * The strip above the Candidates list and board (plan F6; Wave S1): what "Sort the pool" does, in one line, its button
 * and the Board / List switch. On the list the button opens the board; on the board it sorts again (the board is
 * worked out afresh from the stored evidence every time). Nothing moves and nothing is sent from here.
 */
export function SortStrip(props: { mode: TalentMode; onMode: (mode: TalentMode) => void; onSort: () => void; sorting: boolean; generatedAt: string | null }) {
  const board = props.mode === "board";
  return (
    <section className="sort-strip" aria-label={SORT_TITLE}>
      <span className="sort-strip-mark" aria-hidden="true"><Icon name="assistant" size={18} /></span>
      <p className="sort-strip-text">
        <span>{board ? sortedText(props.generatedAt) : SORT_TEXT}</span>
      </p>
      <div className="sort-strip-actions">
        <Segmented ariaLabel="Show as" value={props.mode} onChange={props.onMode} options={[{ value: "board", label: "Board" }, { value: "list", label: "List" }]} />
        {board ? <Button icon="refresh" loading={props.sorting} onClick={props.onSort}>Sort again</Button> : <Button variant="primary" icon="assistant" onClick={props.onSort}>{SORT_TITLE}</Button>}
      </div>
    </section>
  );
}

/**
 * The pool board (plan F6, F7; founder decisions B2, B4): a header with the counts and the two ways in (the one-click
 * questions and Review and apply), the summary in plain words with up to three next steps naming people, then three
 * columns, Shortlist, Longlist and Not moving forward, one card per person with the match score, a chip, the reason,
 * two strengths and the gap with where each came from, and the step the board suggests. It suggests only: a person
 * applies it in Review and apply, privately. On a phone the columns stack.
 */
export function PoolBoard(props: { roleId: string; board: BoardView; only: { ids: string[]; label: string } | null; onClearOnly: () => void; onOpen: (applicationId: string) => void; onReview: () => void; onAsk: () => void; mayApply: boolean }) {
  const { board } = props;
  const s = board.summary;
  const only = props.only ? new Set(props.only.ids) : null;
  const cardsOf = (column: (typeof BOARD_COLUMNS)[number]["id"]) => board.columns[column].filter((c) => !only || only.has(c.applicationId));
  const sentences = summarySentences(s);
  const anyone = s.total > 0 || board.stillApplying.length > 0;
  return (
    <div className="pool-board">
      <div className="board-head">
        <div className="board-head-title">
          <Eyebrow>Board</Eyebrow>
          {/* focusable from code only: it takes the focus when Review and apply closes with nothing left to apply */}
          <h2 id="board-title" tabIndex={-1}>{board.role.title}</h2>
          <p className="board-counts">{headerCounts(s)}</p>
        </div>
        <div className="board-head-actions">
          <AskRecruiter roleId={props.roleId} label="Have a recruiter check this" preset={{ kind: "review", question: RECRUITER_CHECK }} />
          <Button icon="assistant" onClick={props.onAsk} disabled={!s.total}>Ask about this pool</Button>
          {props.mayApply ? <Button variant="primary" disabled={!s.toSort} title={s.toSort ? undefined : "Nothing to apply right now"} onClick={props.onReview}>Review and apply {s.toSort}</Button> : null}
        </div>
      </div>
      {!anyone ? (
        <EmptyState icon="talent" title="Nobody to sort yet" body="People appear on the board once they have finished applying. Nothing is sorted or sent until then." />
      ) : (
        <>
          <section className="pool-summary" aria-label="Summary of the pool">
            <div className="pool-summary-part">
              <h3>What the pool looks like</h3>
              <p>{sentences.join(" ")}</p>
              {s.stricter ? <p className="pool-stricter">{s.stricter.words} <Link to={s.stricter.editPath}>Look at the must-haves</Link></p> : null}
            </div>
            <div className="pool-summary-part">
              <h3>Suggested next steps</h3>
              {s.nextSteps.length ? (
                <ul className="pool-steps">
                  {s.nextSteps.map((step) => (
                    <li key={step.applicationId}>
                      <span className="next-step-tag">{step.label}</span>
                      <span><button type="button" className="link-btn" onClick={() => props.onOpen(step.applicationId)}>{step.name}</button>: {step.reason}</span>
                    </li>
                  ))}
                </ul>
              ) : <p>Nothing waits on a next step right now.</p>}
            </div>
          </section>
          {props.only ? (
            <div className="row">
              <button type="button" className="toggle-chip" aria-pressed="true" aria-label={`Showing only the people from "${props.only.label}". Show everyone`} onClick={props.onClearOnly}>
                Showing {props.only.ids.length} from "{props.only.label}" <Icon name="x" size={14} />
              </button>
            </div>
          ) : null}
          <div className="board-columns">
            {BOARD_COLUMNS.map((c) => {
              const cards = cardsOf(c.id);
              return (
                <section key={c.id} className="board-col" data-column={c.id} aria-labelledby={`board-col-${c.id}`}>
                  <header className="board-col-head">
                    <h3 id={`board-col-${c.id}`}>{c.title} <span className="count">{cards.length}</span></h3>
                    <p className="board-col-sub">{c.sub}</p>
                  </header>
                  {cards.length ? (
                    <ul className="board-cards">
                      {cards.map((card) => <BoardCardView key={card.applicationId} card={card} onOpen={props.onOpen} />)}
                    </ul>
                  ) : <p className="board-col-empty">Nobody here{only ? " from this question" : " yet"}.</p>}
                </section>
              );
            })}
          </div>
          {board.stillApplying.length ? (
            <p className="small muted">
              {board.stillApplying.length === 1 ? "1 more person is" : `${board.stillApplying.length} more people are`} still applying: {board.stillApplying.map((c) => c.name).join(", ")}. They join the board when they finish.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * One person on the board. The name opens their panel; everything else is read-only: the score, the state chip and
 * the reading's own confidence, the reason, the must-have line, what the score rests on, a reading made against an
 * earlier version, what already happened, two strengths and the gap, and the next step.
 */
function BoardCardView({ card, onOpen }: { card: BoardCard; onOpen: (applicationId: string) => void }) {
  const chip = cardChip(card);
  const confidence = confidenceChip(card);
  const score = scoreText(card.score?.score);
  const lines = evidenceLines(card);
  const facts = cardFacts(card);
  const next = card.placement.state === "suggested" ? card.placement.nextStep : null;
  return (
    <li className="board-card" data-state={card.placement.state}>
      <div className="board-card-top">
        <Avatar name={card.name} />
        <div className="board-card-who">
          <button type="button" className="board-card-name" onClick={() => onOpen(card.applicationId)}>{card.name}</button>
          <span className="board-card-score">
            <span className={cx("dot", score.tone)} aria-hidden="true" />
            <span className="sr-only">{score.label}</span>
            <span aria-hidden="true">{score.text}</span>
            {card.score?.coverage && card.score.score !== null ? <span className="board-card-coverage">{card.score.coverage.words}</span> : null}
          </span>
        </div>
      </div>
      <div className="board-card-chips">
        <Chip tone={chip.tone} icon={chip.done ? "check" : undefined}>{chip.label}</Chip>
        {chip.done && chip.title ? <span className="board-card-done">{chip.title}</span> : null}
        {confidence ? <Chip tone={confidence.tone}>{confidence.label}</Chip> : null}
      </div>
      <p className="board-card-reason">{reasonLine(card)}</p>
      {facts.length ? (
        <ul className="board-card-facts">
          {facts.map((f) => <li key={f}>{f}</li>)}
        </ul>
      ) : null}
      {lines.length ? (
        <ul className="evidence-lines">
          {lines.map((l) => (
            <li key={`${l.kind}-${l.text}`} data-kind={l.kind}>
              <Icon name={l.kind === "strength" ? "check" : "minus"} size={14} />
              <span>
                <span className="sr-only">{l.kind === "strength" ? "Strength: " : "Gap: "}</span>
                {l.text} <span className="evidence-source">· {l.source}{l.quoted ? "" : ", no quote"}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {next ? (
        <p className="next-step">
          <span className="next-step-tag">{next.label}</span>
          <span>{next.reason}</span>
        </p>
      ) : null}
    </li>
  );
}
