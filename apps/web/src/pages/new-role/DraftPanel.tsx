"use client";

import { useEffect, useState } from "react";
import { PACKET_VISIBILITY_LABEL, type DraftRolePacket, type IntakeFactsPatch, type IntakeSessionView, type PacketFlag, type PacketVisibility } from "@ros/contracts";
import { Alert, Avatar, Button, Eyebrow, Field, Icon, IconButton, Segmented } from "@ros/ui";
import { DraftClosingDate } from "../../components/ClosingDate";
import { FactsEditor, type TeamPick } from "./FactsEditor";
import { PayCard } from "./PayCard";
import {
  basicsChips, draftOutOfDate, draftSections, draftTitle, isEmptySection, readinessList, redraftWarning, sectionOfPath,
  type DraftSection, type SectionId, type payPayload,
} from "./rules";
import { openFlags, proposalSections, rewordInstruction, suggestionsBySection, type PacketRevisionProposal, type RequirementSuggestion, type RequirementsCheck } from "./refine-api";

type Pay = NonNullable<ReturnType<typeof payPayload>>;

function SeenBy({ v }: { v: PacketVisibility }) {
  return <span className="seen-by"><Icon name={v === "public" || v === "asked" ? "eye" : "lock"} size={13} />{PACKET_VISIBILITY_LABEL[v]}</span>;
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
    <div className="draft">
      <div className="draft-head">
        <Eyebrow as="span">Draft</Eyebrow>
        <Segmented value={mode} onChange={setMode} ariaLabel="Show the draft as" options={[{ value: "preview", label: "Preview" }, { value: "edit", label: "Edit" }]} />
        <span className="draft-head-end">
          <IconButton icon="eye" label="See what candidates will see" onClick={props.onPreview} disabled={!view.draft} />
        </span>
      </div>
      <div className="draft-body">
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
          <div className="draft-empty">
            <Avatar name={props.companyName ?? "Your company"} tone="ink" shape="square" size="xl" letters={1} />
            <strong>{props.companyName ?? "Your company"}</strong>
            <p>The job will appear here as we shape it.</p>
          </div>
        ) : (
          <>
            {checklist.complete ? null : (
              <section className="checklist" aria-label="What we know and what is still missing">
                {checklist.known.length ? (
                  <div>
                    <h2>What we know</h2>
                    <ul>{checklist.known.map((i) => <li key={i.key}><Icon name="check-circle" size={16} className="ok" /><span><strong>{i.label}:</strong> {i.value}{i.note ? <span className="muted"> {i.note}</span> : null}</span></li>)}</ul>
                  </div>
                ) : null}
                <div>
                  <h2>Still missing</h2>
                  <ul>{checklist.missing.map((i) => <li key={i.key}><span className="todo-ring" aria-hidden="true" /><span><strong>{i.label}</strong>{i.value ? `: ${i.value}` : ""}{i.note ? <span className="muted"> {i.note}</span> : null}</span></li>)}</ul>
                </div>
              </section>
            )}

            {stale ? <RedraftAlert warning={redraftWarning(view.readiness)} drafting={props.drafting} onRedraft={props.onRedraft} /> : null}

            {flags.length ? (
              <section className="flag-list" aria-label="Wording to check before approval">
                <h2>Check this wording before asking for approval</h2>
                {flags.map((f) => <WordingFlag key={f.id} flag={f} onAsk={props.onAsk} onKeep={props.onKeepFlag} keeping={props.keepingFlag === f.id} />)}
              </section>
            ) : null}

            <header className="draft-section draft-title-block" data-changed={props.changed.includes("basics") ? "true" : undefined} data-proposed={proposed.includes("basics") ? "true" : undefined}>
              <div className="draft-section-head">
                <h2 className={title ? "draft-title" : "draft-title placeholder"}>{title ?? "Untitled role"}</h2>
                <SeenBy v="public" />
              </div>
              <ul className="draft-chips" aria-label="About this job">
                {chips.map((c) => (
                  <li key={c.name} className={c.missing ? "chip" : "chip accent"}>
                    <Icon name={c.icon} size={14} />
                    <span className="sr-only">{c.name}: </span>
                    {c.text}
                  </li>
                ))}
              </ul>
            </header>

            <section className="draft-section" aria-labelledby="draft-pay-h">
              <div className="draft-section-head">
                <h3 id="draft-pay-h">Pay</h3>
                <span className="seen-by"><Icon name="eye" size={13} />Candidates see the range; only your team sees the most you would pay</span>
              </div>
              <PayCard key={JSON.stringify([view.pay.basis, view.pay.stated, !!view.pay.confirmed])} card={view.pay} onSave={props.onPay} saving={props.paying} error={props.payError} />
            </section>

            {props.closing ? (
              <section className="draft-section" aria-labelledby="draft-closes-h">
                <div className="draft-section-head">
                  <h3 id="draft-closes-h">When applications close</h3>
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
              <section className="draft-section" aria-label="Other suggestions">
                <div className="draft-section-head"><h3>Other suggestions</h3><SeenBy v="internal" /></div>
                {suggestions.get("other")!.map((s) => <SuggestionCard key={s.id} s={s} onFix={props.onFix} fixing={props.fixing} onDismiss={dismiss} />)}
              </section>
            ) : null}

            {view.draft?.provenance.assumptions.length ? (
              <section className="draft-section">
                <div className="draft-section-head"><h3>What the assistant assumed</h3><SeenBy v="internal" /></div>
                <ul>{view.draft.provenance.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
                <p className="small muted">Check these, and change anything that is not right before you ask for approval.</p>
              </section>
            ) : null}
            {view.facts.declinedCriteria.length ? (
              <section className="draft-section">
                <div className="draft-section-head"><h3>Not used, and why</h3><SeenBy v="internal" /></div>
                <ul>{view.facts.declinedCriteria.map((d) => <li key={d.requested}><strong>"{d.requested}"</strong>: {d.reason}{d.alternative ? ` ${d.alternative}` : ""}</li>)}</ul>
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
      <div className="stack" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
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
    <section className="draft-section" aria-labelledby={headId} data-changed={props.changed ? "true" : undefined} data-proposed={props.proposed ? "true" : undefined}>
      <div className="draft-section-head">
        <h3 id={headId}>{s.title}</h3>
        <SeenBy v={s.visibility} />
      </div>
      {props.proposed ? <p className="proposed-tag"><Icon name="sparkle" size={13} />{props.proposedVersion ? "Proposed change, not saved yet" : "A proposed change touches this part"}</p> : null}
      {isEmptySection(shown) ? (
        s.empty ? <p className="muted small">{s.empty}</p> : null
      ) : shown.text ? (
        <p className="draft-text">{shown.text}</p>
      ) : (
        <ul>{shown.items.map((t, i) => <li key={`${i}-${t}`}>{t}</li>)}</ul>
      )}
      {props.flags ? <p className="small" style={{ color: "var(--caution)" }}><Icon name="flag" size={13} /> Wording in this part needs a decision (above).</p> : null}
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
    <div className="req-flag">
      <Icon name="info" size={16} />
      <div className="req-flag-body">
        <p><strong>{s.title}:</strong> "{s.text}"</p>
        <p className="small" style={{ color: "var(--ink-2)" }}>{s.why}</p>
        <div className="row">
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
    <div className="wording-flag">
      <p><strong>"{flag.text}"</strong> {flag.reason}</p>
      {flag.alternative ? <p className="small" style={{ color: "var(--ink-2)" }}>Instead: {flag.alternative}</p> : null}
      {flag.declined ? <p className="small muted">You were told earlier this could not be used.</p> : null}
      {keeping ? (
        <div className="stack" style={{ gap: 6 }}>
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
