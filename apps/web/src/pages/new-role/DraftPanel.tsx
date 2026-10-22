"use client";

import { useEffect, useState } from "react";
import { PACKET_VISIBILITY_LABEL, type DraftRolePacket, type IntakeFactsPatch, type IntakeSessionView, type PacketFlag, type PacketVisibility } from "@ros/contracts";
import { Alert, Avatar, Button, cn, Eyebrow, Field, Icon, IconButton, Segmented } from "@ros/ui";
import { DraftClosingDate } from "../../components/ClosingDate";
import { FactsEditor, type TeamPick } from "./FactsEditor";
import { BULLETS, DRAFT_H3, DRAFT_PART, DRAFT_PART_HEAD, PANE_HEIGHT, SEEN_TAG } from "./look";
import { PayCard } from "./PayCard";
import {
  basicsChips, draftOutOfDate, draftSections, draftTitle, isEmptySection, readinessList, redraftWarning, sectionOfPath,
  type DraftSection, type SectionId, type payPayload,
} from "./rules";
import { openFlags, proposalSections, rewordInstruction, suggestionsBySection, type PacketRevisionProposal, type RequirementSuggestion, type RequirementsCheck } from "./refine-api";

type Pay = NonNullable<ReturnType<typeof payPayload>>;

function SeenBy({ v }: { v: PacketVisibility }) {
  return <span className={SEEN_TAG}><Icon name={v === "public" || v === "asked" ? "eye" : "lock"} size={13} />{PACKET_VISIBILITY_LABEL[v]}</span>;
}

/**
 * The draft beside the conversation (plan C7, C8, C9, C15). Preview shows the job as it is taking shape: the title and its
 * facts, the pay card, then each section with who sees it, filling in from the answers until the draft is written and
 * from the draft after. A section that just changed is briefly highlighted; one a proposed change would touch is marked
 * and shows the proposed words. "What we know / still missing" stays at the top until everything needed is in. Edit is
 * the same answers as plain fields. Wording the fairness check flagged waits here for a person: change it, or keep it
 * with a reason. The requirements check's suggestions sit under the section they are about, with a one-tap fix.
 */
