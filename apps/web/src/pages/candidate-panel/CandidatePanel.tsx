"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Avatar, Button, Chip, Drawer, ErrorState, IconButton, Menu, type MenuItem, ScoreBadge, Skeleton, StageButton, TabPanel, Tabs, type OwnerStage } from "@ros/ui";
import { api, type ApplicationDetail } from "../../api/client";
import { canSeeActivity } from "../../roles";
import { isTextEntry } from "../../start-hire";
import { stageBlocked, stageIntent, type PanelStep } from "../../talent-actions";
import { resumeOnlyChip } from "../../talent-list";
import { NO_COMPOSE, PANEL_TABS, composeFor, hasUnsent, latestByTab, markSeen, neighbours, unreadTabs, type PanelTab, type SeenTabs } from "./helpers";
import { DraftContext, useCandidateAction, useViewer } from "./hooks";
import { matchOf, type NextStepAction } from "./match-view";
import { NeedsYou } from "./needs-you";
import { NotesTab } from "./notes";
import { type Compose, HistoryTab, MessagesTab, OverviewTab, ResumeTab, ScreenTab } from "./sections";

/**
 * The candidate panel (plan A10; founder decisions B3 and B6; Wave S1): a drawer with a sticky header (who, when they
 * applied, the score, Email, the stage button, More, next and previous), the decisions waiting for you under it (each one
 * line and its buttons, the rest behind "Why"), then the sections, the Overview first. The page keeps
 * the panel's place in the address (`?open=<id>&tab=…`). Moving to the next person never carries a half-filled form
 * over (everything under the header is keyed by the person), and unsent text is never thrown away without asking.
 * Nothing is fetched ahead for the neighbours: each opening is recorded as a view of that candidate.
 */
