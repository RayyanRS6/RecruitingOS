"use client";

import { type MouseEvent, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { appPaths, type CloseRole, type ClosingDateAnswer, type PublishResult, type RoleActionKey, type RoleDetail, type SetClosingDate } from "@ros/contracts";
import { Alert, Button, Dialog, Field, Icon, Menu, PageHeader, Pill } from "@ros/ui";
import { api, errorWords, planLimitOf } from "../../api/client";
import { Upgrade } from "../../components/Upgrade";
import { calendarDay, todayIn, zoneWords } from "../../dates";
import { applyByOf, closingDateLine, closingDateProblem, headerActions, jobFacts, type JobTabId, jobTabs, statusTone } from "../../jobs";
import { useNavigate } from "../../nav";
import { toast } from "../../toast";

/** Everything that shows a job is read again after the job changes. */
export function useJobRefresh(roleId: string) {
  const qc = useQueryClient();
  return (role?: RoleDetail) => {
    if (role) qc.setQueryData(["role", roleId], role);
    else qc.invalidateQueries({ queryKey: ["role", roleId] });
    for (const key of [["roles"], ["home"], ["share", roleId], ["candidates", roleId]]) qc.invalidateQueries({ queryKey: key });
  };
}

/**
 * The header a job's three tabs share: the title, its status, one line of facts (where, the work arrangement, the type,
 * the pay, "Apply by …"), "Publish job" for a draft, and one menu with pause or resume, the closing date and close.
 * Each action is the API's (`role.actions`): one it does not list is not drawn, and one that is not allowed stays in the
 * menu, greyed, with the API's reason. Under it, the tabs as links: Candidates, Job, Share.
 */
export function JobHeader({ role, current }: { role: RoleDetail; current: JobTabId }) {
  const nav = useNavigate();
  const refresh = useJobRefresh(role.id);
  const [dialog, setDialog] = useState<"close" | "date" | null>(null);
  const [problem, setProblem] = useState<{ message: string; ask: { label: string; reason: string } | null } | null>(null);
  const failed = (err: unknown) => setProblem({ message: errorWords(err), ask: planLimitOf(err)?.ask ?? null });
  const { publish, menu } = headerActions(role.actions);
  const status = useMutation({
    mutationFn: (action: "pause" | "resume") => api.post<RoleDetail>(`/api/v1/roles/${role.id}/${action}`, {}),
    onMutate: () => setProblem(null),
    onSuccess: (r, action) => {
      toast(action === "pause" ? "Job paused." : "Job resumed.");
      refresh(r);
    },
    onError: failed,
  });
  const publishing = useMutation({
    mutationFn: () => api.post<PublishResult>(`/api/v1/roles/${role.id}/publish`, {}),
    onMutate: () => setProblem(null),
    onSuccess: () => {
      toast("Job published.");
      refresh();
      nav(appPaths.jobShare(role.id));
    },
    // what is still missing is listed on the Job tab, from the job itself
    onError: (err) => {
      failed(err);
      refresh();
    },
  });
  const pick = (id: string) => {
    const action = id as RoleActionKey;
    if (action === "pause" || action === "resume") {
      if (!status.isPending) status.mutate(action);
    } else if (action === "set_closing_date") setDialog("date");
    else if (action === "close") setDialog("close");
  };
  const facts = jobFacts(role.packet, applyByOf(role.closingDate, role.status));
  return (
    <>
      <PageHeader
        className="mb-1"
        title={role.title}
        status={<Pill tone={statusTone(role.status)} pulse={role.status === "open" && role.acceptingApplications}>{role.statusLabel}</Pill>}
        sub={facts.length ? facts.join(" · ") : undefined}
        actions={
          <>
            {publish ? <Button variant="primary" loading={publishing.isPending} disabled={!publish.allowed} title={publish.reason ?? undefined} onClick={() => publishing.mutate()}>{publish.label}</Button> : null}
            {menu.length ? (
              <Menu
                label={<><Icon name="more" size={16} />More</>}
                ariaLabel="More for this job"
                align="end"
                items={menu.map((a) => ({ id: a.action, label: a.label, disabled: !a.allowed, reason: a.reason ?? undefined, danger: a.action === "close" }))}
                onSelect={pick}
              />
            ) : null}
          </>
        }
      />
      <JobTabs items={jobTabs(role.id, role.counts)} current={current} />
      {publish && !publish.allowed && publish.reason ? <Alert tone="caution">{publish.reason}</Alert> : null}
      {problem ? (
        <Alert tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{problem.message}</span>
            {problem.ask ? <Upgrade label={problem.ask.label} size="sm" reason={problem.ask.reason} /> : null}
          </div>
        </Alert>
      ) : null}
      {dialog === "close" ? <CloseDialog role={role} onClose={() => setDialog(null)} onDone={refresh} /> : null}
      {dialog === "date" ? <ClosingDateDialog role={role} onClose={() => setDialog(null)} onDone={() => refresh()} /> : null}
    </>
  );
}

/**
 * A job's tabs as links, each its own address: the one being shown is marked as the current page. A plain click moves
 * within the app; a click with a modifier key, or the middle button, opens the tab the browser's way.
 */
function JobTabs(props: { current: JobTabId; items: ReturnType<typeof jobTabs> }) {
  const navigate = useNavigate();
  const go = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <nav aria-label="Job sections">
      <div className="tabs">
        {props.items.map((t) => (
          <a key={t.id} href={t.href} className="tab" aria-current={t.id === props.current ? "page" : undefined} onClick={(e) => go(e, t.href)}>
            <span className="tab-label" data-label={t.label}>{t.label}</span>
            {/* the space keeps "Candidates 12" two words for a screen reader; flex layout drops it on screen */}
            {t.count !== undefined ? <>{" "}<span className="count">{t.count}</span></> : null}
          </a>
        ))}
      </div>
    </nav>
  );
}

