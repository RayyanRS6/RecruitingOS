"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Field } from "@ros/ui";
import { api, ApiError, type ClosingDateResponse, type ClosingDateView } from "../api/client";
import { addDays, closingDateLine, closingDateProblem, closingDateToast, dayWords, todayIn, zoneWords } from "../publishing";
import { toast } from "../toast";

/**
 * The closing date (founder decision Q12, plan D7): the last day new applications are taken, in the company's time
 * zone. At the end of that day the job stops taking new applications; nobody is rejected, people part-way through can
 * finish, and closing the role stays a person's decision. A later date takes applications again. Colorado (and remote)
 * roles keep a date, so "Take the date off" is not offered for them. Saved on its own, straight away: it is not part of
 * the job's versions. Changing it needs role.manage; everyone else reads the sentence.
 */
export function ClosingDateField(props: { roleId: string; closingDate: ClosingDateView; canEdit: boolean; roleStatus: string; idBase?: string; onSaved?: (r: ClosingDateResponse) => void }) {
  const qc = useQueryClient();
  const c = props.closingDate;
  const today = todayIn(c.timeZone);
  const [value, setValue] = useState(c.closesOn ?? c.defaultIfMissing ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const id = `${props.idBase ?? "closing"}-date-${props.roleId}`;
  const save = useMutation({
    mutationFn: (closesOn: string | null) => api.post<ClosingDateResponse>(`/api/v1/roles/${props.roleId}/closing-date`, { closesOn }),
    onSuccess: async (r) => {
      const t = closingDateToast(r);
      toast(t.title, t.detail);
      setProblem(null);
      setValue(r.closingDate.closesOn ?? "");
      props.onSaved?.(r);
      for (const k of [["role", props.roleId], ["postings", props.roleId], ["brief"], ["roles"]]) await qc.invalidateQueries({ queryKey: k });
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : "Could not save the date. Try again."),
  });
  const submit = () => {
    const p = closingDateProblem(value, today);
    setProblem(p);
    if (!p) save.mutate(value);
  };
  const editable = props.canEdit && props.roleStatus !== "closed";
  return (
    <div className="stack gap-3">
      <p className="small text-ink-2">{closingDateLine(c)}</p>
      {editable ? (
        <>
          {/* the date field, then its buttons on their own line (the field's hint sits under it) */}
          <div className="max-w-[260px]">
            <Field label="Last day to apply" htmlFor={id} hint={`Ends at midnight, ${zoneWords(c.timeZone)}.`}>
              <input id={id} className="input" type="date" min={today} value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          </div>
          <div className="row">
            <Button variant="primary" size="sm" loading={save.isPending} disabled={!value || value === c.closesOn} onClick={submit}>{c.applicationsClosedByDate ? "Extend the date" : "Save the date"}</Button>
            {c.applicationsClosedByDate ? <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(addDays(today, 14))}>Two more weeks</Button> : null}
            {c.closesOn && !c.requiredByLaw ? <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>Take the date off</Button> : null}
          </div>
          {c.closesOn && c.requiredByLaw ? <p className="small muted">The law in Colorado asks the job ad to say when applications close, so this job keeps a date. Choose a later one to give people more time.</p> : null}
        </>
      ) : props.canEdit ? null : <p className="small muted">An owner or an admin sets the closing date.</p>}
      {problem ? <Alert tone="caution">{problem}</Alert> : null}
    </div>
  );
}

/**
 * The closing date in the job builder, before the role exists: kept on this draft in this browser and set on the role
 * the moment it is created (Builder.tsx). `required` says the law where the job is asks for one.
 */
export function DraftClosingDate(props: { value: string; onChange: (value: string) => void; required: boolean; timeZone?: string }) {
  const today = todayIn(props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const problem = props.value ? closingDateProblem(props.value, today) : null;
  return (
    <div className="stack gap-2">
      <Field label="Last day to apply (optional)" htmlFor="draft-closes-on" hint={props.required ? "The law in Colorado asks the job ad to say when applications close. Leave it empty and the job gets a date 30 days after it opens, which you can change." : "Leave it empty to take applications until you stop them. Nobody is turned away when the date passes; people part-way through can finish."}>
        <input id="draft-closes-on" className="input max-w-[220px]" type="date" min={today} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
      </Field>
      {props.value && !problem ? <p className="small muted">The job page will say "Apply by {dayWords(props.value)}". It is set on the role when you ask for approval.</p> : null}
      {problem ? <p className="small font-medium text-caution">{problem}</p> : null}
      {props.value ? <div className="row"><Button size="sm" variant="ghost" onClick={() => props.onChange("")}>Clear the date</Button></div> : null}
    </div>
  );
}
