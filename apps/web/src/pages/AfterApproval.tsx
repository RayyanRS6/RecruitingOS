"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Dialog, Icon, Skeleton, cx } from "@ros/ui";
import { api, type PostingsResponse } from "../api/client";
import { ShareJob } from "../components/ShareJob";
import { destinationsOf, interviewersNote, noBoardsLine, outdatedBoardsLine, pollInterval, type Destination, type StatusChip } from "../publishing";
import { toast } from "../toast";

/** How long the screen keeps asking after an approved change to a live job (see AfterApproval). */
const EDIT_SETTLE_MS = 30_000;

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}.`), () => toast("Could not copy. Select the text and copy it by hand."));
}

/** A status chip with a spinner while something is under way and a tick only once it was checked. */
export function StatusPill({ s }: { s: StatusChip }) {
  return (
    <span className={cx("pill", "sm", s.tone)}>
      {s.done ? <Icon name="check" size={14} /> : s.working ? <span className="spinner" aria-hidden="true" /> : <span className="dot" aria-hidden="true" />}
      {s.label}
    </span>
  );
}

function DestinationRow({ d }: { d: Destination }) {
  return (
    <li className="dest">
      <span className="dest-icon" aria-hidden="true"><Icon name={d.icon} size={16} /></span>
      <div className="dest-main">
        <span className="dest-name">{d.name}</span>
        <span className="dest-detail">{d.detail}</span>
        {d.copy || d.url ? (
          <span className="dest-actions">
            {d.copy ? <Button size="sm" icon="copy" onClick={() => copy(d.copy!.text, d.copy!.what)}>Copy</Button> : null}
            {d.url ? <a className="btn ghost sm" href={d.url} target="_blank" rel="noopener noreferrer"><Icon name="external" />Open<span className="sr-only"> {d.name} in a new tab</span></a> : null}
          </span>
        ) : null}
      </div>
      <span className="dest-status"><StatusPill s={d.status} /></span>
    </li>
  );
}

/**
 * The screen right after approval (plan D2): a calm confirmation with a tick for what is done (the approval), then
 * where the job is going, each place with a status that ticks only once it was checked: the careers page ("checking it
 * is up"), Google (marked found once someone sees it there), the email address for applications only while it works,
 * and each chosen board with who posts it. A note when no interviewers are set. "Share it now" opens the share block at
 * the top; "Go to your role" closes the screen. It asks the server again while publishing is under way (with the
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
    window.setTimeout(() => shareRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 50);
  };
  const preparing = !d || d.publishing.state === "preparing";
  const sub = props.editWhileOpen
    ? "Your careers page shows the new version now; Google picks it up the next time it reads the page."
    : d?.publishing.message ?? "Getting the job ready on its channels. This takes a moment.";
  const note = d ? interviewersNote(d.interviewers) : null;
  const noBoards = d && !props.editWhileOpen ? noBoardsLine(d.boards) : null;
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
          <Button variant="primary" onClick={props.onClose}>Go to your role</Button>
        </>
      }
    >
      {sharing ? (
        <section ref={shareRef} aria-label="Share it now" className="stack" style={{ gap: 8 }}>
          <h3 style={{ fontSize: 15 }}>Share it now</h3>
          <p className="small muted" style={{ margin: 0 }}>The quickest first applicants often come from people who already know you.</p>
          <ShareJob roleId={props.roleId} roleTitle={props.roleTitle} companyName={props.companyName} compact />
        </section>
      ) : null}
      <section aria-label="Where it is going" className="stack" style={{ gap: 8 }}>
        <h3 style={{ fontSize: 15 }}>{props.editWhileOpen ? "Where the job is" : "Where it is going"}</h3>
        {q.isLoading || !d ? <Skeleton lines={4} /> : (
          <>
            <ul className="dest-list" aria-busy={preparing || undefined}>
              {destinationsOf(d).map((x) => <DestinationRow key={x.key} d={x} />)}
            </ul>
            <p className="small muted" style={{ margin: 0 }}>Nothing is marked as up until it has been checked. This list keeps itself current while it is open.</p>
          </>
        )}
        {noBoards ? <p className="small muted" style={{ margin: 0 }}>{noBoards}</p> : null}
        {outdated ? <Alert tone="info">{outdated}</Alert> : null}
      </section>
      {note ? (
        <Alert tone="caution">
          <div className="stack" style={{ gap: 6 }}>
            <span>{note}</span>
            {props.canEditPacket ? <div className="row"><Button size="sm" onClick={() => goTo("plan")}>Choose interviewers</Button></div> : <span className="small">An owner, an admin or a hiring manager chooses them on the Interview plan tab.</span>}
          </div>
        </Alert>
      ) : null}
      {q.error ? <Alert tone="critical">Could not read where the job stands. The Posting tab shows it too.</Alert> : null}
      <p className="small muted" style={{ margin: 0 }}>
        {props.canManage ? <>Change the boards, the closing date or the links on the <button type="button" className="link-btn" onClick={() => goTo("posting")}>Posting tab</button>.</> : "Only an owner or an admin changes where the job is posted. The Posting tab shows where it stands."}
      </p>
    </Dialog>
  );
}
