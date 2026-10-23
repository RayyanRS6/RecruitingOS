"use client";

import { m } from "motion/react";
import { Avatar, Button, Chip, cn, EmptyState, Icon, Segmented } from "@ros/ui";
import type { BoardCard, BoardView } from "../../api/client";
import { Link } from "../../nav";
import { AskRecruiter } from "../../components/AskRecruiter";
import { BOARD_COLUMNS, NO_AI_INTERVIEW_LANE, RECRUITER_CHECK, SORT_TEXT, SORT_TITLE, cardChip, cardFacts, confidenceChip, evidenceLines, headerCounts, laneRow, reasonLine, scoreText, sortedText, summarySentences, type TalentMode } from "./board-model";

/** A column: a soft rounded lane on the warm sunken grey; the three appear one after another (motion-safe, CSS only).
 *  It may shrink to its track (min-w-0), so a long chip wraps inside its card instead of pushing the lane wider.
 *  board-col is a hook for tests and e2e (no CSS). */
const LANE = "board-col grid min-w-0 content-start gap-3 rounded-2xl border border-line bg-surface-2 p-3 sm:p-4 motion-safe:animate-enter motion-safe:[animation-fill-mode:backwards]";
/** The columns' entrance, 40ms apart (full class strings: Tailwind sees only whole words). */
const LANE_DELAY = ["", "motion-safe:[animation-delay:40ms]", "motion-safe:[animation-delay:80ms]"];
/**
 * A lane's heading: a mono label with its count in a small pill (the space before the count keeps "Shortlist 2" two
 * words). What puts someone in the lane is its title (founder, 23 Oct 2026: no line under it; each card says its reason).
 */
const LANE_TITLE = "px-1 pt-0.5 font-mono text-[11.5px] font-normal uppercase leading-6 tracking-[0.12em] text-ink-2";
const LANE_COUNT = "ms-1.5 inline-flex min-w-6 items-center justify-center rounded-full bg-surface px-2 align-[1px] font-sans text-[12px] font-semibold leading-5 tracking-normal text-ink-2 tabular-nums shadow-[0_0_0_1px_var(--line)]";
/** One person: a surface card on the lane; a card that is done or waiting rests flatter. Above the lane's fill while it
 *  glides. board-card, and board-card-score and board-card-facts inside it, are hooks for tests and e2e (no CSS). */
const CARD = "board-card relative z-[1] grid min-w-0 gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs transition-[border-color,box-shadow] duration-150 ease-soft hover:border-line-2 hover:shadow-sm data-[state=done]:bg-surface/70 data-[state=done]:shadow-none data-[state=waiting]:shadow-none";
/** The name (a button that opens the panel, its class pinned by tests) and the line under it, styled from the wrapper. */
const WHO = "grid min-w-0 gap-0.5 text-[15px] font-semibold leading-snug text-ink [&>.board-card-name]:justify-self-start [&>.board-card-name]:rounded-sm [&>.board-card-name]:text-left [&>.board-card-name]:[overflow-wrap:anywhere] [&>.board-card-name]:hover:text-primary pointer-coarse:[&>.board-card-name]:min-h-10";
/** A card that changes column glides to its new place (shared layout); reduced motion makes it instant (MotionConfig). */
const GLIDE = { duration: 0.3, ease: [0.22, 1, 0.36, 1] } as const;

