"use client";

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Drawer, Field, IconButton, Segmented } from "@ros/ui";
import { api, ApiError, type EvidenceSource, type InterviewPlanView, type Requirement, type RolePacket } from "../api/client";
import { toast } from "../toast";
import {
  ELIGIBILITY_TYPES, QUESTION_KINDS, SCREENING_MAX, SCREENING_MIN, TONES, applyPacketForm, moveRow, packetFormFrom, packetFormProblem,
  type EligibilityRow, type PacketForm, type QuestionRow,
} from "./new-role/packet-form";

/**
 * The packet editor (docs/spec/21 section 7: B1, B4, B5; plan C11). "The usual edits" are plain fields for everything an
 * owner changes: the title, where, the kind of job and schedule, the pay and its basis, the description, must-haves and
 * nice-to-haves (each with why it matters and where it is checked), the screening questions (3 to 12, in order), the
 * application form's questions (only the kinds that may hold an application), deal-breakers, who has the final say and
 * the tone of messages. "Everything (advanced)" is the whole packet as JSON, for admins and recruiters only. Every save
 * is a new version; what happens to it (current at once, or waiting for approval) is the API's call.
 */
const EMPLOYMENT: Array<{ value: string; label: string }> = [
  { value: "full_time", label: "Full time" },
  { value: "part_time", label: "Part time" },
  { value: "contract", label: "Contract" },
  { value: "temporary", label: "Temporary" },
  { value: "per_diem", label: "Per diem" },
  { value: "internship", label: "Internship" },
];
const DECIDERS = ["owner", "admin", "hiring_manager"];
const NEW_PERSON = "__someone_new";
const EVIDENCE: Array<{ value: EvidenceSource; label: string }> = [
  { value: "resume", label: "résumé" },
  { value: "application", label: "application" },
  { value: "screen", label: "screen" },
  { value: "interview", label: "interview" },
];
const MAX_MUST_HAVES = 6;
const MAX_NICE_TO_HAVES = 10;

type Row = { key: string | null; text: string; rationale: string; evidencedBy: EvidenceSource[] };

function rowsFrom(items: Requirement[]): Row[] {
  return items.map((m) => ({ key: m.key, text: m.text, rationale: m.rationale, evidencedBy: m.evidencedBy?.length ? [...m.evidencedBy] : ["resume", "screen"] }));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "item";
}

/** Rows back to requirements: an existing row keeps its key (assessments refer to it); a new one gets a readable key. */
function toRequirements(rows: Row[], prefix: string): Requirement[] {
  return rows.filter((r) => r.text.trim()).map((r, i) => ({ key: r.key ?? `${prefix}_${i + 1}_${slug(r.text)}`, text: r.text.trim(), rationale: r.rationale.trim() || "Added by the owner", evidencedBy: r.evidencedBy.length ? r.evidencedBy : ["resume"] }));
}

