"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, ErrorState, Field, Skeleton } from "@ros/ui";
import { api, ApiError, type RoleApplyModeView } from "../api/client";
import { APPLY_MODE_HELP, APPLY_MODE_NOTE, REASON_MIN, applyModeToast, roleApplyModeBody, roleApplyModeLine, roleChoiceOf, roleChoices, type RoleChoice } from "../apply-flow";
import { toast } from "../toast";

/**
 * How one role's applicants meet the screening conversation (plan E1; founder decision B1), for ITS only: "apply and
 * talk in one visit", "form now, conversation later", or the company's default. A reason is required and recorded with
 * the change. Shown on the role's Posting tab to ITS staff and, per role, in the admin console; the API refuses
 * everyone else (and ITS staff without a second factor, with its own words).
 */
export function RoleApplyMode({ roleId, roleTitle, compact = false }: { roleId: string; roleTitle?: string | null; compact?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["role", roleId, "apply-mode"], queryFn: () => api.get<RoleApplyModeView>(`/api/v1/roles/${roleId}/apply-mode`), retry: false });
  const [choice, setChoice] = useState<RoleChoice | null>(null);
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: (body: { applyMode: RoleApplyModeView["applyMode"]; reason: string }) => api.put<RoleApplyModeView>(`/api/v1/roles/${roleId}/apply-mode`, body),
    onSuccess: (view) => {
      const t = applyModeToast(view, roleTitle);
      toast(t.title, t.detail);
      qc.setQueryData(["role", roleId, "apply-mode"], view);
      setChoice(null);
      setReason("");
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save the change."),
  });
  const body = (
    <>
      {q.isLoading ? <Skeleton lines={2} /> : q.error || !q.data ? (
        q.error instanceof ApiError && q.error.status === 403 ? <Alert tone="caution">{q.error.message}</Alert> : <ErrorState message="Could not load how this role's applicants apply." onRetry={() => q.refetch()} />
      ) : (
        <ApplyModeForm view={q.data} roleId={roleId} choice={choice ?? roleChoiceOf(q.data)} onChoice={setChoice} reason={reason} onReason={setReason} saving={save.isPending} onSave={(b) => save.mutate(b)} compact={compact} />
      )}
    </>
  );
  if (compact) return body;
  return (
    <Card title="How people apply (ITS only)">
      {body}
    </Card>
  );
}

function ApplyModeForm(props: { view: RoleApplyModeView; roleId: string; choice: RoleChoice; onChoice: (c: RoleChoice) => void; reason: string; onReason: (r: string) => void; saving: boolean; onSave: (body: { applyMode: RoleApplyModeView["applyMode"]; reason: string }) => void; compact: boolean }) {
  const { view, choice } = props;
  const change = roleApplyModeBody(view, choice, props.reason);
  const effective = choice === "default" ? view.companyDefault : choice;
  const changing = choice !== roleChoiceOf(view);
  return (
    <div className="stack gap-3">
      <p className="small text-ink-2">Now: <strong className="text-ink">{roleApplyModeLine(view)}</strong>.</p>
      <Field label="Applicants to this role" htmlFor={`apply-mode-${props.roleId}`}>
        <select id={`apply-mode-${props.roleId}`} className="select" value={choice} onChange={(e) => props.onChoice(e.target.value as RoleChoice)}>
          {roleChoices(view.companyDefault).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      {props.compact ? null : <p className="small muted">{APPLY_MODE_HELP[effective]}</p>}
      {changing ? (
        <>
          <Field label="Why (required, kept with the change)" htmlFor={`apply-mode-why-${props.roleId}`} hint={`At least ${REASON_MIN} characters.`}>
            <input id={`apply-mode-why-${props.roleId}`} className="input" value={props.reason} onChange={(e) => props.onReason(e.target.value)} placeholder="For example: the owner asked to review everyone before the screening chat" />
          </Field>
          <div className="row">
            <Button size="sm" variant="primary" disabled={!change} loading={props.saving} onClick={() => change && props.onSave(change)}>Save</Button>
            <Button size="sm" variant="quiet" onClick={() => { props.onChoice(roleChoiceOf(view)); props.onReason(""); }}>Cancel</Button>
          </div>
        </>
      ) : null}
      {props.compact ? null : <p className="small muted border-t border-line pt-3">{APPLY_MODE_NOTE}</p>}
    </div>
  );
}
