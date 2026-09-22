"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Alert, Button, Field, Sheet } from "@ros/ui";
import { api, ApiError } from "../api/client";
import { toast } from "../toast";

const QUICK = [
  ["review", "Review these candidates"],
  ["ask", "Help me decide"],
  ["takeover", "Take this role over"],
] as const;

/** "Ask a recruiter" is on every decision surface (docs/02). The recruiter receives the complete context automatically. */
export function AskRecruiter(props: { roleId?: string; applicationId?: string; label?: string; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<(typeof QUICK)[number][0]>("ask");
  const [question, setQuestion] = useState("");
  const [urgency, setUrgency] = useState<"normal" | "high">("normal");
  const [done, setDone] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () => api.post<{ id: string; slaDueAt: string; message: string }>("/api/v1/escalations", { kind, roleId: props.roleId, applicationId: props.applicationId, question: question || QUICK.find((q) => q[0] === kind)![1], urgency }),
    onSuccess: (r) => { setDone(`${r.message} Expected by ${new Date(r.slaDueAt).toLocaleString()}.`); toast("A recruiter has it."); },
  });
  return (
    <>
      <Button variant="secondary" size={props.size ?? "md"} onClick={() => setOpen(true)}>{props.label ?? "Bring in a recruiter"}</Button>
      <Sheet open={open} onClose={() => { setOpen(false); setDone(null); }} title="Bring in a recruiter">
        {done ? (
          <div className="stack"><Alert tone="info">{done}</Alert><Button onClick={() => { setOpen(false); setDone(null); }}>Done</Button></div>
        ) : (
          <div className="stack">
            <p className="muted">An ITS recruiter gets this role, the candidates, every message, and every decision so far. Nothing to re-explain.</p>
            <Field label="What do you want help with?">
              <div className="row">
                {QUICK.map(([k, l]) => <Button key={k} size="sm" variant={kind === k ? "primary" : "secondary"} onClick={() => setKind(k)}>{l}</Button>)}
              </div>
            </Field>
            <Field label="How urgent is it?" hint="Urgent requests go to the top of the recruiter queue.">
              <div className="row">
                <Button size="sm" variant={urgency === "normal" ? "primary" : "secondary"} onClick={() => setUrgency("normal")}>Normal</Button>
                <Button size="sm" variant={urgency === "high" ? "primary" : "secondary"} onClick={() => setUrgency("high")}>Urgent</Button>
              </div>
            </Field>
            <Field label="Anything specific?" htmlFor="q"><textarea id="q" className="textarea" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Optional. For example: is Maria worth a working interview?" /></Field>
            {send.error ? <Alert tone="critical">{send.error instanceof ApiError ? send.error.message : "Could not send."}</Alert> : null}
            <Button variant="primary" loading={send.isPending} onClick={() => send.mutate()}>Send to a recruiter</Button>
          </div>
        )}
      </Sheet>
    </>
  );
}