function RequirementRows({ rows, onChange, idPrefix, max, addLabel }: { rows: Row[]; onChange: (rows: Row[]) => void; idPrefix: string; max: number; addLabel: string }) {
  const update = (i: number, patch: Partial<Row>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggle = (i: number, value: EvidenceSource, on: boolean) => update(i, { evidencedBy: on ? [...new Set([...rows[i].evidencedBy, value])] : rows[i].evidencedBy.filter((e) => e !== value) });
  return (
    <div className="stack" style={{ gap: 10 }}>
      {rows.map((r, i) => (
        <div key={r.key ?? `new-${i}`} className="stack" style={{ gap: 6, padding: 10, border: "1px solid var(--line)", borderRadius: 8 }}>
          <Field label={`${i + 1}. What they must bring`} htmlFor={`${idPrefix}-text-${i}`}><input id={`${idPrefix}-text-${i}`} className="input" value={r.text} onChange={(e) => update(i, { text: e.target.value })} placeholder="e.g. Active CA dental hygiene (RDH) license" /></Field>
          <Field label="Why it matters" htmlFor={`${idPrefix}-why-${i}`}><input id={`${idPrefix}-why-${i}`} className="input" value={r.rationale} onChange={(e) => update(i, { rationale: e.target.value })} placeholder="e.g. Required by law to practice" /></Field>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small muted" style={{ marginBottom: 4 }}>Where we check it (pick at least one; "screen" means the screening conversation asks about it)</legend>
            <div className="row">
              {EVIDENCE.map((ev) => (
                <label key={ev.value} className="row" style={{ gap: 4 }}>
                  <input type="checkbox" checked={r.evidencedBy.includes(ev.value)} onChange={(e) => toggle(i, ev.value, e.target.checked)} /> {ev.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="row"><Button size="sm" variant="quiet" onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button></div>
        </div>
      ))}
      <div className="row">
        <Button size="sm" disabled={rows.length >= max} onClick={() => onChange([...rows, { key: null, text: "", rationale: "", evidencedBy: ["resume", "screen"] }])}>{addLabel}</Button>
        {rows.length >= max ? <span className="small muted">That is the most this list can hold ({max}).</span> : null}
      </div>
    </div>
  );
}

/** A group of requirement rows: a fieldset named by its legend, since there is no single control for a label to point at. */
function RequirementGroup({ legend, hint, children }: { legend: string; hint: string; children: ReactNode }) {
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend style={{ fontWeight: 600, fontSize: 13.5, padding: 0, marginBottom: 6 }}>{legend}</legend>
      <span className="hint">{hint}</span>
      {children}
    </fieldset>
  );
}

/** Where the job is: one row per place, a city and a state; at least one is kept. */
function PlaceRows({ rows, onChange }: { rows: PacketForm["places"]; onChange: (rows: PacketForm["places"]) => void }) {
  const update = (i: number, patch: Partial<PacketForm["places"][number]>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ alignItems: "flex-end", flexWrap: "nowrap" }}>
          <div style={{ flex: 2, minWidth: 0 }}><Field label={i === 0 ? "City" : `City (place ${i + 1})`} htmlFor={`place-city-${i}`}><input id={`place-city-${i}`} className="input" value={r.city} onChange={(e) => update(i, { city: e.target.value })} /></Field></div>
          <div style={{ flex: 1, minWidth: 0 }}><Field label="State" htmlFor={`place-region-${i}`}><input id={`place-region-${i}`} className="input" value={r.region} maxLength={2} onChange={(e) => update(i, { region: e.target.value })} placeholder="CA" /></Field></div>
          {rows.length > 1 ? <IconButton icon="x" label={`Remove place ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))} /> : null}
        </div>
      ))}
      <div className="row"><Button size="sm" disabled={rows.length >= 5} onClick={() => onChange([...rows, { city: "", region: "" }])}>Add a place</Button></div>
    </div>
  );
}

/** The screening questions in the order they are asked: reword, change the kind, move up or down, remove, add. */
function QuestionRows({ rows, onChange }: { rows: QuestionRow[]; onChange: (rows: QuestionRow[]) => void }) {
  const update = (i: number, patch: Partial<QuestionRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const filled = rows.filter((r) => r.question.trim()).length;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.map((r, i) => (
        <div key={r.key ?? `new-${i}`} className="stack" style={{ gap: 6, padding: 10, border: "1px solid var(--line)", borderRadius: 8 }}>
          <Field label={`${i + 1}. Question`} htmlFor={`sq-${i}`}><input id={`sq-${i}`} className="input" value={r.question} onChange={(e) => update(i, { question: e.target.value })} placeholder="e.g. Which days and hours can you work?" /></Field>
          <div className="row">
            <label className="small" htmlFor={`sq-kind-${i}`}>About</label>
            <select id={`sq-kind-${i}`} className="select" style={{ width: "auto" }} value={r.kind} onChange={(e) => update(i, { kind: e.target.value })}>
              {QUESTION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
            <span style={{ marginLeft: "auto" }} className="row">
              <IconButton icon="chevron-up" size="sm" label={`Move question ${i + 1} up`} disabled={i === 0} onClick={() => onChange(moveRow(rows, i, -1))} />
              <IconButton icon="chevron-down" size="sm" label={`Move question ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => onChange(moveRow(rows, i, 1))} />
              <Button size="sm" variant="quiet" disabled={filled <= SCREENING_MIN && !!r.question.trim()} onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button>
            </span>
          </div>
        </div>
      ))}
      <div className="row">
        <Button size="sm" disabled={rows.length >= SCREENING_MAX} onClick={() => onChange([...rows, { key: null, question: "", kind: "skills" }])}>Add a question</Button>
        <span className="small muted">{rows.length >= SCREENING_MAX ? `That is the most there can be (${SCREENING_MAX}).` : filled <= SCREENING_MIN ? `At least ${SCREENING_MIN} are needed.` : null}</span>
      </div>
    </div>
  );
}