/** Closing is for good, so it is confirmed. Nobody is told anything by a close. */
function CloseDialog({ role, onClose, onDone }: { role: RoleDetail; onClose: () => void; onDone: (role: RoleDetail) => void }) {
  const close = useMutation({
    mutationFn: () => api.post<RoleDetail>(`/api/v1/roles/${role.id}/close`, { confirm: true } satisfies CloseRole),
    onSuccess: (r) => {
      toast("Job closed.");
      onDone(r);
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Close this job?"
      footer={<><Button variant="danger" loading={close.isPending} onClick={() => close.mutate()}>Close job</Button><Button variant="ghost" disabled={close.isPending} onClick={onClose}>Keep it open</Button></>}
    >
      <div className="stack gap-3">
        <p>This cannot be undone. The job stops taking applications, and nobody is emailed.</p>
        {close.error ? <Alert tone="critical">{errorWords(close.error, "Could not close the job.")}</Alert> : null}
      </div>
    </Dialog>
  );
}

/**
 * The closing date: the last day new applications are taken, in the company's time zone. A later date takes
 * applications again when an earlier one had stopped them. Where the law asks the ad for a date, it cannot be taken off.
 */
function ClosingDateDialog({ role, onClose, onDone }: { role: RoleDetail; onClose: () => void; onDone: () => void }) {
  const c = role.closingDate;
  const today = todayIn(c.timeZone);
  const [value, setValue] = useState(c.closesOn ?? c.defaultIfMissing ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (closesOn: string | null) => api.post<ClosingDateAnswer>(`/api/v1/roles/${role.id}/closing-date`, { closesOn } satisfies SetClosingDate),
    onSuccess: (r) => {
      const on = r.closingDate.closesOn;
      toast(on ? (r.reopened ? `Taking applications again until ${calendarDay(on)}.` : `Applications close at the end of ${calendarDay(on)}.`) : "Closing date taken off.");
      onDone();
      onClose();
    },
    onError: (err) => setProblem(errorWords(err, "Could not save the date. Try again.")),
  });
  const submit = () => {
    const p = closingDateProblem(value, c.timeZone);
    setProblem(p);
    if (!p) save.mutate(value);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Closing date"
      sub={closingDateLine(c)}
      footer={
        <>
          <Button variant="primary" loading={save.isPending} disabled={!value || value === c.closesOn} onClick={submit}>Save the date</Button>
          {c.closesOn && !c.requiredByLaw ? <Button variant="ghost" disabled={save.isPending} onClick={() => save.mutate(null)}>Take the date off</Button> : null}
        </>
      }
    >
      <div className="stack gap-3">
        <Field label="Last day to apply" htmlFor="closing-date" hint={`Ends at midnight, ${zoneWords(c.timeZone)}.`}>
          <input id="closing-date" className="input" type="date" min={today} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        {c.requiredByLaw ? <p className="small muted">The law where this job is asks the ad to say when applications close, so this job keeps a date.</p> : null}
        {problem ? <Alert tone="caution">{problem}</Alert> : null}
      </div>
    </Dialog>
  );
}