/** "Sorted at 4:42 AM": when the board was worked out, as state (sortedText's opening words; the whole sentence is its title). */
function sortedAt(generatedAt: string | null): string | null {
  const at = generatedAt ? new Date(generatedAt) : null;
  return at && !Number.isNaN(at.getTime()) ? `Sorted at ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : null;
}

/**
 * The bar above the Candidates list and board (plan F6; Wave S1): the Board / List switch, on the board the time it was
 * sorted, and one button. On the list the button opens the board; on the board it sorts again (the board is worked out
 * afresh from the stored evidence every time). Nothing moves and nothing is sent from here: what sorting does, and that
 * promise, are the button's title (founder, 23 Oct 2026: no sentence in the bar).
 */
export function SortStrip(props: { mode: TalentMode; onMode: (mode: TalentMode) => void; onSort: () => void; sorting: boolean; generatedAt: string | null }) {
  const board = props.mode === "board";
  const at = board ? sortedAt(props.generatedAt) : null;
  return (
    // sort-strip is a hook for tests (no CSS)
    <section className="sort-strip flex flex-wrap items-center justify-between gap-x-4 gap-y-2" aria-label={SORT_TITLE}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented ariaLabel="Show as" value={props.mode} onChange={props.onMode} options={[{ value: "board", label: "Board" }, { value: "list", label: "List" }]} />
        {at ? <span className="text-[13px] text-ink-3 tabular-nums" title={sortedText(props.generatedAt)}>{at}</span> : null}
      </div>
      {board ? <Button icon="refresh" loading={props.sorting} title={SORT_TEXT} onClick={props.onSort}>Sort again</Button> : <Button variant="primary" icon="assistant" title={SORT_TEXT} onClick={props.onSort}>{SORT_TITLE}</Button>}
    </section>
  );
}

/**
 * The pool board (plan F6, F7; founder decisions B2, B4): a header with the counts and the two ways in (the one-click
 * questions and Review and apply), the summary in plain words with up to three next steps naming people, then three
 * columns, Shortlist, Longlist and Not moving forward, one card per person with the match score, a chip, the reason,
 * two strengths and the gap with where each came from, and the step the board suggests. It suggests only: a person
 * applies it in Review and apply, privately. Below them, the read-only lane "No AI interview yet" (R20-7): name, where
 * they stand, when they applied, no score until the AI interview, never in Review and apply. On a phone the columns stack.
 */
export function PoolBoard(props: { roleId: string; board: BoardView; only: { ids: string[]; label: string } | null; onClearOnly: () => void; onOpen: (applicationId: string) => void; onReview: () => void; onAsk: () => void; mayApply: boolean }) {
  const { board } = props;
  const s = board.summary;
  const only = props.only ? new Set(props.only.ids) : null;
  const cardsOf = (column: (typeof BOARD_COLUMNS)[number]["id"]) => board.columns[column].filter((c) => !only || only.has(c.applicationId));
  const sentences = summarySentences(s);
  // The read-only lane (R20-7): an older answer without `noAiInterview` still has the same people as `stillApplying`.
  const lane = (board.noAiInterview ?? board.stillApplying).filter((c) => !only || only.has(c.applicationId)).map((c) => laneRow(c));
  const anyone = s.total > 0 || lane.length > 0;
  return (
    // pool-board is a hook: AppShell widens the page for it (no CSS of its own)
    <div className="pool-board grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        {/* The board's heading is its counts, "Board" said to a screen reader only: the job's title is the page's h1 above.
            Focusable from code only: it takes the focus when Review and apply closes with nothing left to apply. */}
        <h2 id="board-title" tabIndex={-1} className="min-w-0 rounded-sm font-sans text-[15px] font-semibold leading-snug tracking-normal text-ink tabular-nums">
          <span className="sr-only">Board: </span>
          <span>{headerCounts(s)}</span>
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <AskRecruiter roleId={props.roleId} label="Have a recruiter check this" preset={{ kind: "review", question: RECRUITER_CHECK }} />
          <Button icon="assistant" onClick={props.onAsk} disabled={!s.total}>Ask about this pool</Button>
          {props.mayApply ? <Button variant="primary" disabled={!s.toSort} title={s.toSort ? undefined : "Nothing to apply right now"} onClick={props.onReview}>Review and apply {s.toSort}</Button> : null}
        </div>
      </div>
      {!anyone ? (
        <EmptyState icon="talent" title="Nobody to sort yet" />
      ) : (
        <>
          {/* the hiring snapshot: two plain parts side by side on a wide screen, one under the other below it */}
          <section className="grid gap-x-8 gap-y-6 rounded-2xl border border-line bg-surface p-5 shadow-xs sm:p-6 lg:grid-cols-2" aria-label="Summary of the pool">
            <div className="grid content-start gap-3">
              <h3 className="eyebrow">What the pool looks like</h3>
              <p className="text-[15px] leading-relaxed text-ink">{sentences.join(" ")}</p>
              {s.stricter ? <p className="rounded-xl border border-line-tint bg-tint px-3.5 py-2.5 text-[14px] text-ink-2">{s.stricter.words} <Link to={s.stricter.editPath}>Look at the must-haves</Link></p> : null}
            </div>
            <div className="grid content-start gap-3 lg:border-s lg:border-line lg:ps-8">
              <h3 className="eyebrow">Suggested next steps</h3>
              {s.nextSteps.length ? (
                <ul className="grid divide-y divide-line">
                  {s.nextSteps.map((step) => (
                    <li key={step.applicationId} className="flex items-start gap-3 py-2.5 text-[14px] leading-snug text-ink-2 first:pt-0 last:pb-0">
                      <Chip tone="accent" className="mt-px shrink-0">{step.label}</Chip>
                      <span className="min-w-0"><button type="button" className="link-btn" onClick={() => props.onOpen(step.applicationId)}>{step.name}</button>: {step.reason}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-[14px] text-ink-2">Nothing waits on a next step right now.</p>}
            </div>
          </section>
          {props.only ? (
            <div className="row">
              <button type="button" className="toggle-chip max-w-full whitespace-normal text-left" aria-pressed="true" aria-label={`Showing only the people from "${props.only.label}". Show everyone`} onClick={props.onClearOnly}>
                Showing {props.only.ids.length} from "{props.only.label}" <Icon name="x" size={14} />
              </button>
            </div>
          ) : null}
          <div className="grid items-start gap-4 lg:grid-cols-3">
            {BOARD_COLUMNS.map((c, i) => {
              const cards = cardsOf(c.id);
              return (
                <section key={c.id} className={cn(LANE, LANE_DELAY[i])} data-column={c.id} aria-labelledby={`board-col-${c.id}`}>
                  <h3 id={`board-col-${c.id}`} className={LANE_TITLE} title={c.sub}>{c.title} <span className={LANE_COUNT}>{cards.length}</span></h3>
                  {cards.length ? (
                    <ul className="grid min-w-0 gap-3">
                      {cards.map((card) => <BoardCardView key={card.applicationId} card={card} onOpen={props.onOpen} />)}
                    </ul>
                  ) : <p className="rounded-xl border border-dashed border-line-2 px-4 py-6 text-center text-[13px] text-ink-3">Nobody here{only ? " from this question" : " yet"}.</p>}
                </section>
              );
            })}
          </div>
          {lane.length ? (
            <section className={cn(LANE, "motion-safe:[animation-delay:120ms]")} data-column="no_ai_interview" aria-labelledby="board-col-no-ai-interview">
              <h3 id="board-col-no-ai-interview" className={LANE_TITLE} title={NO_AI_INTERVIEW_LANE.sub}>{NO_AI_INTERVIEW_LANE.title} <span className={LANE_COUNT}>{lane.length}</span></h3>
              <ul className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {lane.map((row) => (
                  <m.li key={row.id} layout="position" layoutId={`board-card-${row.id}`} transition={GLIDE} className={CARD} data-state="waiting">
                    <div className="flex items-start gap-3">
                      <Avatar name={row.name} />
                      <div className={WHO}>
                        <button type="button" className="board-card-name" onClick={() => props.onOpen(row.id)}>{row.name}</button>
                        <span className="text-[13px] font-normal text-ink-3">{row.applied}</span>
                      </div>
                    </div>
                    <p className="text-[14px] leading-snug text-ink-2">{row.state}</p>
                  </m.li>
                ))}
              </ul>
            </section>
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
    <m.li layout="position" layoutId={`board-card-${card.applicationId}`} transition={GLIDE} className={CARD} data-state={card.placement.state}>
      <div className="flex items-start gap-3">
        <Avatar name={card.name} />
        <div className={WHO}>
          <button type="button" className="board-card-name" onClick={() => onOpen(card.applicationId)}>{card.name}</button>
          {/* board-card-score: a hook for e2e (no CSS) */}
          <span className="board-card-score inline-flex flex-wrap items-center gap-x-1.5 text-[13px] font-normal text-ink-2">
            <span className={cn("dot", score.tone)} aria-hidden="true" />
            <span className="sr-only">{score.label}</span>
            <span aria-hidden="true" className="font-semibold text-ink tabular-nums">{score.text}</span>
            {card.score?.coverage && card.score.score !== null ? <span className="text-ink-3">{card.score.coverage.words}</span> : null}
          </span>
        </div>
      </div>
      {/* the kit's chip stays on one line; here a long one ("Missing must-have: …") wraps inside the card. Styled from this
          wrapper, not a className on each Chip: tests pin the chips' class strings byte for byte. */}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 [&_.chip]:max-w-full [&_.chip]:whitespace-normal">
        <Chip tone={chip.tone} icon={chip.done ? "check" : undefined}>{chip.label}</Chip>
        {chip.done && chip.title ? <span className="text-[12px] font-medium text-ink-2">{chip.title}</span> : null}
        {confidence ? <Chip tone={confidence.tone}>{confidence.label}</Chip> : null}
      </div>
      <p className="text-[14px] leading-snug text-ink">{reasonLine(card)}</p>
      {/* board-card-facts: a hook for e2e (no CSS) */}
      {facts.length ? (
        <ul className="board-card-facts grid list-disc gap-0.5 ps-4 text-[12.5px] leading-snug text-ink-3 marker:text-line-strong">
          {facts.map((f) => <li key={f}>{f}</li>)}
        </ul>
      ) : null}
      {lines.length ? (
        <ul className="grid gap-1.5 text-[13px] leading-snug text-ink-2">
          {lines.map((l) => (
            <li key={`${l.kind}-${l.text}`} data-kind={l.kind} className="flex items-start gap-2">
              <Icon name={l.kind === "strength" ? "check" : "minus"} size={14} className={l.kind === "strength" ? "mt-[3px] text-good" : "mt-[3px] text-ink-3"} />
              <span className="min-w-0">
                <span className="sr-only">{l.kind === "strength" ? "Strength: " : "Gap: "}</span>
                {l.text} <span className="text-ink-3">· {l.source}{l.quoted ? "" : ", no quote"}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {next ? (
        <p className="flex flex-wrap items-start gap-x-2 gap-y-1.5 border-t border-line pt-3 text-[13px] leading-snug text-ink-2">
          <Chip tone="accent" className="max-w-full whitespace-normal">{next.label}</Chip>
          <span className="min-w-0 flex-[1_1_7rem] pt-px">{next.reason}</span>
        </p>
      ) : null}
    </m.li>
  );
}