/** The application form's questions: only the kinds that may hold an application, each with why it is asked. */
function EligibilityRows({ rows, onChange }: { rows: EligibilityRow[]; onChange: (rows: EligibilityRow[]) => void }) {
  const update = (i: number, patch: Partial<EligibilityRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.length ? null : <p className="small muted" style={{ margin: 0 }}>None. Candidates apply without any.</p>}
      {rows.map((r, i) => (
        <div key={r.key ?? `new-${i}`} className="stack" style={{ gap: 6, padding: 10, border: "1px solid var(--line)", borderRadius: 8 }}>
          <Field label="What it checks" htmlFor={`el-type-${i}`}>
            <select id={`el-type-${i}`} className="select" value={r.type} onChange={(e) => update(i, { type: e.target.value })}>
              {ELIGIBILITY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="The question, as candidates see it" htmlFor={`el-q-${i}`}><input id={`el-q-${i}`} className="input" value={r.question} onChange={(e) => update(i, { question: e.target.value })} /></Field>
          <Field label="Why it is asked" htmlFor={`el-why-${i}`}><input id={`el-why-${i}`} className="input" value={r.rationale} onChange={(e) => update(i, { rationale: e.target.value })} placeholder="e.g. Required by law to practise" /></Field>
          <div className="row">
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={r.knockout} onChange={(e) => update(i, { knockout: e.target.checked })} /> A "no" holds the application for your decision</label>
            <Button size="sm" variant="quiet" onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        </div>
      ))}
      <div className="row"><Button size="sm" disabled={rows.length >= 8} onClick={() => onChange([...rows, { key: null, type: "schedule_availability", question: "", rationale: "", knockout: true }])}>Add a question</Button></div>
    </div>
  );
}

