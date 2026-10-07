"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, Button, Field, Segmented, Sheet } from "@ros/ui";
import { api, ApiError, type RoleSummary } from "../api/client";
import { ACCESS_LIMITS, accessWords, scopeOf } from "../recruiter-access";
import { toast } from "../toast";

const QUICK = [
  ["review", "Review these candidates"],
  ["ask", "Help me decide"],
  ["takeover", "Take this role over"],
] as const;

/** The picker's value for "all of your hiring"; any other value is a role id. */
const ALL_HIRING = "all";

/**
 * "Ask a recruiter" is on every decision surface (docs/02). On a role or a candidate the request is about that alone.
 * From the top of Today (no role, no candidate) it first asks which hire it is about, or all of your hiring, and for a
 * one-line note, and it says what the recruiter will see and until when (founder decision Q31: the real access).
 */
export function AskRecruiter(props: { roleId?: string; applicationId?: string; label?: string; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<(typeof QUICK)[number][0]>("ask");
  const [question, setQuestion] = useState("");
  const [urgency, setUrgency] = useState<"normal" | "high">("normal");
  const [done, setDone] = useState<string | null>(null);
  const picks = !props.roleId && !props.applicationId;
  const [about, setAbout] = useState("");
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles"), enabled: open && picks });
  const choosable = (roles.data ?? []).filter((r) => r.status !== "closed");
  // What the request names: the page's role or candidate, or the choice made here ({} is all of the company's hiring).
  const target = picks ? (about === ALL_HIRING ? {} : about ? { roleId: about } : null) : { roleId: props.roleId, applicationId: props.applicationId };
  const scope = target ? scopeOf(target) : null;
  const note = question.trim();
  const ready = !!scope && (!picks || note.length > 0);
  const send = useMutation({
    mutationFn: () => api.post<{ id: string; slaDueAt: string; message: string }>("/api/v1/escalations", { kind, scope, ...(target ?? {}), question: note || QUICK.find((q) => q[0] === kind)![1], urgency }),
    onSuccess: (r) => { setDone(`${r.message} Expected by ${new Date(r.slaDueAt).toLocaleString()}.`); toast("A recruiter has it."); },
  });
  const close = () => { setOpen(false); setDone(null); setAbout(""); };
  return (
    <>
      <Button variant="secondary" size={props.size ?? "md"} icon="people" onClick={() => setOpen(true)}>{props.label ?? "Bring in a recruiter"}</Button>
      <Sheet open={open} onClose={close} title="Bring in a recruiter">
        {done ? (
          <div className="stack"><Alert tone="info">{done}</Alert><Button onClick={close}>Done</Button></div>
        ) : (
          <div className="stack">
            {picks ? (
              <Field label="Which hire is this about?" htmlFor="ask-about" hint="The recruiter sees only what you choose here.">
                <select id="ask-about" className="select" value={about} onChange={(e) => setAbout(e.target.value)}>
                  <option value="" disabled>{roles.isLoading ? "Loading your roles…" : "Choose a role"}</option>
                  {choosable.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                  <option value={ALL_HIRING}>All of your hiring</option>
                </select>
              </Field>
            ) : null}
            {scope ? <p className="small muted">The recruiter will see {accessWords(scope)}. {ACCESS_LIMITS}</p> : null}
            {/* One choice of three: pressed buttons, so a screen reader hears which one is chosen. */}
            <Field label="What do you want help with?">
              <Segmented value={kind} onChange={setKind} ariaLabel="What do you want help with?" options={QUICK.map(([value, label]) => ({ value, label }))} />
            </Field>
            <Field label="How urgent is it?" hint="Urgent requests are marked urgent for the recruiter. The reply-by time stays the same.">
              <Segmented value={urgency} onChange={setUrgency} ariaLabel="How urgent is it?" options={[{ value: "normal", label: "Normal" }, { value: "high", label: "Urgent" }]} />
            </Field>
            <Field label={picks ? "In one line, what do you need?" : "Anything specific?"} htmlFor="q"><textarea id="q" className="textarea" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={picks ? "For example: help me set the pay for a second hygienist." : "Optional. For example: is Maria worth a working interview?"} /></Field>
            {send.error ? <Alert tone="critical">{send.error instanceof ApiError ? send.error.message : "Could not send."}</Alert> : null}
            <Button variant="primary" disabled={!ready} loading={send.isPending} onClick={() => send.mutate()}>Send to a recruiter</Button>
            {picks && !ready ? <p className="small muted">{scope ? "Add a line about what you need." : "Choose which hire this is about first."}</p> : null}
          </div>
        )}
      </Sheet>
    </>
  );
}
