"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PacketRevisionProposal, RequirementsCheck } from "@ros/contracts";
import { Alert, Card } from "@ros/ui";
import { api, ApiError, type NewVersionResponse, type RolePacket, type WhoPosts } from "../../api/client";
import { savedVersionToast } from "../../publishing";
import { toast } from "../../toast";
import { Composer } from "./Composer";
import { SuggestionCard } from "./DraftPanel";
import { ProposalCard } from "./ProposalCard";
import { CHANGE_REQUEST_MAX, asksBack, checkSignature, refinePaths } from "./refine-api";
import { errorWords } from "./rules";

/**
 * "Change it by asking" on a role's page (plan C10, C16): the requirements check's suggestions, each fixed with one tap,
 * and a box to ask for any change in plain words. A change comes back as a proposal, shown field by field and saved as a
 * new version only when a person presses Confirm; whether it takes effect now or after approval is the API's rule, and
 * the card says which before anything is pressed. Shown to people who may edit the packet. What a saved change became
 * is said the same way as the editor's (founder decision Q10): live now, with the boards still showing the earlier
 * version, or waiting for approval, which a company's only owner confirms themselves (`whoPosts` names who updates them).
 */
export function RoleRefine({ roleId, packet, whoPosts = "its" }: { roleId: string; packet: RolePacket; whoPosts?: WhoPosts }) {
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
    mutationFn: (p: PacketRevisionProposal) => api.post<NewVersionResponse>(paths.apply(p.revisionId)),
    onSuccess: async (r) => {
      const t = savedVersionToast(r, whoPosts);
      toast(t.title, t.detail);
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
    mutationFn: (fixId: string) => api.post<NewVersionResponse & { applied: string[] }>(paths.applyFixes, { base: check.data?.base ?? "", fixIds: [fixId] }),
    onSuccess: async (r) => {
      const t = savedVersionToast(r, whoPosts);
      toast(t.title, [r.applied.join(" "), t.detail].filter(Boolean).join(" ") || undefined);
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
      <div className="grid min-w-0 gap-3">
        {suggestions.length ? (
          <div className="grid min-w-0 gap-2">
            <p className="small muted">{check.data?.summary ?? "Suggestions about the requirements."} They only suggest; nothing changes unless you tap a fix.</p>
            {suggestions.map((s) => <SuggestionCard key={s.id} s={s} onFix={(id) => fix.mutate(id)} fixing={fix.isPending ? fix.variables ?? null : null} onDismiss={(id) => setDismissed([...dismissed, id])} />)}
          </div>
        ) : null}
        {/* what was asked, as the person's own message; then the assistant at work, as the conversation shows it */}
        {asked ? <p className="bubble user max-w-[min(68ch,88%)] rounded-2xl rounded-tr-md text-[14px] motion-safe:animate-enter">You asked: "{asked}"</p> : null}
        {revise.isPending ? <p className="inline-flex items-center gap-2.5 text-[13px] text-ink-3 motion-safe:animate-fade"><span className="dots" aria-hidden="true"><i /><i /><i /></span>Working out the change…</p> : null}
        {question ? <Alert tone="info">{question}</Alert> : null}
        {proposal ? <ProposalCard proposal={proposal} onConfirm={() => confirm.mutate(proposal)} onKeep={() => keepAsIs.mutate(proposal)} confirming={confirm.isPending} keeping={keepAsIs.isPending} /> : null}
        {problem ? <Alert tone="critical">{problem}</Alert> : null}
        <Composer value={text} onChange={setText} onSend={(t) => revise.mutate(t)} sending={revise.isPending} disabled={!!proposal} changeMax={CHANGE_REQUEST_MAX} label="Ask for a change to this role" placeholder="Ask me to change anything: make it warmer, drop the weekend requirement…" hint="A change is shown to you before it is saved." />
      </div>
    </Card>
  );
}
