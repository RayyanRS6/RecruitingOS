"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Avatar, Button, Drawer, ErrorState, IconButton, Menu, type MenuItem, ScoreBadge, Skeleton, StageButton, TabPanel, Tabs, type OwnerStage } from "@ros/ui";
import { api, type ApplicationDetail } from "../../api/client";
import { canSeeActivity } from "../../roles";
import { isTextEntry } from "../../start-hire";
import { stageBlocked, stageIntent, type PanelStep } from "../../talent-actions";
import { NO_COMPOSE, PANEL_TABS, composeFor, hasUnsent, latestByTab, markSeen, neighbours, unreadTabs, type PanelTab, type SeenTabs } from "./helpers";
import { DraftContext, useCandidateAction, useViewer } from "./hooks";
import { matchOf } from "./match-view";
import { NeedsYou } from "./needs-you";
import { NotesTab } from "./notes";
import { type Compose, HistoryTab, MessagesTab, OverviewTab, ResumeTab, ScreenTab } from "./sections";

/**
 * The candidate panel (plan A10; founder decisions B3 and B6): a drawer with a sticky header (who, when they applied, the
 * role, Email, the stage button, More, next and previous), what needs you under it, then the sections. The page keeps
 * the panel's place in the address (`?open=<id>&tab=…`). Moving to the next person never carries a half-filled form
 * over (everything under the header is keyed by the person), and unsent text is never thrown away without asking.
 * Nothing is fetched ahead for the neighbours: each opening is recorded as a view of that candidate.
 */
export type PanelProps = {
  id: string;
  roleId: string;
  roleTitle: string | null;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  step: PanelStep | null;
  roundKey?: string;
  onStep: (step: PanelStep | null, opts?: { roundKey?: string }) => void;
  /** The list as it was when the panel opened; null when the person is not in it (no next or previous then). */
  ids: string[] | null;
  onGo: (id: string) => void;
  onClose: () => void;
  /** `?message=1`: open on Messages with the text box ready. */
  composeOnOpen: boolean;
};

const SEEN_KEY = (id: string) => `ros:panel-seen:${id}`;

/** When this reader last opened each section of this candidate; kept in this browser only, and optional. */
function readSeen(id: string): SeenTabs | null {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY(id));
    return raw ? (JSON.parse(raw) as SeenTabs) : null;
  } catch {
    return null;
  }
}
function writeSeen(id: string, seen: SeenTabs): void {
  try {
    window.localStorage.setItem(SEEN_KEY(id), JSON.stringify(seen));
  } catch {
    // a private window or blocked storage: the markers simply do not show
  }
}

