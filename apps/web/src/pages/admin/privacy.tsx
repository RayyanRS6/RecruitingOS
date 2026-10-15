"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, Dialog, Drawer, ErrorState, Field, Menu, nextSort, Skeleton, type SortDir, sortAnnouncement, sortRows, Table, type TableHead, Tabs } from "@ros/ui";
import { api, ApiError, type Me } from "../../api/client";
import { useNavigate, useSearchParams } from "../../nav";
import { toast } from "../../toast";
import { adminKeys, type CustomerRow, type DataRequest, partOf, reason, type SectionPart, type SectionProps } from "./admin-api";
import { exactWhen, privacyStatusWords, verificationWords, whenWords, wordFor } from "./admin-words";

/*
 * The console's Privacy requests section (redesign spec 3.2, Wave S6 slice S6-F): two parts, Open and Closed, each a
 * table of five columns; a button that opens the form for a request that came to the privacy mailbox; and the request
 * drawer, which keeps every step of today's sheet (verify, notes, assign, counsel, fulfil, decline, send the confirmation
 * again, preview the export). What is sent to the API is unchanged.
 */

const KIND_LABEL: Record<string, string> = { access: "Copy of their data", correct: "Correction", delete: "Deletion / anonymization", sms_opt_out: "Stop texts", human_review: "Human review", withdrawal: "Withdrawal" };
/** Where a request came from: the candidate's own status link, the public form (confirmed by an emailed link), the privacy mailbox, or the console. */
const SOURCE_LABEL: Record<string, string> = { status_page: "status page", email_form: "public form", email: "privacy mailbox", admin: "console" };
const STATUS_TONE: Record<string, "neutral" | "accent" | "needs" | "good" | "caution" | "critical"> = { received: "needs", in_progress: "accent", awaiting_counsel: "caution", fulfilled: "good", declined: "neutral" };
/** The candidate fields a correction can change (the API's names stay as they are; only the words on screen are plain). */
const CORRECTION_FIELDS: Array<[string, string]> = [["firstName", "First name"], ["lastName", "Last name"], ["email", "Email"], ["phone", "Phone"], ["locationText", "Location"]];
const CLOSED_STATUSES = ["fulfilled", "declined"];
/** A deadline this close (in days) is shown as coming up, as the Overview counts it (redesign spec 3.2). */
export const PRIVACY_DUE_SOON_DAYS = 5;

const kindWords = (kind: string) => wordFor(KIND_LABEL, kind);
const sourceWords = (channel: string) => wordFor(SOURCE_LABEL, channel);
const isVerified = (code: string) => code.startsWith("verified");
const verificationTone = (code: string) => (isVerified(code) ? "good" : code === "failed" ? "critical" : "caution");
const isClosed = (r: Pick<DataRequest, "status">) => CLOSED_STATUSES.includes(r.status);
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/** Whole days until the request's deadline: negative once it is overdue, 0 on the day it is due. */
export function privacyDaysLeft(r: Pick<DataRequest, "slaDueAt">, now: number = Date.now()): number {
  return Math.ceil((Date.parse(r.slaDueAt) - now) / 86_400_000);
}

/** How the open requests are ordered: null keeps the order they came in (newest first, as the API lists them). */
export type PrivacySort = { key: "received" | "due"; dir: SortDir } | null;

/** The open requests in the chosen order. */
export function sortRequests(rows: readonly DataRequest[], sort: PrivacySort): DataRequest[] {
  if (!sort) return [...rows];
  return sortRows(rows, sort.key === "due" ? (r) => Date.parse(r.slaDueAt) : (r) => Date.parse(r.createdAt), sort.dir);
}

/** The Sort chip's choices. The order they came in is the same as "Received, newest first", so that one is marked until someone sorts. */
export const PRIVACY_SORTS: Array<{ id: string; label: string; key: "received" | "due"; dir: SortDir }> = [
  { id: "received-descending", label: "Received, newest first", key: "received", dir: "descending" },
  { id: "received-ascending", label: "Received, oldest first", key: "received", dir: "ascending" },
  { id: "due-ascending", label: "Due, soonest first", key: "due", dir: "ascending" },
  { id: "due-descending", label: "Due, latest first", key: "due", dir: "descending" },
];
const SORT_HEADING = { received: "Received", due: "Due" } as const;

/** The parts of Privacy requests, each its own `?view=` (redesign spec 3.1). */
export const PRIVACY_PARTS: SectionPart[] = [{ id: "open", label: "Open" }, { id: "closed", label: "Closed" }];

