"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PacketRevisionProposal, RequirementsCheck } from "@ros/contracts";
import { Alert, Card } from "@ros/ui";
import { api, ApiError, type RolePacket } from "../../api/client";
import { toast } from "../../toast";
import { Composer } from "./Composer";
import { SuggestionCard } from "./DraftPanel";
import { ProposalCard } from "./ProposalCard";
import { CHANGE_REQUEST_MAX, asksBack, checkSignature, refinePaths } from "./refine-api";
import { errorWords } from "./rules";

/** What saving a version did, in the editor's words (every packet write answers the same three ways). */
export function savedToast(r: { version?: number; outcome?: string }): [string, string] {
  const v = r.version ? `version ${r.version}` : "a new version";
  if (r.outcome === "proposed_pending_approval") return [`Saved as ${v}.`, "It takes effect once an approver says yes."];
  if (r.outcome === "proposed") return [`Saved as ${v} with the draft.`, "Nothing is posted until the role is approved."];
  return [`Saved as ${v}.`, "Every earlier version is kept."];
}

/**
 * "Change it by asking" on a role's page (plan C10, C16): the requirements check's suggestions, each fixed with one tap,
 * and a box to ask for any change in plain words. A change comes back as a proposal, shown field by field and saved as a
 * new version only when a person presses Confirm; whether it takes effect now or after approval is the API's rule, and
 * the card says which before anything is pressed. Shown to people who may edit the packet.
 */
export function RoleRefine({ roleId, packet }: { roleId: string; packet: RolePacket }) {
  const qc = useQueryClient();
  const paths = refinePaths({ kind: "role", roleId });
  const [text, setText] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [proposal, setProposal] = useState<PacketRevisionProposal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const refresh = async () => {
    for (const k of [["role", roleId], ["roles"], ["brief"], ["interview-plan", roleId]]) await qc.invalidateQueries({ queryKey: k });
  };
  const check = useQuery({ queryKey: ["role-check", roleId, checkSignature(packet)], queryFn: () => api.get<RequirementsCheck>(paths.check), retry: false, staleTime: Number.POSITIVE_INFINITY });
  const revise = useMutation({
    mutationFn: (message: string) => api.post<PacketRevisionProposal>(paths.revise, { message }),
    onMutate: (message) => { setAsked(message); setQuestion(null); setProblem(null); setProposal(null); setText(""); },
    onSuccess: (r) => (asksBack(r) ? setQuestion(r.question) : setProposal(r)),
    onError: (err, message) => { setText(message); setAsked(null); setProblem(errorWords(err)); },
  });
  const confirm = useMutation({
    mutationFn: (p: PacketRevisionProposal) => api.post<{ version?: number; outcome?: string }>(paths.apply(p.revisionId)),
    onSuccess: async (r) => {
      const [title, detail] = savedToast(r);
      toast(title, detail);
      setProposal(null);
      setAsked(null);
      await refresh();
    },
    onError: (err) => {
      setProblem(errorWords(err));
      if (err instanceof ApiError && ["stale_revision", "already_decided", "revision_not_found"].includes(err.code)) setProposal(null);
    },
  });
  const keepAsIs = useMutation({
    mutationFn: (p: PacketRevisionProposal) => api.post(paths.discard(p.revisionId)).catch(() => null),
    onSettled: () => { setProposal(null); setAsked(null); toast("Kept as it was."); },
  });
  const fix = useMutation({
    mutationFn: (fixId: string) => api.post<{ version?: number; outcome?: string; applied: string[] }>(paths.applyFixes, { base: check.data?.base ?? "", fixIds: [fixId] }),
    onSuccess: async (r) => {
      const [title, detail] = savedToast(r);
      toast(title, r.applied.join(" ") || detail);
      await refresh();
    },
    onError: (err) => {
      setProblem(errorWords(err));
      if (err instanceof ApiError && err.code === "stale_check") check.refetch();
    },
  });

  const suggestions = (check.data?.suggestions ?? []).filter((s) => !dismissed.includes(s.id));
  return (
    <Card title="Change it by asking">
      <div className="stack" style={{ gap: 10 }}>
        {suggestions.length ? (
          <div className="stack" style={{ gap: 8 }}>
            <p className="small muted" style={{ margin: 0 }}>{check.data?.summary ?? "Suggestions about the requirements."} They only suggest; nothing changes unless you tap a fix.</p>
            {suggestions.map((s) => <SuggestionCard key={s.id} s={s} onFix={(id) => fix.mutate(id)} fixing={fix.isPending ? fix.variables ?? null : null} onDismiss={(id) => setDismissed([...dismissed, id])} />)}
          </div>
        ) : null}
        {asked ? <p className="small" style={{ margin: 0, color: "var(--ink-2)" }}>You asked: "{asked}"</p> : null}
        {revise.isPending ? <p className="small muted" style={{ margin: 0 }}>Working out the change…</p> : null}
        {question ? <Alert tone="info">{question}</Alert> : null}
        {proposal ? <ProposalCard proposal={proposal} onConfirm={() => confirm.mutate(proposal)} onKeep={() => keepAsIs.mutate(proposal)} confirming={confirm.isPending} keeping={keepAsIs.isPending} /> : null}
        {problem ? <Alert tone="critical">{problem}</Alert> : null}
        <Composer value={text} onChange={setText} onSend={(t) => revise.mutate(t)} sending={revise.isPending} disabled={!!proposal} changeMax={CHANGE_REQUEST_MAX} label="Ask for a change to this role" placeholder="Ask me to change anything: make it warmer, drop the weekend requirement…" hint="A change is shown to you before it is saved." />
      </div>
    </Card>
  );
}