export function DraftPanel(props: {
  view: IntakeSessionView;
  companyName: string | null;
  team: TeamPick[];
  changed: SectionId[];
  proposal: PacketRevisionProposal | null;
  check: RequirementsCheck | null;
  onFix: (fixId: string) => void;
  fixing: string | null;
  onPatch: (patch: IntakeFactsPatch) => void;
  patching: boolean;
  patchError: string | null;
  patchDone: number;
  onPay: (pay: Pay) => void;
  paying: boolean;
  payError: string | null;
  onKeepFlag: (flagId: string, reason: string) => void;
  keepingFlag: string | null;
  onAsk: (instruction: string) => void;
  onRedraft: () => void;
  drafting: boolean;
  onPreview: () => void;
  /** The closing date (plan D7), kept on the draft until the role exists; null for someone who may not set it. */
  closing?: { value: string; onChange: (value: string) => void; required: boolean } | null;
}) {
  const { view } = props;
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [dismissed, setDismissed] = useState<string[]>([]);
  // A saved edit goes back to Preview, where the changed sections light up.
  useEffect(() => {
    if (props.patchDone) setMode("preview");
  }, [props.patchDone]);
  const title = draftTitle(view);
  const sections = draftSections(view);
  const proposed = proposalSections(props.proposal);
  const proposedSections = props.proposal?.packet ? draftSections({ facts: view.facts, draft: props.proposal.packet as DraftRolePacket }) : null;
  const checklist = readinessList(view.readiness);
  const flags = openFlags(view.flags);
  const suggestions = suggestionsBySection(props.check, dismissed);
  const nothingYet = !title && sections.every(isEmptySection) && !view.draft;
  const chips = basicsChips(view);
  const stale = draftOutOfDate(view);
  const flagsFor = (id: SectionId) => flags.filter((f) => sectionOfPath(f.path) === id);
  const dismiss = (id: string) => setDismissed([...dismissed, id]);

  return (
    // The draft beside the conversation (screenshot 3's "Role brief draft"): the same height, with its own scroll and a head that stays.
    <div className={cn("relative overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface shadow-xs", PANE_HEIGHT)}>
      <div className="sticky top-0 z-[5] flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3 sm:px-5">
        <Eyebrow as="span">Draft</Eyebrow>
        <Segmented value={mode} onChange={setMode} ariaLabel="Show the draft as" options={[{ value: "preview", label: "Preview" }, { value: "edit", label: "Edit" }]} />
        <span className="ml-auto">
          <IconButton icon="eye" label="See what candidates will see" onClick={props.onPreview} disabled={!view.draft} />
        </span>
      </div>
      <div className="grid min-w-0 gap-4 p-4 sm:p-5">
        {mode === "edit" ? (
          <FactsEditor
            // Fresh after a save only: the assistant's reply landing while someone edits must not wipe what they typed.
            // A save sends only the fields they changed, so whatever the assistant changed meanwhile is kept.
            key={props.patchDone}
            facts={view.facts}
            team={props.team}
            saving={props.patching}
            error={props.patchError}
            onSave={props.onPatch}
            onCancel={() => setMode("preview")}
          />
        ) : nothingYet ? (
          <div className="grid min-h-[300px] place-content-center justify-items-center gap-2 py-8 text-center text-[14px] text-ink-2">
            <Avatar name={props.companyName ?? "Your company"} tone="ink" shape="square" size="xl" letters={1} />
            <strong className="mt-2 font-display text-xl font-bold text-ink">{props.companyName ?? "Your company"}</strong>
            <p>The job will appear here as we shape it.</p>
          </div>
        ) : (
          <>
            {checklist.complete ? null : (
              // "What we know / still missing" as screenshot 3's snapshot: rows divided by hairlines
              <section className="grid gap-4 rounded-xl border border-line-tint bg-tint/60 p-4" aria-label="What we know and what is still missing">
                {checklist.known.length ? (
                  <div className="grid gap-1">
                    <h2 className="eyebrow">What we know</h2>
                    <ul className="divide-y divide-line">{checklist.known.map((i) => <li key={i.key} className="flex items-start gap-2.5 py-2 text-[14px]"><Icon name="check-circle" size={16} className="mt-0.5 shrink-0 text-good" /><span className="min-w-0"><strong>{i.label}:</strong> {i.value}{i.note ? <span className="muted"> {i.note}</span> : null}</span></li>)}</ul>
                  </div>
                ) : null}
                <div className="grid gap-1">
                  <h2 className="eyebrow">Still missing</h2>
                  <ul className="divide-y divide-line">{checklist.missing.map((i) => <li key={i.key} className="flex items-start gap-2.5 py-2 text-[14px]"><span className="mt-[3px] size-4 shrink-0 rounded-full border-[1.5px] border-dashed border-line-strong" aria-hidden="true" /><span className="min-w-0"><strong>{i.label}</strong>{i.value ? `: ${i.value}` : ""}{i.note ? <span className="muted"> {i.note}</span> : null}</span></li>)}</ul>
                </div>
              </section>
            )}

            {stale ? <RedraftAlert warning={redraftWarning(view.readiness)} drafting={props.drafting} onRedraft={props.onRedraft} /> : null}

            {flags.length ? (
              <section className="grid gap-3 rounded-xl border border-caution-dot/50 bg-caution-soft p-4" aria-label="Wording to check before approval">
                <h2 className="flex items-center gap-2 font-display text-[16px] font-bold text-caution"><Icon name="flag" size={16} />Check this wording before asking for approval</h2>
                {flags.map((f) => <WordingFlag key={f.id} flag={f} onAsk={props.onAsk} onKeep={props.onKeepFlag} keeping={props.keepingFlag === f.id} />)}
              </section>
            ) : null}

            {/* the title and its facts, like the brief card's head: no box, a large title, the facts as chips */}
            <header className="-mx-2 grid gap-3 rounded-xl px-2 py-2 transition-colors duration-200 ease-soft data-[changed=true]:bg-tint data-[proposed=true]:bg-peach/50" data-changed={props.changed.includes("basics") ? "true" : undefined} data-proposed={proposed.includes("basics") ? "true" : undefined}>
              <div className={DRAFT_PART_HEAD}>
                <h2 className={cn("min-w-0 font-display text-[26px] font-bold leading-[1.1] tracking-[-0.03em] wrap-anywhere", !title && "text-ink-3")}>{title ?? "Untitled role"}</h2>
                <SeenBy v="public" />
              </div>
              <ul className="flex flex-wrap gap-1.5" aria-label="About this job">
                {chips.map((c) => (
                  <li key={c.name} className={c.missing ? "chip min-h-7 max-w-full border-dashed border-line-strong bg-transparent px-2.5 text-[12.5px] whitespace-normal wrap-anywhere text-ink-3" : "chip accent min-h-7 max-w-full px-2.5 text-[12.5px] whitespace-normal wrap-anywhere"}>
                    <Icon name={c.icon} size={14} />
                    <span className="sr-only">{c.name}: </span>
                    {c.text}
                  </li>
                ))}
              </ul>
            </header>

            <section className={DRAFT_PART} aria-labelledby="draft-pay-h">
              <div className={DRAFT_PART_HEAD}>
                <h3 id="draft-pay-h" className={DRAFT_H3}>Pay</h3>
                <span className={SEEN_TAG}><Icon name="eye" size={13} />Candidates see the range; only your team sees the most you would pay</span>
              </div>
              <PayCard key={JSON.stringify([view.pay.basis, view.pay.stated, !!view.pay.confirmed])} card={view.pay} onSave={props.onPay} saving={props.paying} error={props.payError} />
            </section>

            {props.closing ? (
              <section className={DRAFT_PART} aria-labelledby="draft-closes-h">
                <div className={DRAFT_PART_HEAD}>
                  <h3 id="draft-closes-h" className={DRAFT_H3}>When applications close</h3>
                  <SeenBy v="public" />
                </div>
                <DraftClosingDate value={props.closing.value} onChange={props.closing.onChange} required={props.closing.required} />
              </section>
            ) : null}

            {sections.filter((s) => s.id !== "basics").map((s) => (
              <SectionView
                key={s.id}
                s={s}
                proposedVersion={proposed.includes(s.id) ? proposedSections?.find((p) => p.id === s.id) ?? null : null}
                proposed={proposed.includes(s.id)}
                changed={props.changed.includes(s.id)}
                flags={flagsFor(s.id).length}
                suggestions={suggestions.get(s.id) ?? []}
                onFix={props.onFix}
                fixing={props.fixing}
                onDismiss={dismiss}
              />
            ))}
            {suggestions.get("other")?.length ? (
              <section className={DRAFT_PART} aria-label="Other suggestions">
                <div className={DRAFT_PART_HEAD}><h3 className={DRAFT_H3}>Other suggestions</h3><SeenBy v="internal" /></div>
                {suggestions.get("other")!.map((s) => <SuggestionCard key={s.id} s={s} onFix={props.onFix} fixing={props.fixing} onDismiss={dismiss} />)}
              </section>
            ) : null}

            {view.draft?.provenance.assumptions.length ? (
              <section className={DRAFT_PART}>
                <div className={DRAFT_PART_HEAD}><h3 className={DRAFT_H3}>What the assistant assumed</h3><SeenBy v="internal" /></div>
                <ul className={BULLETS}>{view.draft.provenance.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
                <p className="small muted">Check these, and change anything that is not right before you ask for approval.</p>
              </section>
            ) : null}
            {view.facts.declinedCriteria.length ? (
              <section className={DRAFT_PART}>
                <div className={DRAFT_PART_HEAD}><h3 className={DRAFT_H3}>Not used, and why</h3><SeenBy v="internal" /></div>
                <ul className={BULLETS}>{view.facts.declinedCriteria.map((d) => <li key={d.requested}><strong>"{d.requested}"</strong>: {d.reason}{d.alternative ? ` ${d.alternative}` : ""}</li>)}</ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Answers changed after the draft was written: it can be written again with them. When changes were saved on the draft
 * since (by asking, or with a fix), the first press says they would be replaced and a second press confirms.
 */
function RedraftAlert(props: { warning: string | null; drafting: boolean; onRedraft: () => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <Alert tone="info">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>You changed some answers after the draft was written. Ask for approval once the draft has them.</span>
          {asking ? null : <Button size="sm" loading={props.drafting} onClick={() => (props.warning ? setAsking(true) : props.onRedraft())}>Write it again with them</Button>}
        </div>
        {asking && props.warning ? (
          <>
            <span>{props.warning}</span>
            <div className="row">
              <Button size="sm" variant="primary" loading={props.drafting} onClick={() => { setAsking(false); props.onRedraft(); }}>Write it again</Button>
              <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>Not now</Button>
            </div>
          </>
        ) : null}
      </div>
    </Alert>
  );
}

/** One section: its heading, who sees it, the words (or the proposed words, marked), and any suggestions about it. */
function SectionView(props: { s: DraftSection; proposedVersion: DraftSection | null; proposed: boolean; changed: boolean; flags: number; suggestions: RequirementSuggestion[]; onFix: (fixId: string) => void; fixing: string | null; onDismiss: (id: string) => void }) {
  const { s } = props;
  const shown = props.proposedVersion ?? s;
  const headId = `draft-${s.id}-h`;
  return (
    <section className={DRAFT_PART} aria-labelledby={headId} data-changed={props.changed ? "true" : undefined} data-proposed={props.proposed ? "true" : undefined}>
      <div className={DRAFT_PART_HEAD}>
        <h3 id={headId} className={DRAFT_H3}>{s.title}</h3>
        <SeenBy v={s.visibility} />
      </div>
      {props.proposed ? <p className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-warm"><Icon name="sparkle" size={13} />{props.proposedVersion ? "Proposed change, not saved yet" : "A proposed change touches this part"}</p> : null}
      {isEmptySection(shown) ? (
        s.empty ? <p className="muted small">{s.empty}</p> : null
      ) : shown.text ? (
        <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink">{shown.text}</p>
      ) : (
        <ul className={BULLETS}>{shown.items.map((t, i) => <li key={`${i}-${t}`}>{t}</li>)}</ul>
      )}
      {props.flags ? <p className="small inline-flex items-center gap-1.5 text-caution"><Icon name="flag" size={13} /> Wording in this part needs a decision (above).</p> : null}
      {props.suggestions.map((sg) => <SuggestionCard key={sg.id} s={sg} onFix={props.onFix} fixing={props.fixing} onDismiss={props.onDismiss} />)}
    </section>
  );
}

/**
 * One suggestion from the requirements check (C16): what it is about, why, and its fixes, each one tap (take it out,
 * reword it, ask about it in the interview instead). "Leave it" keeps the words as they are. It never scores anyone.
 */
export function SuggestionCard(props: { s: RequirementSuggestion; onFix: (fixId: string) => void; fixing: string | null; onDismiss: (id: string) => void }) {
  const { s } = props;
  return (
    // a suggestion, set apart like screenshot 3's suggested review order: a lavender note with its one-tap fixes
    <div className="flex min-w-0 gap-3 rounded-xl border border-line-tint bg-tint/70 p-3.5 text-[14px]">
      <Icon name="info" size={16} className="mt-0.5 shrink-0 text-info" />
      <div className="grid min-w-0 flex-1 gap-1.5">
        <p className="wrap-anywhere"><strong>{s.title}:</strong> "{s.text}"</p>
        <p className="small text-ink-2">{s.why}</p>
        <div className="row mt-1">
          {s.fixes.map((f) => <Button key={f.id} size="sm" loading={props.fixing === f.id} disabled={!!props.fixing && props.fixing !== f.id} onClick={() => props.onFix(f.id)}>{f.label}</Button>)}
          <Button size="sm" variant="ghost" onClick={() => props.onDismiss(s.id)}>Leave it</Button>
        </div>
      </div>
    </div>
  );
}

/** A phrase the fairness check flagged: change the wording (shown as a proposed change first), or keep it with a reason. */
function WordingFlag(props: { flag: PacketFlag; onAsk: (instruction: string) => void; onKeep: (flagId: string, reason: string) => void; keeping: boolean }) {
  const { flag } = props;
  const [keeping, setKeeping] = useState(false);
  const [reason, setReason] = useState("");
  const id = `keep-${flag.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return (
    <div className="grid min-w-0 gap-2 rounded-xl border border-line bg-surface p-3.5 text-[14px] text-ink">
      <p className="wrap-anywhere"><strong>"{flag.text}"</strong> {flag.reason}</p>
      {flag.alternative ? <p className="small text-ink-2">Instead: {flag.alternative}</p> : null}
      {flag.declined ? <p className="small muted">You were told earlier this could not be used.</p> : null}
      {keeping ? (
        <div className="grid gap-1.5">
          <Field label="Why keep it? (whoever approves the role sees this)" htmlFor={id}><input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Required by our state licence board" /></Field>
          <div className="row">
            <Button size="sm" variant="primary" disabled={reason.trim().length < 5} loading={props.keeping} onClick={() => props.onKeep(flag.id, reason.trim())}>Keep it, with this reason</Button>
            <Button size="sm" variant="ghost" onClick={() => setKeeping(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="row">
          <Button size="sm" variant="primary" onClick={() => props.onAsk(rewordInstruction(flag))}>Change the wording</Button>
          <Button size="sm" onClick={() => setKeeping(true)}>Keep it…</Button>
        </div>
      )}
    </div>
  );
}