/**
 * Privacy requests (docs/runbooks/privacy-requests.md): the recorded, deadline-tracked workflow. A deletion runs only
 * after a counsel decision is recorded and the administrator confirms; nothing here is automatic.
 *
 * The Privacy requests section (the contract in admin-api.ts). `?open=<request id>` in the address opens that request's
 * drawer, so the Overview and a link can land on it.
 */
export function PrivacySection({ view, onView }: SectionProps) {
  const part = partOf(PRIVACY_PARTS, view);
  const q = useQuery({ queryKey: adminKeys.privacy, queryFn: () => api.get<DataRequest[]>("/api/v1/admin/data-requests", reason), refetchInterval: 15000 });
  const [search] = useSearchParams();
  const nav = useNavigate();
  const openParam = search.get("open");
  const [openId, setOpenId] = useState<string | null>(openParam);
  // The drawer follows the address both ways: a link followed while this page is open opens its request, and choosing
  // the other part (the console drops ?open=) closes it, so a reload or Back shows what was on screen.
  useEffect(() => {
    setOpenId(openParam);
  }, [openParam]);
  const [recording, setRecording] = useState(false);
  const [sort, setSort] = useState<PrivacySort>(null);
  const [announce, setAnnounce] = useState("");

  const showRequest = (id: string | null) => {
    setOpenId(id);
    const next = new URLSearchParams(search);
    if (id) next.set("open", id);
    else next.delete("open");
    const qs = next.toString();
    nav(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
  };
  const sortBy = (next: NonNullable<PrivacySort>) => {
    setSort(next);
    setAnnounce(sortAnnouncement(SORT_HEADING[next.key], "date", next.dir));
  };

  const rows = q.data ?? [];
  const openRows = rows.filter((r) => !isClosed(r));
  const closedRows = rows.filter(isClosed);
  const items = PRIVACY_PARTS.map((p) => ({ ...p, count: q.data ? (p.id === "open" ? openRows.length : closedRows.length) : undefined }));
  const chosen: NonNullable<PrivacySort> = sort ?? { key: "received", dir: "descending" };
  const dueHead: TableHead = { label: "Due", sort: sort?.key === "due" ? sort.dir : null, onSort: () => sortBy(nextSort(sort, "due", "date", "ascending")) };

  return (
    <Tabs label="Privacy requests" value={part} onChange={onView} items={items}>
      <div className="stack">
        <div className="talent-toolbar">
          <p style={{ margin: 0, flex: "1 1 240px" }}>{q.data ? summaryLine(openRows, part) : " "}</p>
          {part === "open" ? (
            <Menu
              label={`Sort: ${PRIVACY_SORTS.find((c) => c.key === chosen.key && c.dir === chosen.dir)?.label ?? "Received, newest first"}`}
              heading="Sort by"
              currentLabel="Now"
              align="end"
              items={PRIVACY_SORTS.map((c) => ({ id: c.id, label: c.label, current: c.key === chosen.key && c.dir === chosen.dir }))}
              onSelect={(id) => {
                const c = PRIVACY_SORTS.find((s) => s.id === id);
                if (c) sortBy({ key: c.key, dir: c.dir });
              }}
            />
          ) : null}
          <Button size="sm" variant="primary" icon="plus" onClick={() => setRecording(true)}>Record a request from the privacy mailbox</Button>
        </div>
        {q.error ? (
          <ErrorState message="Could not load privacy requests." onRetry={() => q.refetch()} />
        ) : part === "closed" ? (
          <Table head={["Customer", "What they asked", "Resolved", "Status", ""]} label="Closed privacy requests" loading={q.isLoading ? 3 : 0} empty="No closed requests yet.">
            {closedRows.map((r) => (
              <tr key={r.id}>
                <td>{r.companyName ?? "Unknown customer"}</td>
                <td><AskedCell r={r} /></td>
                <td className="nowrap" title={exactWhen(r.resolvedAt)}>{whenWords(r.resolvedAt)}</td>
                <td><Chip tone={STATUS_TONE[r.status] ?? "neutral"}>{privacyStatusWords(r.status)}</Chip></td>
                <td><Button size="sm" variant="quiet" ariaLabel={openLabel(r)} onClick={() => showRequest(r.id)}>Open</Button></td>
              </tr>
            ))}
          </Table>
        ) : (
          <Table head={["Customer", "What they asked", dueHead, "Status", ""]} label="Open privacy requests" scroll announce={announce} loading={q.isLoading ? 4 : 0} empty="No open privacy requests.">
            {sortRequests(openRows, sort).map((r) => (
              <tr key={r.id}>
                <td>{r.companyName ?? "Unknown customer"}</td>
                <td><AskedCell r={r} /></td>
                <td className="nowrap" title={exactWhen(r.slaDueAt)}><DueWords r={r} /></td>
                <td>
                  <Chip tone={STATUS_TONE[r.status] ?? "neutral"}>{privacyStatusWords(r.status)}</Chip>
                  <div className="small muted">{verificationWords(r.verificationStatus)}</div>
                </td>
                <td><Button size="sm" ariaLabel={openLabel(r)} onClick={() => showRequest(r.id)}>Open</Button></td>
              </tr>
            ))}
          </Table>
        )}
      </div>
      {recording ? <RecordRequestDialog onClose={() => setRecording(false)} /> : null}
      {openId ? <PrivacyRequestDrawer key={openId} id={openId} onClose={() => showRequest(null)} /> : null}
    </Tabs>
  );
}

/** One quiet line over the open list: how many, how many are overdue, how many are due soon. */
function summaryLine(openRows: DataRequest[], part: string): string {
  if (part !== "open") return "Requests that were done or declined. Open one to read what was done.";
  if (openRows.length === 0) return "Nothing is waiting.";
  const left = openRows.map((r) => privacyDaysLeft(r));
  const overdue = left.filter((d) => d < 0).length;
  const soon = left.filter((d) => d >= 0 && d <= PRIVACY_DUE_SOON_DAYS).length;
  const bits = [`${openRows.length} open`];
  if (overdue) bits.push(`${overdue} overdue`);
  if (soon) bits.push(`${soon} due within ${PRIVACY_DUE_SOON_DAYS} days`);
  return bits.join(" · ");
}

const openLabel = (r: DataRequest) => `Open the request from ${r.companyName ?? "this customer"}: ${kindWords(r.kind)}`;

/** What the person asked for, and under it when it came in and from where. */
function AskedCell({ r }: { r: DataRequest }) {
  return (
    <>
      {kindWords(r.kind)}
      <div className="small muted" title={exactWhen(r.createdAt)}>Received {whenWords(r.createdAt)} · {sourceWords(r.channel)}</div>
    </>
  );
}

/** Days left before the deadline: "overdue" once it has passed, a caution chip when it is close. */
function DueWords({ r }: { r: DataRequest }) {
  const d = privacyDaysLeft(r);
  if (d < 0) {
    return (
      <>
        <Chip tone="critical">overdue</Chip>
        <div className="small muted">{days(-d)} late</div>
      </>
    );
  }
  if (d === 0) return <Chip tone="caution">due today</Chip>;
  if (d <= PRIVACY_DUE_SOON_DAYS) return <Chip tone="caution">{days(d)} left</Chip>;
  return <>{days(d)} left</>;
}

const EMPTY_FORM = { companyId: "", requesterEmail: "", kind: "access", details: "" };

/** "Record a request from the privacy mailbox": today's four fields in a dialog. What is sent is unchanged. */
function RecordRequestDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY_FORM);
  const customers = useQuery({ queryKey: adminKeys.customers, queryFn: () => api.get<Array<Pick<CustomerRow, "id" | "name">>>("/api/v1/admin/customers", reason) });
  const create = useMutation({
    mutationFn: () => api.post("/api/v1/admin/data-requests", { ...form, details: form.details || undefined }, reason),
    onSuccess: () => {
      toast("Recorded and acknowledged.");
      setForm(EMPTY_FORM);
      qc.invalidateQueries({ queryKey: adminKeys.privacy });
      onClose();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record."),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record a request from the privacy mailbox"
      sub="Only requests from the shared privacy mailbox. Verification stays pending until you confirm the sender."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!form.companyId || !form.requesterEmail} onClick={() => create.mutate()}>Record and acknowledge</Button>
        </>
      }
    >
      <div className="stack">
        <Field label="Customer" htmlFor="pr-co">
          <select id="pr-co" className="select" value={form.companyId} onChange={(e) => setForm({ ...form, companyId: e.target.value })}>
            <option value="">{customers.isLoading ? "Loading customers…" : "Choose"}</option>
            {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        {customers.error ? <ErrorState message="Could not load the customers." onRetry={() => customers.refetch()} /> : null}
        <Field label="Requester email" htmlFor="pr-em"><input id="pr-em" className="input" type="email" value={form.requesterEmail} onChange={(e) => setForm({ ...form, requesterEmail: e.target.value })} /></Field>
        <Field label="Kind" htmlFor="pr-kind">
          <select id="pr-kind" className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="What they wrote (summary)" htmlFor="pr-det"><input id="pr-det" className="input" value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}

/** Who the request is assigned to, in words: the reader, another administrator, or nobody yet. */
function assignedWords(assignedTo: string | null, myUserId: string | null | undefined): string {
  if (!assignedTo) return "Nobody yet";
  return assignedTo === myUserId ? "You" : "Another administrator";
}

/** The request drawer (redesign spec 3.2): where it stands first, then each step that is still open. */
function PrivacyRequestDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: adminKeys.privacyRequest(id), queryFn: () => api.get<DataRequest>(`/api/v1/admin/data-requests/${id}`, reason) });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const [note, setNote] = useState("");
  const [method, setMethod] = useState("");
  const [resolution, setResolution] = useState("");
  const [field, setField] = useState("phone");
  const [value, setValue] = useState("");
  const [confirmAnon, setConfirmAnon] = useState(false);
  const [counselNote, setCounselNote] = useState("");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: adminKeys.privacy });
    qc.invalidateQueries({ queryKey: adminKeys.privacyRequest(id) });
  };
  const act = useMutation({ mutationFn: (input: { path: string; body?: unknown }) => api.post(`/api/v1/admin/data-requests/${id}/${input.path}`, input.body ?? {}, reason), onSuccess: () => { toast("Recorded."); refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "That didn't work.") });
  const r = q.data;
  if (!r) {
    return (
      <Drawer open onClose={onClose} title="Privacy request">
        {q.error ? <ErrorState message="Could not load this privacy request." onRetry={() => q.refetch()} /> : <Skeleton lines={6} />}
      </Drawer>
    );
  }
  const verified = isVerified(r.verificationStatus);
  const closedReq = isClosed(r);
  const left = privacyDaysLeft(r);
  const title = [kindWords(r.kind), r.companyName].filter(Boolean).join(" · ");
  return (
    <Drawer open onClose={onClose} title={title} sub={`Received ${exactWhen(r.createdAt)} · from the ${sourceWords(r.channel)} · reference ${r.id.slice(0, 8)}`}>
      <div className="stack" style={{ gap: 12 }}>
        <dl className="kv">
          <dt>Status</dt>
          <dd><Chip tone={STATUS_TONE[r.status] ?? "neutral"}>{privacyStatusWords(r.status)}</Chip></dd>
          <dt>Verified</dt>
          <dd><Chip tone={verificationTone(r.verificationStatus)}>{verificationWords(r.verificationStatus)}</Chip></dd>
          <dt>Assigned</dt>
          <dd>
            <div className="row">
              <span>{assignedWords(r.assignedTo, me.data?.user.id)}</span>
              {!closedReq ? <Button size="sm" variant="secondary" onClick={() => act.mutate({ path: "assign", body: { userId: "me" } })}>Assign to me</Button> : null}
            </div>
          </dd>
          <dt>Due</dt>
          <dd>{exactWhen(r.slaDueAt)}{closedReq ? null : left < 0 ? <> · <Chip tone="critical">overdue</Chip></> : ` · ${left === 0 ? "due today" : `${days(left)} left`}`}</dd>
          <dt>From</dt>
          <dd>{r.requesterEmail}</dd>
          <dt>Candidate record</dt>
          <dd>{r.candidateId ? "linked" : "not linked"}</dd>
          <dt>What they wrote</dt>
          <dd style={{ whiteSpace: "pre-wrap" }}>{r.details ?? "none"}</dd>
          {r.verificationNote ? <><dt>How it was verified</dt><dd>{r.verificationNote}</dd></> : null}
          {r.escalationId ? <><dt>Escalation</dt><dd><a href={`/recruiter/queue/${r.escalationId}`}>open in the queue</a></dd></> : null}
        </dl>
        {!closedReq && !verified ? (
          <Card title="Verify the requester">
            <Field label="How you verified (for example: replied from the applying address on 18 Sep)" htmlFor="pr-method"><input id="pr-method" className="input" value={method} onChange={(e) => setMethod(e.target.value)} /></Field>
            <div className="row" style={{ marginTop: 8 }}><Button size="sm" variant="primary" disabled={method.length < 3} loading={act.isPending} onClick={() => act.mutate({ path: "verify", body: { method, outcome: "verified" } })}>Verified</Button><Button size="sm" variant="destructive" disabled={method.length < 3} onClick={() => act.mutate({ path: "verify", body: { method, outcome: "failed" } })}>Could not verify</Button></div>
          </Card>
        ) : null}
        <Card title="Notes">
          {r.notes.length ? <ul style={{ paddingLeft: 18, margin: 0 }}>{r.notes.map((n) => <li key={`${n.at}|${n.by}|${n.text}`}><span className="small muted">{exactWhen(n.at)} · {n.by}:</span> {n.text}</li>)}</ul> : <p className="small muted">None yet.</p>}
          {!closedReq ? <div className="row" style={{ marginTop: 8 }}><input aria-label="New note" className="input" style={{ flex: "1 1 200px", width: "auto" }} value={note} onChange={(e) => setNote(e.target.value)} /><Button size="sm" disabled={!note.trim()} onClick={() => { act.mutate({ path: "notes", body: { text: note } }); setNote(""); }}>Add note</Button></div> : null}
        </Card>
        {r.kind === "delete" && !closedReq ? (
          <Card title="Counsel decision (required before any anonymization)">
            <p className="small muted">Retention rules are under counsel review. Record the decision exactly as counsel gave it. Status: <strong>{r.counselDecision ?? "not asked"}</strong>{r.counselNote ? ` · ${r.counselNote}` : ""}</p>
            <Field label="Note" htmlFor="pr-cn"><input id="pr-cn" className="input" value={counselNote} onChange={(e) => setCounselNote(e.target.value)} /></Field>
            <div className="row" style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => act.mutate({ path: "escalate", body: { note: counselNote || undefined } })}>Send to counsel</Button>
              <Button size="sm" variant="primary" onClick={() => act.mutate({ path: "counsel", body: { decision: "approved", note: counselNote || undefined } })}>Counsel approved</Button>
              <Button size="sm" variant="destructive" onClick={() => act.mutate({ path: "counsel", body: { decision: "declined", note: counselNote || undefined } })}>Counsel declined</Button>
            </div>
          </Card>
        ) : null}
        {!closedReq ? (
          <Card title="Resolve">
            {r.kind === "correct" ? <div className="grid-2"><Field label="Field" htmlFor="pr-field"><select id="pr-field" className="select" value={field} onChange={(e) => setField(e.target.value)}>{CORRECTION_FIELDS.map(([f, l]) => <option key={f} value={f}>{l}</option>)}</select></Field><Field label="Corrected value" htmlFor="pr-value"><input id="pr-value" className="input" value={value} onChange={(e) => setValue(e.target.value)} /></Field></div> : null}
            {r.kind === "delete" ? <label className="row small" style={{ gap: 8 }}><input type="checkbox" checked={confirmAnon} onChange={(e) => setConfirmAnon(e.target.checked)} /> I confirm counsel approved this anonymization and I have checked for a litigation hold or a hire.</label> : null}
            {r.kind === "access" ? <p className="small"><a href={`/api/v1/admin/data-requests/${r.id}/export`}>Preview the export file</a> (audited).</p> : null}
            <Field label="What you did (the requester reads this)" htmlFor="pr-res"><textarea id="pr-res" className="textarea" rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} /></Field>
            {!verified ? <p className="small muted">Verify the requester before you fulfil the request.</p> : null}
            <div className="row" style={{ marginTop: 8 }}>
              <Button size="sm" variant="primary" disabled={!resolution.trim() || !verified || (r.kind === "correct" && !value) || (r.kind === "delete" && !confirmAnon)} loading={act.isPending} onClick={() => act.mutate({ path: "fulfil", body: { resolution, correction: r.kind === "correct" ? { field, value } : undefined, confirmAnonymize: r.kind === "delete" ? confirmAnon : undefined } })}>Fulfil and confirm to the requester</Button>
              <Button size="sm" variant="destructive" disabled={!resolution.trim()} onClick={() => act.mutate({ path: "decline", body: { resolution } })}>Decline with this explanation</Button>
            </div>
          </Card>
        ) : <Alert tone="info">{r.status === "fulfilled" ? "Done" : "Declined"} {exactWhen(r.resolvedAt)}: {r.resolution}{r.confirmationSentAt ? " · confirmation sent" : ""}</Alert>}
        {closedReq && r.kind === "delete" && !r.confirmationSentAt ? (
          // the email after the commit failed: nothing retries it on its own, so the console offers it
          <Alert tone="caution">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span>The requester has not been told yet: the confirmation email did not go.</span>
              <Button size="sm" variant="secondary" loading={act.isPending} onClick={() => act.mutate({ path: "confirm-again", body: {} })}>Send the confirmation again</Button>
            </div>
          </Alert>
        ) : null}
      </div>
    </Drawer>
  );
}
