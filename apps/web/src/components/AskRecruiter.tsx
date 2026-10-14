"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Field, Segmented, Sheet } from "@ros/ui";
import { api, ApiError, type RoleSummary } from "../api/client";
import { ACCESS_LIMITS, DRAFT_HANDED_OVER, accessWords, scopeOf, type AskKind, type AskPreset } from "../recruiter-access";
import { toast } from "../toast";
import { useAskRole } from "./use-ask-role";

const QUICK = [
  ["review", "Review these candidates"],
  ["ask", "Help me decide"],
  ["takeover", "Ask ITS to run this hire"],
] as const;

/** Said when "Ask ITS to run this hire" is chosen: running a hire for a company is agreed with a person first (release 3). */
const TAKEOVER_WORDS = "An ITS recruiter will contact you to agree how they would run this hire. Nothing changes until you have both agreed; until then you keep running it.";

/** The picker's value for "all of your hiring"; any other value is a role id. */
const ALL_HIRING = "all";

type Kind = AskKind;

/**
 * "Ask a recruiter" is on every decision surface (docs/02). On a role or a candidate the request is about that alone.
 * From the top of Today (no role, no candidate) it first asks which hire it is about, or all of your hiring, and for a
 * one-line note, and it says what the recruiter will see and until when (founder decision Q31: the real access). Before
 * anything is sent it shows the reply-by time the request would get (plan B6) and where it stands against the plan's
 * recruiter requests (Q33). A card's own request (`preset`) opens here filled in. Shown only to people who may ask
 * (escalation.create: never an interviewer, plan B7).
 */
export function AskRecruiter(props: { roleId?: string; applicationId?: string; label?: string; size?: "sm" | "md"; variant?: "primary" | "secondary"; preset?: AskPreset; onSent?: (message: string) => void }) {
  const who = useAskRole();
  const qc = useQueryClient();
  const preset = props.preset ?? {};
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>(preset.kind ?? "ask");
  const [question, setQuestion] = useState(preset.question ?? "");
  const [urgency, setUrgency] = useState<"normal" | "high">("normal");
  const [done, setDone] = useState<string | null>(null);
  // A draft handed over (plan C12) has no role yet: the request covers all of the hiring and carries the draft.
  const draftId = preset.intakeSessionId;
  const picks = !props.roleId && !props.applicationId && !draftId;
  const [about, setAbout] = useState<string>(preset.about === "all" ? ALL_HIRING : "");
  const topic = preset.topic;
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles"), enabled: open && picks });
  // The reply-by time if it were sent now; urgency changes the queue's order, never this time.
  const estimate = useQuery({ queryKey: ["escalations", "estimate", kind, topic ?? ""], queryFn: () => api.get<{ slaDueAt: string; message: string; allowance?: { message: string } }>(`/api/v1/escalations/estimate?kind=${kind}${topic ? `&topic=${topic}` : ""}`), enabled: open && !done && who.mayAsk, staleTime: 60_000 });
  const choosable = (roles.data ?? []).filter((r) => r.status !== "closed");
  // What the request names: the page's role or candidate, or the choice made here ({} is all of the company's hiring).
  const target = draftId ? {} : picks ? (about === ALL_HIRING ? {} : about ? { roleId: about } : null) : { roleId: props.roleId, applicationId: props.applicationId };
  const scope = target ? scopeOf(target) : null;
  const note = question.trim();
  const ready = !!scope && (!picks || note.length > 0);
  const send = useMutation({
    mutationFn: () => api.post<{ id: string; slaDueAt: string; message: string }>("/api/v1/escalations", { kind, scope, ...(target ?? {}), question: note || QUICK.find((q) => q[0] === kind)![1], urgency, ...(topic ? { topic } : {}), ...(draftId ? { intakeSessionId: draftId } : {}) }),
    onSuccess: (r) => {
      setDone(`${r.message} You can follow it, and read the answer in full, under Your recruiter requests on Home.`);
      toast(topic === "plan" ? "Sent to ITS." : "A recruiter has it.");
      props.onSent?.(r.message);
      qc.invalidateQueries({ queryKey: ["escalations", "mine"] });
      qc.invalidateQueries({ queryKey: ["brief"] });
    },
  });
  // Closing puts the form back as it opened (a card's own request keeps its words for next time).
  const close = () => { setOpen(false); setDone(null); setAbout(preset.about === "all" ? ALL_HIRING : ""); setKind(preset.kind ?? "ask"); setQuestion(preset.question ?? ""); };
  if (!who.ready || !who.mayAsk) return null;
  return (
    <>
      <Button variant={props.variant ?? "secondary"} size={props.size ?? "md"} icon="people" onClick={() => setOpen(true)}>{props.label ?? "Bring in a recruiter"}</Button>
      <Sheet open={open} onClose={close} title={topic === "plan" ? "Talk to ITS about your plan" : "Bring in a recruiter"}>
        {done ? (
          <div className="stack"><Alert tone="info">{done}</Alert><Button onClick={close}>Done</Button></div>
        ) : (
          <div className="stack">
            {picks ? (
              <Field label="Which hire is this about?" htmlFor="ask-about" hint="The recruiter sees only what you choose here.">
                <select id="ask-about" className="select" value={about} onChange={(e) => setAbout(e.target.value)}>
                  <option value="" disabled>{roles.isLoading ? "Loading your jobs…" : "Choose a job"}</option>
                  {choosable.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                  <option value={ALL_HIRING}>All of your hiring</option>
                </select>
              </Field>
            ) : null}
            {scope ? <p className="small muted">The recruiter will see {accessWords(scope)}. {draftId ? `${DRAFT_HANDED_OVER} ` : ""}{ACCESS_LIMITS}</p> : null}
            {/* One choice of three: pressed buttons, so a screen reader hears which one is chosen. */}
            <Field label="What do you want help with?">
              <Segmented value={kind} onChange={setKind} ariaLabel="What do you want help with?" options={QUICK.map(([value, label]) => ({ value, label }))} />
            </Field>
            {kind === "takeover" ? <p className="small muted">{TAKEOVER_WORDS}</p> : null}
            <Field label="How urgent is it?" hint="Urgent requests go to the front of the ITS queue. The reply-by time stays the same.">
              <Segmented value={urgency} onChange={setUrgency} ariaLabel="How urgent is it?" options={[{ value: "normal", label: "Normal" }, { value: "high", label: "Urgent" }]} />
            </Field>
            <Field label={picks ? "In one line, what do you need?" : "Anything specific?"} htmlFor="q"><textarea id="q" className="textarea" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={picks ? "For example: help me set the pay for a second hygienist." : "Optional. For example: is Maria worth a working interview?"} /></Field>
            {estimate.data ? <p className="small muted" data-testid="reply-by-estimate">{estimate.data.message}</p> : null}
            {estimate.data?.allowance?.message ? <p className="small muted" data-testid="recruiter-request-allowance">{estimate.data.allowance.message}</p> : null}
            {send.error ? <Alert tone="critical">{send.error instanceof ApiError ? send.error.message : "Could not send."}</Alert> : null}
            <Button variant="primary" disabled={!ready} loading={send.isPending} onClick={() => send.mutate()}>{topic === "plan" ? "Send to ITS" : "Send to a recruiter"}</Button>
            {picks && !ready ? <p className="small muted">{scope ? "Add a line about what you need." : "Choose which hire this is about first."}</p> : null}
          </div>
        )}
      </Sheet>
    </>
  );
}
