"use client";

import { type MouseEvent, type ReactNode, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatPayRange } from "@ros/contracts";
import { Icon, Menu, PageHeader, Pill } from "@ros/ui";
import { api, ApiError, type RoleDetail, type RolePacket } from "../api/client";
import { useNavigate } from "../nav";
import { canDecline, canEditPacket, canManageRole, canRecordOutcome, canSeeTalent, canStartHire } from "../roles";
import { jobActions, jobTabHref, roleStatus, type JobAction, type JobTab } from "../role-status";
import { toast } from "../toast";
import { AcceptingSheet, type AcceptingMode } from "./RolePosting";
import { workModelLabel } from "./RolePlan";

/**
 * The one header and tab strip a job's pages share (Wave S1): /roles/:id (the job, its scoring, interview plan, sharing,
 * report and activity) and /roles/:id/talent (its candidates). The eyebrow names the company, the title the job, a pill
 * its status, one line under it; on the right "Bring in a recruiter" and a More menu with everything else.
 *
 * It draws what the page hands it. On the first draw (server and browser alike) a page hands it only what the server
 * also has: the rail's jobs list waits for useIsClient() (components/use-is-client.ts), so Candidates first says
 * "Candidates" on both sides and the job's title follows (Wave S2).
 */
export function JobHeader(props: { title: ReactNode; status: string | null; pulse?: boolean; companyName: string | null; sub?: ReactNode; actions?: ReactNode; noJob?: boolean }) {
  const s = props.status ? roleStatus(props.status) : null;
  // `noJob`: Candidates before there is any job to show (the page then names only the company)
  const eyebrow = props.noJob ? props.companyName ?? undefined : props.companyName ? `Job · ${props.companyName}` : "Job";
  return (
    <PageHeader
      eyebrow={eyebrow}
      title={props.title}
      status={s ? <Pill tone={s.tone} pulse={props.pulse}>{s.label}</Pill> : undefined}
      sub={props.sub}
      actions={props.actions}
    />
  );
}

/** The job's facts in one line: where, the kind of job, how it is worked, the pay, and "Apply by …" when it has a date. */
export function jobFacts(p: RolePacket | null | undefined, applyBy?: string | null): string | null {
  if (!p) return null;
  const place = [p.identity.locations[0]?.city, p.identity.locations[0]?.region].filter(Boolean).join(", ");
  return [place, p.identity.employmentType.replace(/_/g, " "), workModelLabel(p.identity.remotePolicy), formatPayRange(p.compensation), applyBy ?? ""].filter(Boolean).join(" · ");
}

/**
 * The header's facts line for a job as GET /roles/:id answers it: the version it runs on, with "Apply by …" (plan D7)
 * while a closing date is set and the job is not closed. Both of the job's pages show the same line.
 */
export function jobFactsFor(r: Pick<RoleDetail, "currentPacket" | "closingDate" | "status">): string | null {
  const applyBy = r.closingDate?.closesOn && r.status !== "closed" ? r.closingDate.applyBy : null;
  return jobFacts(r.currentPacket?.packet, applyBy);
}

/**
 * The job's tabs as links (Candidates is a page of its own): the one being shown is marked as the current page. A
 * plain click moves within the app; a click with a modifier key, or the middle button, opens the tab the browser's way.
 */
export function JobTabs(props: { roleId: string; current: JobTab; items: Array<{ id: JobTab; label: string; count?: number }> }) {
  const navigate = useNavigate();
  const go = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <nav aria-label="Job sections">
      <div className="tabs">
        {props.items.map((t) => {
          const href = jobTabHref(props.roleId, t.id);
          return (
            <a key={t.id} href={href} className="tab" aria-current={t.id === props.current ? "page" : undefined} onClick={(e) => go(e, href)}>
              <span className="tab-label" data-label={t.label}>{t.label}</span>
              {/* the space keeps "Candidates 12" two words for a screen reader; flex layout drops it on screen */}
              {t.count !== undefined ? <>{" "}<span className="count">{t.count}</span></> : null}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * The job's More menu: what the person may do with the job, from the same rules on both of its pages
 * (role-status.ts jobActions). Pausing, resuming and the accepting-applications switch happen right here; everything
 * else is the page's own (`on`), and an action the page does not handle is not offered. `role` is the job as
 * GET /roles/:id answers it; until it is read, `status` comes from the jobs list and the switch waits.
 */
export function JobMenu(props: { roleId: string; role: RoleDetail | null; status: string; myRole: string | null; on: Partial<Record<JobAction, () => void>>; comparing?: boolean | null; closingMessageOpen?: boolean }) {
  const qc = useQueryClient();
  const [accepting, setAccepting] = useState<AcceptingMode | null>(null);
  const r = props.role;
  const pause = useMutation({
    mutationFn: (action: "pause" | "resume") => api.post(`/api/v1/roles/${props.roleId}/${action}`, {}),
    // The jobs list too: the rail's dot and count for this job follow its status.
    onSuccess: async (_d, action) => { toast(action === "pause" ? "Job paused." : "Job resumed."); await qc.invalidateQueries({ queryKey: ["role", props.roleId] }); await qc.invalidateQueries({ queryKey: ["roles"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not change the job."),
  });
  const packet = r ? r.proposedPacket ?? r.currentPacket : null;
  const items = jobActions({
    status: r?.status ?? props.status,
    accepting: r ? r.acceptingApplications : null,
    closedByDate: !!r?.closingDate?.applicationsClosedByDate,
    // weights: "Try different weights" (L-07 A); the page decides the rest (a one-candidate grant, nobody scored yet)
    can: { manage: canManageRole(props.myRole), edit: canEditPacket(props.myRole) && !!packet, preview: canSeeTalent(props.myRole) && !!r?.currentPacket, close: canRecordOutcome(props.myRole), tell: canDecline(props.myRole), hireAgain: canStartHire(props.myRole), weights: canEditPacket(props.myRole) && canSeeTalent(props.myRole) && !!r?.currentPacket },
    comparing: props.comparing,
    closingMessageOpen: props.closingMessageOpen,
  }).filter((i) => BUILT_IN.includes(i.id) || !!props.on[i.id]);
  // The menu's button stays enabled while a pause or resume is on its way (disabling it would drop the keyboard's focus
  // to the page); a second pick meanwhile is ignored instead.
  const pick = (id: string) => {
    const action = id as JobAction;
    if (action === "pause" || action === "resume") { if (!pause.isPending) pause.mutate(action); }
    else if (action === "stop-accepting") setAccepting("stop");
    else if (action === "accept-again") setAccepting("reopen");
    else if (action === "extend-date") setAccepting("extend");
    else props.on[action]?.();
  };
  if (!items.length) return null;
  return (
    <>
      <Menu
        label={<><Icon name="more" size={16} />More</>}
        ariaLabel="More for this job"
        items={items.map((i) => ({ id: i.id, label: i.label, danger: i.danger }))}
        onSelect={pick}
        align="end"
      />
      {r ? <AcceptingSheet role={r} mode={accepting} onClose={() => setAccepting(null)} /> : null}
    </>
  );
}

/** The menu's actions JobMenu does itself. */
const BUILT_IN: readonly JobAction[] = ["pause", "resume", "stop-accepting", "accept-again", "extend-date"];
