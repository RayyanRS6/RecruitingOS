"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Field, Segmented, Sheet } from "@ros/ui";
import { api, ApiError, type EvidenceSource, type Requirement, type RolePacket } from "../api/client";
import { toast } from "../toast";

/**
 * The packet editor (docs/spec/21 section 7: B1, B4, B5). "The usual edits" keeps the owner's fields; every must-have
 * and nice-to-have row carries what the contract needs (the text, why it matters, where it is evidenced), so a packet
 * saved from here is a valid packet. "Everything (advanced)" is the whole packet as JSON for recruiters. Every save is
 * a new version; what happens to it (current at once, or waiting for approval) is the API's call.
 */
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

/** The first thing wrong with the simple form, in the owner's words, or null when it can be saved. */
function problemWith(input: { description: string; min: string; max: string; ceiling: string; mustHaves: Row[]; niceToHaves: Row[] }): string | null {
  if (input.description.trim().length < 50) return "The public description needs at least a few sentences (50 characters).";
  const nums = [input.min, input.max, input.ceiling].map((s) => Number(s));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return "Pay minimum, maximum and ceiling must be numbers.";
  if (nums[0] > nums[1]) return "The pay minimum is above the maximum.";
  const mh = input.mustHaves.filter((r) => r.text.trim());
  if (!mh.length) return "Keep at least one must-have.";
  if (mh.length > MAX_MUST_HAVES) return `At most ${MAX_MUST_HAVES} must-haves.`;
  if (mh.some((r) => !r.evidencedBy.length)) return "Every must-have needs at least one place where it is checked.";
  const nh = input.niceToHaves.filter((r) => r.text.trim());
  if (nh.length > MAX_NICE_TO_HAVES) return `At most ${MAX_NICE_TO_HAVES} nice-to-haves.`;
  if (nh.some((r) => !r.evidencedBy.length)) return "Every nice-to-have needs at least one place where it is checked.";
  return null;
}

export function EditPacket({ open, onClose, roleId, packet }: { open: boolean; onClose: () => void; roleId: string; packet: RolePacket }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"simple" | "json">("simple");
  const [description, setDescription] = useState(packet.description.publicJobDescription);
  const [min, setMin] = useState(String(packet.compensation.min));
  const [max, setMax] = useState(String(packet.compensation.max));
  const [ceiling, setCeiling] = useState(String(packet.compensation.ceiling));
  const [remotePolicy, setRemotePolicy] = useState<RolePacket["identity"]["remotePolicy"]>(packet.identity.remotePolicy ?? "onsite");
  const [mustHaves, setMustHaves] = useState<Row[]>(rowsFrom(packet.requirements.mustHaves));
  const [niceToHaves, setNiceToHaves] = useState<Row[]>(rowsFrom(packet.requirements.niceToHaves));
  const [json, setJson] = useState(JSON.stringify(packet, null, 2));
  const [summary, setSummary] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      let next: RolePacket;
      if (mode === "json") next = JSON.parse(json) as RolePacket;
      else {
        next = structuredClone(packet);
        next.description.publicJobDescription = description.trim();
        next.compensation.min = Number(min);
        next.compensation.max = Number(max);
        next.compensation.ceiling = Math.max(Number(ceiling), Number(max));
        next.identity.remotePolicy = remotePolicy;
        next.requirements.mustHaves = toRequirements(mustHaves, "mh");
        next.requirements.niceToHaves = toRequirements(niceToHaves, "nh");
      }
      return api.post<{ version: number; outcome?: "approved_current" | "proposed_pending_approval" | "proposed" }>(`/api/v1/roles/${roleId}/packets`, { packet: next, changeSummary: summary.trim() || "Edited by the owner" });
    },
    onSuccess: async (r) => {
      toast(r.outcome === "proposed_pending_approval" ? `Saved as version ${r.version}. It takes effect once an approver says yes.` : r.outcome === "proposed" ? `Saved as version ${r.version} with the draft.` : `Saved as version ${r.version}.`);
      await qc.invalidateQueries({ queryKey: ["role", roleId] });
      await qc.invalidateQueries({ queryKey: ["interview-plan", roleId] });
      await qc.invalidateQueries({ queryKey: ["brief"] });
      onClose();
    },
  });
  const submit = () => {
    if (mode === "simple") {
      const p = problemWith({ description, min, max, ceiling, mustHaves, niceToHaves });
      setProblem(p);
      if (p) return;
    } else {
      try { JSON.parse(json); } catch { setProblem("The JSON does not parse. Check for a missing comma or bracket."); return; }
      setProblem(null);
    }
    save.mutate();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Edit the role">
      <div className="stack">
        <Segmented value={mode} onChange={setMode} options={[{ value: "simple", label: "The usual edits" }, { value: "json", label: "Everything (advanced)" }]} />
        {mode === "simple" ? (
          <>
            <Field label="Public description" htmlFor="desc"><textarea id="desc" className="textarea" style={{ minHeight: 180 }} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <div className="grid-2">
              <Field label="Pay minimum" htmlFor="min"><input id="min" className="input" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} /></Field>
              <Field label="Pay maximum" htmlFor="max"><input id="max" className="input" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} /></Field>
            </div>
            <Field label="Ceiling (the most you would pay)" htmlFor="ceil" hint="Offers never go above this without a new approval."><input id="ceil" className="input" inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} /></Field>
            <Field label="Work model" htmlFor="remote" hint="Shown on the role and the job page.">
              <select id="remote" className="select" value={remotePolicy} onChange={(e) => setRemotePolicy(e.target.value as RolePacket["identity"]["remotePolicy"])}>
                <option value="onsite">On site</option>
                <option value="hybrid">Hybrid (some days on site)</option>
                <option value="remote">Remote</option>
              </select>
            </Field>
            <Field label={`Must-haves (up to ${MAX_MUST_HAVES})`} hint="The things you would not hire without. Each says why it matters and where it is checked.">
              <RequirementRows rows={mustHaves} onChange={setMustHaves} idPrefix="mh" max={MAX_MUST_HAVES} addLabel="Add a must-have" />
            </Field>
            <Field label={`Nice-to-haves (up to ${MAX_NICE_TO_HAVES})`} hint="Helpful, never a reason to hold anyone.">
              <RequirementRows rows={niceToHaves} onChange={setNiceToHaves} idPrefix="nh" max={MAX_NICE_TO_HAVES} addLabel="Add a nice-to-have" />
            </Field>
          </>
        ) : (
          <Field label="Role packet JSON" hint="Validated on save. Eligibility rules must use the allowed types."><textarea className="textarea" style={{ minHeight: 360, fontFamily: "var(--mono)", fontSize: 12 }} value={json} onChange={(e) => setJson(e.target.value)} /></Field>
        )}
        <Field label="What changed and why" htmlFor="sum"><input id="sum" className="input" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Raised the range after seeing the market number" /></Field>
        {problem ? <Alert tone="caution">{problem}</Alert> : null}
        {save.error ? <Alert tone="critical">{save.error instanceof ApiError ? save.error.message : "Could not save."}</Alert> : null}
        <Button variant="primary" loading={save.isPending} onClick={submit}>Save as a new version</Button>
      </div>
    </Sheet>
  );
}
