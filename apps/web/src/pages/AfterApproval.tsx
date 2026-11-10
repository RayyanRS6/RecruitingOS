"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Dialog, Eyebrow, Icon, IconChip, Pill, Skeleton } from "@ros/ui";
import { api, type PostingsResponse } from "../api/client";
import { CATCH_UP_FOR_MS } from "./RolePlan";
import { ShareJob } from "../components/ShareJob";
import { scrollBehavior } from "../motion";
import { destinationsOf, interviewersNote, noBoardsLine, outdatedBoardsLine, pollInterval, type Destination, type StatusChip } from "../publishing";
import { toast } from "../toast";

/** How long the screen keeps asking after an approved change to a live job (see AfterApproval). */
const EDIT_SETTLE_MS = 30_000;

/** What the screen says once getting the job ready has taken as long as the job page waits for the worker (`CATCH_UP_FOR_MS`). */
export const OPENING_TAKES_LONGER = "This is taking longer than it should. The Share tab shows where it stands; if the job is not live in a few minutes, bring in a recruiter.";

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}.`), () => toast("Could not copy. Select the text and copy it by hand."));
}

/**
 * A status chip: the kit's Pill with a tick only once it was checked, its spinner (`busy`) while something is under way,
 * otherwise its dot. `className` places it.
 */
export function StatusPill({ s, className }: { s: StatusChip; className?: string }) {
  return <Pill size="sm" tone={s.tone} icon={s.done ? "check" : undefined} busy={!s.done && s.working} className={className}>{s.label}</Pill>;
}

/**
 * One place the job goes, as a row of the side card in screenshot 7: an icon chip, the place and what happens there (with
 * Copy and Open when it has an address), and its status on the right; on a narrow screen the status moves under it.
 */
function DestinationRow({ d }: { d: Destination }) {
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2 border-t border-line py-3.5 first:border-t-0">
      <IconChip icon={d.icon} size="sm" />
      <div className="grid min-w-0 flex-[1_1_14rem] gap-0.5">
        <span className="text-[15px] font-semibold text-ink">{d.name}</span>
        <span className="text-[13px] text-ink-2 [overflow-wrap:anywhere]">{d.detail}</span>
        {d.copy || d.url ? (
          <span className="mt-1.5 flex flex-wrap gap-2">
            {d.copy ? <Button size="sm" icon="copy" onClick={() => copy(d.copy!.text, d.copy!.what)}>Copy</Button> : null}
            {d.url ? <a className="btn ghost sm" href={d.url} target="_blank" rel="noopener noreferrer"><Icon name="external" />Open<span className="sr-only"> {d.name} in a new tab</span></a> : null}
          </span>
        ) : null}
      </div>
      {/* under the words on a phone: the chip's 32px and the 12px gap */}
      <StatusPill s={d.status} className="flex-none max-sm:ml-11" />
    </li>
  );
}

/**
 * The screen right after approval (plan D2): a calm confirmation with a tick for what is done (the approval), then
 * where the job is going, each place with a status that ticks only once it was checked: the careers page ("checking it
 * is up"), Google (marked found once someone sees it there), the email address for applications only while it works,
 * and each chosen board with who posts it. A plain line when no interviewers are named. "Share it now" opens the share block at
 * the top; "Go to your job" closes the screen. It asks the server again while publishing is under way (with the
 * worker separate from the web server, opening and preparing the channels takes a moment).
 *
 * For an approved change to a live job (`editWhileOpen`) it says the job page shows the new version and names the boards
 * still showing the earlier one. Read-only for anyone without role.manage: no buttons that change postings.
 */
export function AfterApproval(props: { open: boolean; onClose: () => void; roleId: string; roleTitle: string; companyName: string | null; editWhileOpen: boolean; canManage: boolean; canShare: boolean; canEditPacket: boolean; onOpenTab: (tab: "posting" | "plan") => void }) {
  // An approved change to a live job is made current by the approval workflow, which the publishing state does not
  // follow: for the first half minute the screen asks again every few seconds, so the boards it names are current.
  const openedAt = useRef(Date.now());
  const q = useQuery({
    queryKey: ["postings", props.roleId],
    queryFn: () => api.get<PostingsResponse>(`/api/v1/roles/${props.roleId}/postings`),
    enabled: props.open,
    refetchInterval: (query) => (!props.open ? false : props.editWhileOpen && Date.now() - openedAt.current < EDIT_SETTLE_MS ? 3000 : pollInterval(query.state.data?.publishing)),
  });
  const [sharing, setSharing] = useState(false);
  const shareRef = useRef<HTMLDivElement | null>(null);
  const d = q.data;
  const shareNow = () => {
    setSharing(true);
    window.setTimeout(() => shareRef.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() }), 50);
  };
  // An answer read before the approval, kept from the Share tab, says "not_open" with the role still pending: this screen opens after the approval.
  const preparing = !d || d.publishing.state === "preparing" || (d.publishing.state === "not_open" && d.role.status === "pending_approval");
  // Two minutes of "getting it ready" means something is stuck (6 November 2026): the words stop promising a moment.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!props.open || !preparing) { setSlow(false); return; }
    const t = window.setTimeout(() => setSlow(true), CATCH_UP_FOR_MS);
    return () => window.clearTimeout(t);
  }, [props.open, preparing]);
  const sub = props.editWhileOpen
    ? "Your careers page shows the new version now; Google picks it up the next time it reads the page."
    : (!preparing ? d?.publishing.message : null) ?? (slow ? OPENING_TAKES_LONGER : "Getting the job ready on its channels. This takes a moment.");
  const note = d ? interviewersNote(d.interviewers) : null;
  // Not while it is being got ready: until the worker opens the role the server has no boards to name, and the line would be wrong for a moment.
  const noBoards = d && !preparing && !props.editWhileOpen ? noBoardsLine(d.boards) : null;
  const outdated = props.editWhileOpen && d ? outdatedBoardsLine(d.postings.filter((p) => p.showsOldVersion).map((p) => p.channel), d.whoPosts) : null;
  const goTo = (tab: "posting" | "plan") => { props.onClose(); props.onOpenTab(tab); };
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={props.editWhileOpen ? "Your change is approved" : "Your job is approved"}
      sub={sub}
      mark="check"
      markTone="good"
      size="lg"
      footer={
        <>
          {props.canShare && !props.editWhileOpen && !sharing ? <Button icon="share" onClick={shareNow}>Share it now</Button> : null}
          <Button variant="primary" onClick={props.onClose}>Go to your job</Button>
        </>
      }
    >
      <div className="stack gap-5">
        {sharing ? (
          <section ref={shareRef} aria-label="Share it now" className="stack gap-2 rounded-2xl border border-line-tint bg-tint p-4">
            <Eyebrow as="h3">Share it now</Eyebrow>
            <ShareJob roleId={props.roleId} roleTitle={props.roleTitle} companyName={props.companyName} compact />
          </section>
        ) : null}
        <section aria-label="Where it is going" className="stack gap-2">
          <Eyebrow as="h3">{props.editWhileOpen ? "Where the job is" : "Where it is going"}</Eyebrow>
          {/* each place's status says where it stands (a tick only once checked, a spinner while under way); the list
              asks again by itself while it is open */}
          {q.isLoading || !d ? <Skeleton lines={4} /> : (
            <ul className="rounded-2xl border border-line bg-surface px-4" aria-busy={preparing || undefined}>
              {destinationsOf(d).map((x) => <DestinationRow key={x.key} d={x} />)}
            </ul>
          )}
          {noBoards ? <p className="small muted">{noBoards}</p> : null}
          {outdated ? <Alert tone="info">{outdated}</Alert> : null}
        </section>
        {/* a plain fact, not a caution: nobody needs naming before a date and time is set (the release review, 11 November 2026) */}
        {note ? (
          <p className="small muted">{note}{props.canEditPacket ? <> You can name them on the <button type="button" className="link-btn" onClick={() => goTo("plan")}>Interview plan tab</button>.</> : null}</p>
        ) : null}
        {q.error ? <Alert tone="critical">Could not read where the job stands. The Share tab shows it too.</Alert> : null}
        {/* the way to change where it goes, for those who may; nobody else is offered anything to change here */}
        {props.canManage ? (
          <p className="small muted">Change the boards, the closing date or the links on the <button type="button" className="link-btn" onClick={() => goTo("posting")}>Share tab</button>.</p>
        ) : null}
      </div>
    </Dialog>
  );
}