export function CandidatePanel(props: PanelProps) {
  const { id, roleId, tab, onTab, onClose } = props;
  const q = useQuery({ queryKey: ["application", id], queryFn: () => api.get<ApplicationDetail>(`/api/v1/applications/${id}`) });
  const a = q.data && q.data.id === id ? q.data : undefined;
  const viewer = useViewer();
  const act = useCandidateAction(id, roleId);

  // Unsent text, by field, for this person; the message being written is kept here so a section switch keeps it.
  const drafts = useRef<Record<string, string>>({});
  const report = useCallback((key: string, text: string) => { drafts.current[key] = text; }, []);
  const [compose, setComposeFor] = useState<Compose & { id: string }>({ id, ...(props.composeOnOpen ? { ...NO_COMPOSE, open: true } : NO_COMPOSE) });
  const composing = composeFor(compose, id);
  const setCompose = (next: Compose) => setComposeFor({ id, ...next });
  const [leaving, setLeaving] = useState<null | (() => void)>(null);
  const guarded = (go: () => void) => {
    if (hasUnsent({ ...drafts.current, subject: composing.subject, text: composing.text })) setLeaving(() => go);
    else go();
  };
  const discardAndGo = () => {
    const go = leaving;
    setLeaving(null);
    drafts.current = {};
    setComposeFor({ id, ...NO_COMPOSE });
    go?.();
  };

  // Next and previous, by button or Alt+arrow; unsent text asks first.
  const nav = neighbours(props.ids, id);
  const goTo = (to: string | null) => { if (to) guarded(() => props.onGo(to)); };
  const goRef = useRef(goTo);
  goRef.current = goTo;
  const navRef = useRef(nav);
  navRef.current = nav;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
      // Alt+Down opens a dropdown and moves in a text box: those keys stay theirs
      if (isTextEntry(e.target as HTMLElement | null)) return;
      const n = navRef.current;
      if (!n) return;
      e.preventDefault();
      goRef.current(e.key === "ArrowDown" ? n.next : n.prev);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Unread markers: what is newer than this reader's last look at each section.
  const [seen, setSeen] = useState<{ id: string; seen: SeenTabs } | null>(null);
  const loaded = !!a;
  useEffect(() => {
    if (!loaded) return;
    const next = markSeen(readSeen(id), tab, new Date());
    writeSeen(id, next);
    setSeen({ id, seen: next });
  }, [id, tab, loaded]);
  const unread = a && seen?.id === id ? unreadTabs(latestByTab(a), seen.seen, tab) : new Set<PanelTab>();

  const name = a ? `${a.candidate.firstName} ${a.candidate.lastName}`.trim() : "Candidate";
  const openCompose = () => { setCompose({ ...composing, open: true }); onTab("messages"); };
  const onMove = (to: OwnerStage) => {
    const move = a?.stageMoves.find((m) => m.to === to);
    if (!move) return;
    const intent = stageIntent(move);
    // a step opens at the top of the panel, above every section, so the section in view stays as it was
    if (intent.kind === "action") act.mutate(intent.body);
    else if (intent.kind === "step") props.onStep(intent.step);
  };
  const more: MenuItem[] = a
    ? [
        { id: "invite_screen", label: "Invite to a screen", icon: "send", disabled: !a.allowedActions.includes("invite_screen"), reason: a.blockedReasons.invite_screen },
        { id: "record_outcome", label: "Record an outcome", icon: "edit", disabled: !a.allowedActions.includes("record_outcome"), reason: a.blockedReasons.record_outcome },
      ]
    : [];
  const onMore = (choice: string) => {
    if (choice === "invite_screen") act.mutate({ action: "invite_screen" });
    if (choice === "record_outcome") props.onStep("outcome");
  };
  const applied = a ? `Applied ${new Date(a.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}${props.roleTitle ? ` · ${props.roleTitle}` : ""}` : undefined;
  // The match score stays in sight on every section (founder decision B2); its breakdown is on the Overview.
  const score = a ? matchOf(a)?.score ?? null : null;
  const sub = applied && score !== null ? <>{applied} · <ScoreBadge score={score} size="sm" /></> : applied;

  return (
    <Drawer
      open
      size="lg"
      onClose={() => guarded(onClose)}
      title={name}
      sub={sub}
      leading={a ? <Avatar name={name} size="lg" /> : undefined}
      actions={
        a ? (
          <>
            {nav ? (
              <span className="panel-nav">
                <IconButton icon="chevron-up" size="sm" label="Previous candidate (Alt+Up)" disabled={!nav.prev} onClick={() => goTo(nav.prev)} />
                <span aria-live="polite">{nav.index + 1} of {nav.total}</span>
                <IconButton icon="chevron-down" size="sm" label="Next candidate (Alt+Down)" disabled={!nav.next} onClick={() => goTo(nav.next)} />
              </span>
            ) : null}
            <Button size="sm" icon="mail" disabled={!a.candidate.email} title={a.candidate.email ? `Write to ${a.candidate.firstName}` : "No email address on file"} onClick={openCompose}>Email</Button>
            <StageButton stage={a.ownerStage} label={a.ownerStageLabel} blocked={stageBlocked(a.stageMoves)} disabled={act.isPending} onMove={onMove} align="end" />
            <Menu label="More" items={more} onSelect={onMore} ariaLabel="More choices" align="end" />
          </>
        ) : undefined
      }
      banner={
        leaving ? (
          <Alert tone="caution">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span>You have text here that is not sent or saved. Leave it?</span>
              <span className="row">
                <Button size="sm" variant="primary" onClick={discardAndGo}>Discard it and go on</Button>
                <Button size="sm" variant="quiet" onClick={() => setLeaving(null)}>Keep writing</Button>
              </span>
            </div>
          </Alert>
        ) : undefined
      }
      tabs={a ? <Tabs idBase="candidate-panel" label="Candidate sections" value={tab} onChange={(v) => onTab(v as PanelTab)} items={PANEL_TABS.map((t) => ({ id: t.id, label: t.label, marker: unread.has(t.id) }))} /> : undefined}
    >
      {q.error && !a ? <ErrorState message="Could not load this candidate. They may have been removed, or you may not have access." onRetry={() => q.refetch()} /> : !a ? <Skeleton lines={6} /> : (
        <DraftContext.Provider value={report}>
          <div key={id}>
            <NeedsYou a={a} roleId={roleId} myRole={viewer.role} myUserId={viewer.userId} step={props.step} setStep={props.onStep} roundKey={props.roundKey} onTab={onTab} />
            <TabPanel idBase="candidate-panel" value={tab}>
              {tab === "overview" ? <OverviewTab a={a} roleId={roleId} onHistory={() => onTab("history")} /> : null}
              {tab === "screen" ? <ScreenTab a={a} roleId={roleId} myRole={viewer.role} /> : null}
              {tab === "resume" ? <ResumeTab a={a} roleId={roleId} /> : null}
              {tab === "messages" ? <MessagesTab a={a} roleId={roleId} compose={composing} setCompose={setCompose} /> : null}
              {tab === "notes" ? <NotesTab applicationId={a.id} firstName={a.candidate.firstName} /> : null}
              {tab === "history" ? <HistoryTab a={a} mayReadActivity={canSeeActivity(viewer.role)} /> : null}
            </TabPanel>
          </div>
        </DraftContext.Provider>
      )}
    </Drawer>
  );
}