export type PanelProps = {
  id: string;
  roleId: string;
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

/**
 * The sections under the tabs (October 2026 redesign): each card's title is a small mono label over its content, like
 * screenshot 3's "Role brief draft", so the decisions above them, which keep their display titles on the wash, stand
 * out. A card that itself needs you (an AI review marked for a closer look) keeps its display title here too.
 */
const SECTION_CARDS = "[&_.card:not(.needs-you)>.card-title]:items-center [&_.card:not(.needs-you)>.card-title>h2]:font-mono [&_.card:not(.needs-you)>.card-title>h2]:text-[11px] [&_.card:not(.needs-you)>.card-title>h2]:font-normal [&_.card:not(.needs-you)>.card-title>h2]:uppercase [&_.card:not(.needs-you)>.card-title>h2]:tracking-[0.14em] [&_.card:not(.needs-you)>.card-title>h2]:text-ink-2";

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

  // Next and previous, by button or Alt+arrow; unsent text asks first. `moved` lets the live region say who is shown
  // after a move (not on opening, where the dialog's own name is read).
  const nav = neighbours(props.ids, id);
  const navBox = useRef<HTMLSpanElement>(null);
  const [moved, setMoved] = useState(false);
  const goTo = (to: string | null) => { if (to) guarded(() => { setMoved(true); props.onGo(to); }); };
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

  // After a move, focus that fell out of the panel comes back to it: the pressed button turned disabled at the end of
  // the list, or a section tab was focused while the next person loaded. The dialog itself takes it, so its new name
  // is read. Nothing happens when focus is still inside (the usual case: Previous and Next stay mounted).
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs again for each person shown (id), though the body does not read id
  useEffect(() => {
    if (!loaded) return;
    const dialog = navBox.current?.closest<HTMLElement>('[role="dialog"]');
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus({ preventScroll: true });
  }, [id, loaded]);

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
  // The Overview's suggested next step: its one button does what the stage button, a section or Email would.
  const onNext = (x: NextStepAction) => {
    if (x.kind === "move") onMove(x.to);
    else if (x.kind === "tab") onTab(x.tab);
    else openCompose();
  };
  const more: MenuItem[] = a
    ? [
        // Every applicant gets the AI interview by itself (20 Oct 2026); a person's invitation is a new link.
        { id: "invite_screen", label: "Send a new AI interview link", icon: "send", disabled: !a.allowedActions.includes("invite_screen"), reason: a.blockedReasons.invite_screen },
        { id: "record_outcome", label: "Record an outcome", icon: "edit", disabled: !a.allowedActions.includes("record_outcome"), reason: a.blockedReasons.record_outcome },
      ]
    : [];
  const onMore = (choice: string) => {
    if (choice === "invite_screen") act.mutate({ action: "invite_screen" });
    if (choice === "record_outcome") props.onStep("outcome");
  };
  const applied = a ? `Applied ${new Date(a.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : undefined;
  // The match score stays in sight on every section (founder decision B2); its breakdown is on the Overview. A score
  // with no AI interview in it says so beside it on every section too (R20-9), the full label on hover.
  const scored = a ? matchOf(a) ?? null : null;
  const score = scored?.score ?? null;
  const resumeOnly = scored ? resumeOnlyChip(scored) : null;
  const sub = applied && score !== null ? <>{applied} · <ScoreBadge score={score} size="sm" />{resumeOnly ? <> <span title={resumeOnly.title}><Chip tone="neutral">{resumeOnly.label}</Chip></span></> : null}</> : applied;

  return (
    <Drawer
      open
      size="lg"
      onClose={() => guarded(onClose)}
      title={name}
      sub={sub}
      leading={a ? <Avatar name={name} size="lg" /> : undefined}
      actions={
        // Previous and Next stay mounted while the next person loads (they depend only on the list), so the button a
        // keyboard user pressed keeps focus; the rest waits for the person. The two slots keep their order so React
        // reuses the same buttons.
        nav || a ? (
          <>
            {nav ? (
              <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-3 tabular-nums" ref={navBox}>
                <IconButton icon="chevron-up" size="sm" label="Previous candidate (Alt+Up)" disabled={!nav.prev} onClick={() => goTo(nav.prev)} />
                <span className="whitespace-nowrap px-0.5">{nav.index + 1} of {nav.total}</span>
                <IconButton icon="chevron-down" size="sm" label="Next candidate (Alt+Down)" disabled={!nav.next} onClick={() => goTo(nav.next)} />
                {/* one live region that stays mounted: after a move it says who is shown, once they have loaded */}
                <span className="sr-only" aria-live="polite">{moved && a ? `${name}, ${nav.index + 1} of ${nav.total}` : ""}</span>
              </span>
            ) : null}
            {a ? (
              <>
                <Button size="sm" icon="mail" disabled={!a.candidate.email} title={a.candidate.email ? `Write to ${a.candidate.firstName}` : "No email address on file"} onClick={openCompose}>Email</Button>
                <StageButton stage={a.ownerStage} label={a.ownerStageLabel} blocked={stageBlocked(a.stageMoves)} disabled={act.isPending} onMove={onMove} align="end" />
                <Menu label="More" items={more} onSelect={onMore} ariaLabel="More choices" align="end" />
              </>
            ) : null}
          </>
        ) : undefined
      }
      banner={
        leaving ? (
          <Alert tone="caution">
            <div className="row justify-between">
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
              {/* keyed by the section, so a switch fades the new one in (CSS: before any script, and not at all for less motion);
                  filled backwards only, so once the fade ends this wrapper is no containing block or layer for the sheets, the
                  dialog and the full-screen résumé drawn inside it; a long word or address breaks anywhere (it also stops
                  counting as the cards' narrowest width), so it never pushes a phone's screen sideways */}
              <div key={tab} className={`${SECTION_CARDS} wrap-anywhere motion-safe:animate-fade motion-safe:[animation-fill-mode:backwards]`}>
                {tab === "overview" ? <OverviewTab a={a} roleId={roleId} onHistory={() => onTab("history")} onNext={onNext} /> : null}
                {tab === "screen" ? <ScreenTab a={a} roleId={roleId} myRole={viewer.role} /> : null}
                {tab === "resume" ? <ResumeTab a={a} roleId={roleId} /> : null}
                {tab === "messages" ? <MessagesTab a={a} roleId={roleId} compose={composing} setCompose={setCompose} /> : null}
                {tab === "notes" ? <NotesTab applicationId={a.id} firstName={a.candidate.firstName} /> : null}
                {tab === "history" ? <HistoryTab a={a} mayReadActivity={canSeeActivity(viewer.role)} /> : null}
              </div>
            </TabPanel>
          </div>
        </DraftContext.Provider>
      )}
    </Drawer>
  );
}