/** A plain list of lines: each with Remove, and Add for one more. */
function TextRows({ rows, onChange, idPrefix, addLabel, placeholder }: { rows: string[]; onChange: (rows: string[]) => void; idPrefix: string; addLabel: string; placeholder: string }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i} className="row" style={{ flexWrap: "nowrap" }}>
          <label htmlFor={`${idPrefix}-${i}`} className="sr-only">{`Line ${i + 1}`}</label>
          <input id={`${idPrefix}-${i}`} className="input" value={r} placeholder={placeholder} onChange={(e) => onChange(rows.map((x, j) => (j === i ? e.target.value : x)))} />
          <IconButton icon="x" label={`Remove line ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div className="row"><Button size="sm" disabled={rows.length >= 10} onClick={() => onChange([...rows, ""])}>{addLabel}</Button></div>
    </div>
  );
}

/** The first thing wrong with the simple form, in the owner's words, or null when it can be saved. */
function problemWith(input: { form: PacketForm; description: string; mustHaves: Row[]; niceToHaves: Row[] }): string | null {
  const fields = packetFormProblem(input.form);
  if (fields) return fields;
  if (input.description.trim().length < 50) return "The public description needs at least a few sentences (50 characters).";
  const mh = input.mustHaves.filter((r) => r.text.trim());
  if (!mh.length) return "Keep at least one must-have.";
  if (mh.length > MAX_MUST_HAVES) return `At most ${MAX_MUST_HAVES} must-haves.`;
  if (mh.some((r) => !r.evidencedBy.length)) return "Every must-have needs at least one place where it is checked.";
  const nh = input.niceToHaves.filter((r) => r.text.trim());
  if (nh.length > MAX_NICE_TO_HAVES) return `At most ${MAX_NICE_TO_HAVES} nice-to-haves.`;
  if (nh.some((r) => !r.evidencedBy.length)) return "Every nice-to-have needs at least one place where it is checked.";
  return null;
}

/**
 * The editor's fields are seeded once, from the version it was opened on: the role page mounts it only while it is open
 * and keys it by that version, so every opening starts from what is there now, never from what the page first loaded.
 * `proposed` says the version is the one waiting for approval (a teammate's edit to an open role); saving builds on it.
 * When a version is saved elsewhere while the editor is open (`newerVersion`), it says so before anyone saves over it.
 */
export function EditPacket({ open, onClose, roleId, packet, version, proposed, currentVersion, newerVersion, advanced }: { open: boolean; onClose: () => void; roleId: string; packet: RolePacket; version: number; proposed: boolean; currentVersion: number | null; newerVersion: number | null; advanced: boolean }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"simple" | "json">("simple");
  const [form, setForm] = useState<PacketForm>(() => packetFormFrom(packet));
  const [description, setDescription] = useState(packet.description.publicJobDescription);
  const [mustHaves, setMustHaves] = useState<Row[]>(rowsFrom(packet.requirements.mustHaves));
  const [niceToHaves, setNiceToHaves] = useState<Row[]>(rowsFrom(packet.requirements.niceToHaves));
  const [json, setJson] = useState(JSON.stringify(packet, null, 2));
  const [summary, setSummary] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [newDecider, setNewDecider] = useState(!packet.preferences.decisionMakerUserId && !!packet.preferences.decisionMakerName);
  // The team, for "Who has the final say" (the Interview plan tab reads the same list).
  const plan = useQuery({ queryKey: ["interview-plan", roleId], queryFn: () => api.get<InterviewPlanView>(`/api/v1/roles/${roleId}/interview-plan`), enabled: open });
  const deciders = (plan.data?.team ?? []).filter((m) => DECIDERS.includes(m.role));
  const set = (patch: Partial<PacketForm>) => setForm({ ...form, ...patch });
  const save = useMutation({
    mutationFn: () => {
      let next: RolePacket;
      if (mode === "json" && advanced) next = JSON.parse(json) as RolePacket;
      else {
        next = applyPacketForm(packet, form);
        next.description.publicJobDescription = description.trim();
        next.requirements.mustHaves = toRequirements(mustHaves, "mh");
        next.requirements.niceToHaves = toRequirements(niceToHaves, "nh");
      }
      return api.post<{ version: number; outcome?: "approved_current" | "proposed_pending_approval" | "proposed"; guardChanges?: string[] }>(`/api/v1/roles/${roleId}/packets`, { packet: next, changeSummary: summary.trim() || "Edited by the owner" });
    },
    onSuccess: async (r) => {
      // What the fairness and pay checks changed on their own (a must-have taken out, the ceiling raised) is said, never done silently.
      const changed = r.guardChanges?.length ? r.guardChanges.join(" ") : undefined;
      toast(r.outcome === "proposed_pending_approval" ? `Saved as version ${r.version}. It takes effect once an approver says yes.` : r.outcome === "proposed" ? `Saved as version ${r.version} with the draft.` : `Saved as version ${r.version}.`, changed);
      // Closed first, so the editor never shows its own new version as "saved while this was open".
      onClose();
      await qc.invalidateQueries({ queryKey: ["role", roleId] });
      await qc.invalidateQueries({ queryKey: ["interview-plan", roleId] });
      await qc.invalidateQueries({ queryKey: ["brief"] });
      await qc.invalidateQueries({ queryKey: ["roles"] });
    },
  });
  const submit = () => {
    if (mode === "simple" || !advanced) {
      const p = problemWith({ form, description, mustHaves, niceToHaves });
      setProblem(p);
      if (p) return;
    } else {
      try { JSON.parse(json); } catch { setProblem("The JSON does not parse. Check for a missing comma or bracket."); return; }
      setProblem(null);
    }
    save.mutate();
  };
  return (
    <Drawer open={open} onClose={onClose} title="Edit the role" sub={`Editing version ${version}`}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          {proposed
            ? `You are editing v${version}, the version waiting for approval${currentVersion ? ` (the role still runs on v${currentVersion})` : ""}. Saving keeps its changes and adds yours as a new version.`
            : `You are editing v${version}. Saving adds a new version; nothing is overwritten.`}
        </p>
        {newerVersion ? <Alert tone="caution">A newer version, v{newerVersion}, was saved while this was open. Saving now starts from v{version} and would undo its changes. Copy anything you typed, close this, and open Edit again to start from the newest version.</Alert> : null}
        {advanced ? <Segmented value={mode} onChange={setMode} options={[{ value: "simple", label: "The usual edits" }, { value: "json", label: "Everything (advanced)" }]} /> : null}
        {mode === "simple" || !advanced ? (
          <>
            <RequirementGroup legend="The job" hint="Shown on the job page.">
              <Field label="Job title" htmlFor="ed-title"><input id="ed-title" className="input" value={form.title} onChange={(e) => set({ title: e.target.value })} /></Field>
              <PlaceRows rows={form.places} onChange={(places) => set({ places })} />
              <div className="grid-2">
                <Field label="Full or part time" htmlFor="ed-type">
                  <select id="ed-type" className="select" value={form.employmentType} onChange={(e) => set({ employmentType: e.target.value })}>
                    {EMPLOYMENT.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Work model" htmlFor="remote">
                  <select id="remote" className="select" value={form.remotePolicy} onChange={(e) => set({ remotePolicy: e.target.value as PacketForm["remotePolicy"] })}>
                    <option value="onsite">On site</option>
                    <option value="hybrid">Hybrid (some days on site)</option>
                    <option value="remote">Remote</option>
                  </select>
                </Field>
              </div>
              <Field label="Schedule" htmlFor="ed-schedule"><input id="ed-schedule" className="input" value={form.schedule} onChange={(e) => set({ schedule: e.target.value })} placeholder="e.g. Monday to Thursday, 8 to 5" /></Field>
            </RequirementGroup>
            <Field label="Public description" htmlFor="desc"><textarea id="desc" className="textarea" style={{ minHeight: 180 }} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <RequirementGroup legend="Pay" hint="Candidates see the range; only your team sees the most you would pay.">
              <Field label="Paid" htmlFor="ed-basis">
                <select id="ed-basis" className="select" value={form.basis} onChange={(e) => set({ basis: e.target.value as PacketForm["basis"] })}>
                  <option value="hourly">By the hour</option>
                  <option value="salary">A yearly salary</option>
                </select>
              </Field>
              <div className="grid-2">
                <Field label="Pay minimum" htmlFor="min"><input id="min" className="input" inputMode="decimal" value={form.min} onChange={(e) => set({ min: e.target.value })} /></Field>
                <Field label="Pay maximum" htmlFor="max"><input id="max" className="input" inputMode="decimal" value={form.max} onChange={(e) => set({ max: e.target.value })} /></Field>
              </div>
              <Field label="Ceiling (the most you would pay)" htmlFor="ceil" hint="Offers never go above this without a new approval."><input id="ceil" className="input" inputMode="decimal" value={form.ceiling} onChange={(e) => set({ ceiling: e.target.value })} /></Field>
              <Field label="Benefits" htmlFor="ed-benefits"><input id="ed-benefits" className="input" value={form.benefits} onChange={(e) => set({ benefits: e.target.value })} placeholder="e.g. Health, dental, 401(k), paid time off" /></Field>
            </RequirementGroup>
            <RequirementGroup legend={`Must-haves (up to ${MAX_MUST_HAVES})`} hint="The things you would not hire without. Each says why it matters and where it is checked.">
              <RequirementRows rows={mustHaves} onChange={setMustHaves} idPrefix="mh" max={MAX_MUST_HAVES} addLabel="Add a must-have" />
            </RequirementGroup>
            <RequirementGroup legend={`Nice-to-haves (up to ${MAX_NICE_TO_HAVES})`} hint="Helpful, never a reason to hold anyone.">
              <RequirementRows rows={niceToHaves} onChange={setNiceToHaves} idPrefix="nh" max={MAX_NICE_TO_HAVES} addLabel="Add a nice-to-have" />
            </RequirementGroup>
            <RequirementGroup legend={`Screening questions (${SCREENING_MIN} to ${SCREENING_MAX})`} hint="Asked in a short conversation marked as AI, in this order, with a person available instead.">
              <QuestionRows rows={form.questions} onChange={(questions) => set({ questions })} />
            </RequirementGroup>
            <RequirementGroup legend="Questions on the application form" hint="The only questions that can hold an application for your decision. Nothing is ever turned down automatically.">
              <EligibilityRows rows={form.eligibility} onChange={(eligibility) => set({ eligibility })} />
            </RequirementGroup>
            <RequirementGroup legend="Deal-breakers, in your words" hint="Only your team sees these. They are used only once you make them visible must-haves.">
              <TextRows rows={form.dealBreakers} onChange={(dealBreakers) => set({ dealBreakers })} idPrefix="db" addLabel="Add a deal-breaker" placeholder="e.g. Cannot work Saturdays" />
            </RequirementGroup>
            <Field label="Who has the final say" htmlFor="ed-decider" hint="Approvals of this role go to them; an owner can also decide.">
              <select id="ed-decider" className="select" value={form.decisionMakerUserId || (newDecider ? NEW_PERSON : "")} onChange={(e) => {
                const v = e.target.value;
                setNewDecider(v === NEW_PERSON);
                const member = deciders.find((m) => m.userId === v);
                set({ decisionMakerUserId: member ? member.userId : "", decisionMakerName: member ? member.name : v === NEW_PERSON ? form.decisionMakerName : "" });
              }}>
                <option value="">Any owner, admin or hiring manager</option>
                {deciders.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
                {form.decisionMakerUserId && !deciders.some((m) => m.userId === form.decisionMakerUserId) ? <option value={form.decisionMakerUserId}>{form.decisionMakerName || "The person chosen before"}</option> : null}
                <option value={NEW_PERSON}>Someone not on the team yet</option>
              </select>
            </Field>
            {newDecider ? <Field label="Their name" htmlFor="ed-decider-name" hint="Invite them to the team from Setup and approvals will go to them."><input id="ed-decider-name" className="input" value={form.decisionMakerName} onChange={(e) => set({ decisionMakerName: e.target.value })} /></Field> : null}
            <Field label="Tone of messages to candidates">
              <Segmented value={form.tone} onChange={(tone) => set({ tone })} ariaLabel="Tone of messages to candidates" options={TONES.map((t) => ({ value: t.value, label: t.label }))} />
            </Field>
          </>
        ) : (
          <Field label="Role packet JSON" htmlFor="packet-json" hint="Validated on save. Eligibility rules must use the allowed types."><textarea id="packet-json" className="textarea" style={{ minHeight: 360, fontFamily: "var(--mono)", fontSize: 12 }} value={json} onChange={(e) => setJson(e.target.value)} /></Field>
        )}
        <Field label="What changed and why" htmlFor="sum"><input id="sum" className="input" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Raised the range after seeing the market number" /></Field>
        {problem ? <Alert tone="caution">{problem}</Alert> : null}
        {save.error ? <Alert tone="critical">{save.error instanceof ApiError ? save.error.message : "Could not save."}</Alert> : null}
        <Button variant="primary" loading={save.isPending} onClick={submit}>Save as a new version</Button>
      </div>
    </Drawer>
  );
}
