"use client";

import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Avatar, Button, Card, Chip, ErrorState, Field, PageHeader, Pill, Segmented, Skeleton, Table, TabPanel, Tabs, type Tone, useTableSort } from "@ros/ui";
import { api, ApiError, type MyCalendar, type NewTimesSettingView } from "../api/client";
import { useSearchParams } from "../nav";
import { STILL_REVIEWING_LABEL, STILL_REVIEWING_NOTE, hasChoice, loosens, looseningQuestion, splitRules } from "../ai-rules";
import { NEW_TIMES_SETUP, newTimesReadOnlyText, newTimesSavedNotice, newTimesSettingFrom, newTimesSettingText, pendingQuestion, workingDaysFrom, type NewTimesSaved } from "../cancelled";
import { CAREERS_PAGE_WAITS, companyCheckOf } from "../company-check";
import { VERTICALS } from "../company-setup";
import { ABOUT_MAX, LOGO_TYPES, aboutCheckOf, aboutDraftOf, aboutProblem, logoProblem, logoUrlOf } from "../publishing";
import { LEVELS, allowedLevels, type PolicyLevel } from "../policy-levels";
import { ACCESS_DAYS, accessChip } from "../recruiter-access";
import { canChangeCompany, canSeeActivity, canStartHire } from "../roles";
import { SETTINGS_TABS, type SettingsTab, defaultTab, leadAndRest, settingsHref, settingsLanding, setupSections, tabFrom } from "../setup-sections";
import { browserStorage, SHORTCUT_CHANGED_EVENT, START_HIRE_KEY, setStartHireShortcut, startHireShortcutOn } from "../start-hire";
import { toast } from "../toast";
import { trialPlanLine, trialRow } from "../trial";
import { NotificationsCard } from "./NotificationsCard";
import { TeamCard } from "./TeamCard";
import type { TrialStanding } from "@ros/contracts";

type BusinessHours = { days: number[]; start: string; end: string };
/**
 * `about`: the short "about the company" text candidates read on the careers page and every job page, once a person
 * approved it (founder decision Q13); `boardPosting`: who posts on the job boards (plan D3); `zipRecruiterPlan`: the
 * company has its own paid ZipRecruiter plan, the only way ZipRecruiter is offered (Q11); `newTimesAfterCancel`: the one
 * automatic set of new times for candidates who cancel and ask for them, on or off, after how many working days (3A).
 */
type CompanySettings = { website?: string; logoUrl?: string; benefitsSummary?: string; careersPage?: { enabled: boolean; intro?: string }; businessHours?: BusinessHours; notices?: Record<string, { version: string; text: string }>; pilot?: { startedAt: string; endsAt: string; extendedUntil?: string }; about?: CompanyAbout | null; boardPosting?: "its" | "self"; zipRecruiterPlan?: boolean; newTimesAfterCancel?: { auto: boolean; workingDays: number } };
type CompanyAbout = { text: string; approvedAt: string; approvedBy?: { id?: string; name?: string | null } | null };
/** `trial`: where the Trial plan's 30 days stand (founder decision L-02 B), null on another plan; `usage.seats` counts people live. */
type Company ={ id: string; name: string; slug: string; vertical: string; sizeBand: string; timezone: string; planKey: string; status: string; plan?: { key: string; name: string; limits: Record<string, number | null> } | null; usage?: Record<string, { used: number; limit: number | null; resetsAt?: string | null }>; trial?: TrialStanding | null; locations: Array<{ city?: string; region?: string; country?: string }>; settings: CompanySettings; integrations: Array<{ kind: string; provider: string; status: string }>; ai: { provider: string } };
/**
 * minLevel and maxLevel: the floor and ceiling the API holds the action to; only the levels between them are offered.
 * available: whether the product does this today (plan B7); the rest are listed under "Coming later" with no choice.
 * settable: a level changes what happens; otherwise `does` says what the product does, with nothing to choose.
 */
type PolicyRow ={ group: string; actionType: string; level: PolicyLevel; approverRoles: string[]; source: string; locked: boolean; available?: boolean; settable?: boolean; does?: string | null; defaultLevel: PolicyLevel; minLevel?: PolicyLevel | null; maxLevel?: PolicyLevel | null };

export function Setup() {
  const qc = useQueryClient();
  const company = useQuery({ queryKey: ["company"], queryFn: () => api.get<Company>("/api/v1/companies/current") });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ user: { id: string }; activeCompanyId: string | null; memberships: Array<{ companyId: string; role: string }> }>("/api/v1/auth/me") });
  const myRole = me.data?.memberships.find((m) => m.companyId === me.data?.activeCompanyId)?.role ?? "";
  // policy.manage in packages/core/src/permissions.ts: owners and admins change the rules; everyone else reads them.
  const canManagePolicy = ["owner", "admin"].includes(myRole);
  const policies = useQuery({ queryKey: ["policies"], queryFn: () => api.get<PolicyRow[]>("/api/v1/policies") });
  // "Confirm it's you" (A12): a rule or notice change from an older session is refused until the person signs in again.
  const [reauthNeeded, setReauthNeeded] = useState(false);
  const [params] = useSearchParams();
  const reauthOutcome = params.get("reauth");
  const [loosening, setLoosening] = useState<{ row: PolicyRow; to: PolicyLevel } | null>(null);
  const setPolicy = useMutation({
    mutationFn: (p: { actionType: string; level: string; approverRoles: string[] }) => api.put("/api/v1/policies", p),
    onSuccess: () => { toast("Saved."); setReauthNeeded(false); setLoosening(null); qc.invalidateQueries({ queryKey: ["policies"] }); qc.invalidateQueries({ queryKey: ["audit-history"] }); },
    onError: (e) => { setLoosening(null); if (e instanceof ApiError && e.code === "reauth_required") { setReauthNeeded(true); toast("Confirm it's you first, then change the rule again."); } else toast(e instanceof ApiError ? e.message : "Could not save."); },
  });
  // Loosening a rule asks first (plan B7): the choice waits here until the person confirms it. Tightening saves at once.
  const choose = (row: PolicyRow, to: PolicyLevel) => {
    if (loosens(row.level, to)) setLoosening({ row, to });
    else { setLoosening(null); setPolicy.mutate({ actionType: row.actionType, level: to, approverRoles: row.approverRoles }); }
  };

  // The tabs (Wave S1): `?tab=` opens one; an old link's #hash (or the calendar coming back) opens the card's own tab and
  // scrolls to the card. A tab picked by hand writes `?tab=` into the address without reloading anything.
  const sections = setupSections({ mayStartHire: canStartHire(myRole), seesAudit: canSeeActivity(myRole) });
  const wantedTab = params.get("tab");
  const calendarBack = params.get("calendar");
  const [picked, setPicked] = useState<SettingsTab | null>(() => settingsLanding({ tab: wantedTab, calendar: calendarBack })?.tab ?? null);
  const [jump, setJump] = useState<string | null>(null);
  const ready = !!company.data;
  const active = picked ?? defaultTab(myRole);
  // A link followed while this page is open changes only the query string: follow it.
  useEffect(() => {
    const landing = settingsLanding({ tab: wantedTab, calendar: calendarBack });
    if (!landing) return;
    setPicked(landing.tab);
    if (landing.section) setJump(landing.section);
  }, [wantedTab, calendarBack]);
  // An old link's #hash ("/setup#setup-notifications"), on arrival and when a link on this page changes it.
  useEffect(() => {
    if (!ready) return;
    const follow = () => {
      const landing = settingsLanding({ hash: window.location.hash });
      if (!landing?.section) return;
      setPicked(landing.tab);
      setJump(landing.section);
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [ready]);
  // Once the card's tab is showing, bring the card into view (no animation, so reduced motion is respected) and move
  // focus to it, so the keyboard and a screen reader start there too; a card inside a fold opens it first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it runs again once the picked tab (active) has drawn the card
  useEffect(() => {
    if (!jump || !ready) return;
    const el = document.getElementById(jump);
    if (!el) return;
    const folded = el.closest("details");
    if (folded) folded.open = true;
    el.scrollIntoView({ block: "start" });
    el.focus({ preventScroll: true });
    setJump(null);
  }, [jump, active, ready]);
  const pick = (id: string) => {
    const next = tabFrom(id);
    if (!next) return;
    setPicked(next);
    setJump(null);
    window.history.replaceState(null, "", settingsHref(next, window.location.search));
  };

  if (company.isLoading) return <Skeleton lines={5} />;
  if (company.error || !company.data) return <ErrorState message="Could not load settings." onRetry={() => company.refetch()} />;
  const c = company.data;
  // What the product does today, with every "always a person" guarantee; the rest under "Coming later" (plan B7). Work
  // done the same way for everyone (nothing to choose) folds under its own "Show more", so the choices stand out.
  const rules = splitRules(policies.data ?? []);
  const choices = rules.now.filter((p) => hasChoice(p));
  const fixed = rules.now.filter((p) => !hasChoice(p));
  const groups = [...new Set(choices.map((p) => p.group))];
  const shown = new Set(sections.map((s) => s.tab));
  const tabs = SETTINGS_TABS.filter((t) => shown.has(t.id));
  const panel = (id: SettingsTab, children: ReactNode) => (
    // Every tab stays on the page, hidden until chosen, so a half-typed change survives a look at another tab.
    <div key={id} hidden={id !== active}>
      <TabPanel idBase={TABS_ID} value={id}>
        <div className="stack" style={{ gap: 18 }}>{children}</div>
      </TabPanel>
    </div>
  );
  const ruleRow = (p: PolicyRow) => (
    <div key={p.actionType} style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div><span>{actionLabel(p.actionType)}</span>{p.locked ? <Chip>always a person</Chip> : p.minLevel === "approval" ? <Chip>a person approves</Chip> : p.source !== "default" && hasChoice(p) ? <Chip tone="accent">customized</Chip> : null}</div>
        {!hasChoice(p) ? <Chip tone="neutral">Nothing to choose</Chip> : canManagePolicy ? (
          <Segmented value={loosening?.row.actionType === p.actionType ? loosening.to : p.level} onChange={(v) => choose(p, v)} options={allowedLevels(p)} ariaLabel={actionLabel(p.actionType)} />
        ) : <Chip tone="neutral">{levelLabel(p.level)}</Chip>}
      </div>
      {p.does ? <p className="small muted" style={{ margin: "4px 0 0" }}>{p.does}</p> : null}
      {ACTION_NOTE[p.actionType] ? <p className="small muted" style={{ margin: "4px 0 0" }}>{ACTION_NOTE[p.actionType]}</p> : null}
      {ACTION_MORE[p.actionType] ? <details className="more" style={{ marginTop: 4 }}><summary>What each choice does</summary><p className="small muted" style={{ margin: 0 }}>{ACTION_MORE[p.actionType]}</p></details> : null}
      {p.actionType === "message.still_reviewing" ? <p className="small muted" style={{ margin: "4px 0 0" }}>{STILL_REVIEWING_NOTE[p.level] ?? STILL_REVIEWING_NOTE.human_only}</p> : null}
      {loosening?.row.actionType === p.actionType ? (
        <div style={{ marginTop: 8 }}>
          <Alert tone="caution">
            <div className="stack" style={{ gap: 6 }}>
              <span>{looseningQuestion(actionLabel(p.actionType), p.level, loosening.to)}</span>
              <div className="row"><Button size="sm" variant="primary" loading={setPolicy.isPending} onClick={() => setPolicy.mutate({ actionType: p.actionType, level: loosening.to, approverRoles: p.approverRoles })}>Yes, change it</Button><Button size="sm" variant="quiet" onClick={() => setLoosening(null)}>Keep it as it is</Button></div>
            </div>
          </Alert>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader eyebrow={c.name} title="Settings" sub="Your company, team, alerts and hiring rules." />

      {reauthOutcome === "ok" ? <Alert tone="info">Thanks, that is confirmed. For the next ten minutes you can change the rules and the candidate notices, and make someone an admin or an owner.</Alert> : reauthOutcome === "mismatch" ? <Alert tone="critical">That sign-in was a different account. Confirm with the account you are signed in as.</Alert> : reauthOutcome === "failed" ? <Alert tone="critical">The confirmation did not complete. Try again.</Alert> : null}
      {reauthNeeded ? <ReauthPrompt returnTo={settingsHref(active)} /> : null}

      <div>
        <Tabs items={tabs.map((t) => ({ id: t.id, label: t.label }))} label="Settings" value={active} onChange={pick} idBase={TABS_ID} />

        {panel("company", <>
          <Section id="setup-company"><CompanyCard company={c} canEdit={["owner", "admin"].includes(myRole)} onReauthRequired={() => setReauthNeeded(true)} /></Section>
          <Section id="setup-profile"><CompanyProfileCard company={c} canEdit={canChangeCompany(myRole)} /></Section>
        </>)}

        {panel("team", <Section id="setup-team"><TeamCard myRole={myRole} myUserId={me.data?.user.id ?? ""} onReauthRequired={() => setReauthNeeded(true)} seats={c.usage?.seats} /></Section>)}

        {panel("notifications", <>
          <Section id="setup-notifications"><NotificationsCard /></Section>
          <Section id="setup-availability"><MyAvailability /></Section>
          {canStartHire(myRole) ? <Section id="setup-shortcut"><ShortcutCard /></Section> : null}
        </>)}

        {panel("rules", <>
          <Section id="setup-rules">
            <Card title="What the AI may do on its own">
              <p className="small muted" style={{ marginBottom: 6 }}>Choose how much the AI does without asking you.</p>
              <details className="more" style={{ marginBottom: 10 }}>
                <summary>How this works</summary>
                <p className="small muted" style={{ margin: 0 }}>What the product does today, and how much of it may happen without a person. Some decisions always stay with a person, and approving a job always waits for a person; those offer only the choices allowed. Work the product does the same way for everyone says what it does, with nothing to choose. Letting something happen with less checking asks you first, and every change is recorded.</p>
              </details>
              {!canManagePolicy && myRole ? <Alert tone="info">Only owners and admins change these rules. Ask one of them if something should work differently.</Alert> : null}
              {policies.isLoading ? <Skeleton lines={6} /> : groups.map((g) => (
                <div key={g} style={{ marginBottom: 14 }}>
                  <h3 style={{ marginBottom: 6 }}>{g}</h3>
                  <div className="stack" style={{ gap: 6 }}>
                    {choices.filter((p) => p.group === g).map(ruleRow)}
                  </div>
                </div>
              ))}
              {fixed.length ? (
                <details className="more" style={{ marginTop: 6 }}>
                  <summary>What it always does the same way ({fixed.length})</summary>
                  <div className="stack" style={{ gap: 6 }}>{fixed.map(ruleRow)}</div>
                </details>
              ) : null}
              {rules.later.length ? (
                <details className="more" style={{ marginTop: 6 }}>
                  <summary>Coming later ({rules.later.length})</summary>
                  <p className="small muted" style={{ margin: "0 0 6px" }}>Planned, not in the product yet, so there is nothing to choose. When one arrives it moves up into the list above, with its choices.</p>
                  <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
                    {rules.later.map((p) => <li key={p.actionType}>{actionLabel(p.actionType)}</li>)}
                  </ul>
                </details>
              ) : null}
              {setPolicy.error ? <Alert tone="critical">{setPolicy.error instanceof ApiError ? setPolicy.error.message : "Could not save."}</Alert> : null}
            </Card>
          </Section>
          <div className="grid-2">
            <Section id="setup-boards"><JobBoardsCard company={c} canEdit={canChangeCompany(myRole)} /></Section>
            <Section id="setup-new-times"><NewTimesCard company={c} canEdit={canChangeCompany(myRole)} onReauthRequired={() => setReauthNeeded(true)} /></Section>
          </div>
        </>)}

        {panel("security", <>
          <Section id="setup-sessions"><YourSessions /></Section>
          <Section id="setup-recruiters"><RecruiterAccess canRevoke={["owner", "admin"].includes(myRole)} /></Section>
          <Section id="setup-services">
            <Card title="Connected services">
              <Table head={["What", "Provider", "Status", "What it takes"]} empty="No services connected yet.">
                {c.integrations.map((i) => (
                  <tr key={`${i.kind}-${i.provider}`}>
                    <td>{SERVICE_KIND_LABEL[i.kind] ?? i.kind.replace(/_/g, " ")}</td>
                    <td>{SERVICE_PROVIDER_LABEL[i.provider] ?? i.provider.replace(/_/g, " ")}</td>
                    <td><Pill size="sm" tone={SERVICE_STATE_TONE[i.status] ?? "neutral"}>{SERVICE_STATE_LABEL[i.status] ?? i.status.replace(/_/g, " ")}</Pill></td>
                    <td className="small muted">{explainStatus(i, c.settings.boardPosting === "self" ? "self" : "its")}</td>
                  </tr>
                ))}
              </Table>
              <p className="small muted" style={{ marginTop: 8 }}>AI provider: <strong>{c.ai.provider}</strong>{c.ai.provider === "fake" ? " (deterministic stand-in for development; production refuses to start with it)" : ""}.</p>
            </Card>
          </Section>
          {canSeeActivity(myRole) ? <Section id="setup-audit"><AuditHistory /></Section> : null}
        </>)}
      </div>
    </div>
  );
}

/** The tab strip and its panels share these ids (aria-controls, aria-labelledby). */
const TABS_ID = "settings";

/** One card's place on its tab: old links jump here by id (#setup-notifications), stop short of the top edge and take focus. */
function Section({ id, children }: { id: string; children: ReactNode }) {
  return <div id={id} className="setup-section" tabIndex={-1}>{children}</div>;
}

/**
 * The N shortcut for Start a hire (WCAG 2.1.4: a one-letter shortcut can be turned off). Kept in this browser; the rail
 * hears the change at once. Shown to the people who may start a hire.
 */
function ShortcutCard() {
  const [on, setOn] = useState(true);
  useEffect(() => { setOn(startHireShortcutOn(browserStorage())); }, []);
  const change = (next: boolean) => {
    const kept = setStartHireShortcut(browserStorage(), next);
    setOn(next);
    window.dispatchEvent(new CustomEvent(SHORTCUT_CHANGED_EVENT, { detail: { on: next } }));
    toast(next ? `${START_HIRE_KEY} starts a hire again.` : `${START_HIRE_KEY} no longer starts a hire.`, kept ? undefined : "This browser would not save the choice, so it lasts until you reload the page.");
  };
  return (
    <Card title="Keyboard shortcut">
      <p className="small muted">Press {START_HIRE_KEY} on any page to start a hire.</p>
      <label className="small" style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
        <input type="checkbox" checked={on} onChange={(e) => change(e.target.checked)} />
        Press {START_HIRE_KEY} to start a hire
      </label>
      <details className="more" style={{ marginTop: 10 }}>
        <summary>How this works</summary>
        <p className="small muted" style={{ margin: 0 }}>It does nothing while you are typing in a box or have changed something on that page, so nothing you were working on is lost. Turn it off if it gets in your way, for example when you use speech input. This is saved in this browser only.</p>
      </details>
    </Card>
  );
}

/** Only verified states are shown (founder decision F4). */
const SERVICE_STATE_LABEL: Record<string, string> = { live: "Connected and working", awaiting_verification: "Submitted, awaiting verification", manual_action_required: "Manual action required", not_connected: "Not connected", fake: "Development stand-in", disabled: "Disabled" };
const SERVICE_STATE_TONE: Record<string, Tone> = { live: "good", awaiting_verification: "accent", manual_action_required: "caution", fake: "caution" };
/** What each service is and who provides it, in plain words (packages/integrations registry.ts names them in code). */
const SERVICE_KIND_LABEL: Record<string, string> = { email: "Email", sms: "Text messages", jobboard: "Job board", link_verifier: "Link checker", comp: "Pay data", storage: "File storage", scanner: "File scanner", secrets: "Key vault", identity: "Sign-in", calendar: "Calendar", analytics: "Analytics" };
const SERVICE_PROVIDER_LABEL: Record<string, string> = { careers_page: "Careers page", google_jobs: "Google for Jobs", indeed: "Indeed", ziprecruiter: "ZipRecruiter", linkedin_basic: "LinkedIn", email_in: "Email in", postmark: "Postmark", twilio: "Twilio", google: "Google" };

/**
 * What each connected service takes, in a line. The job boards are not connected to the product: ITS posts on them from
 * the company's own accounts (plan D3), or the team does when it chose to post itself (`whoPosts`).
 */
function explainStatus(i: { kind: string; provider: string; status: string }, whoPosts: "its" | "self" = "its"): string {
  if (i.status === "fake") return "Development stand-in: records what it would send. Never used in production.";
  if (i.provider === "careers_page") return "Served by the product; every open job has a public page and apply form.";
  if (i.provider === "google_jobs") return "Every job page carries the details Google reads. Google lists jobs on its own schedule; a job is marked found once someone sees it in a Google search.";
  if (i.provider === "email_in") return i.status === "live" ? "Forward application emails to each job's intake address." : "The inbound mail domain is not configured yet, so forwarded applications cannot arrive. Share the apply link directly.";
  if (["indeed", "ziprecruiter", "linkedin_basic"].includes(i.provider) && whoPosts === "its") return "Not connected to the product: ITS posts your jobs here from your company's own account, with each job's own apply link, and nothing is called up until its address is checked.";
  if (i.provider === "indeed") return "Not connected to Indeed. Post from your own Indeed account with the apply link, or forward applications to the intake address once email-in is connected.";
  if (i.provider === "ziprecruiter") return "Not connected to ZipRecruiter. Post from your own account with the apply link.";
  if (i.provider === "linkedin_basic") return "Not connected to LinkedIn. Post a free listing from your company page with the apply link.";
  if (i.provider === "postmark") return i.status === "live" ? "Candidate email is sent from the dedicated ITS domain." : "The sending domain is not configured; candidate email is not being sent.";
  if (i.provider === "twilio" || i.provider === "fake-sms") return "Text messaging is off until carrier registration and counsel review are complete. The screening chat runs on the web from an email link.";
  if (i.kind === "secrets") return i.status === "live" ? "Connected credentials are kept in the managed key vault." : "Development stand-in; production uses the managed key vault.";
  if (i.kind === "comp") return i.status === "live" ? "Public wage data from the Bureau of Labor Statistics." : "Wage benchmarks unavailable; playbook ranges are used and cited.";
  return "";
}

function levelLabel(l: string): string {
  return LEVELS.find((x) => x.value === l)?.label ?? l;
}

/** Each rule in a few words: the name a person scans, and what its choice buttons are called for a screen reader. */
function actionLabel(a: string): string {
  return ({
    "role_packet.approve": "Approve a drafted job, pay included", "posting.sponsor_spend": "Spend on sponsored ads within budget",
    "application.triage": "Read and assess applicants (information only)", "application.hold_ineligible": "Hold an applicant who answers no to an eligibility question", "application.reject_ineligible": "Decline an applicant held on an eligibility answer",
    "application.reject_on_assessment": "Decline a candidate on judgment", "application.invite_screen": "Invite every applicant to the AI interview", "screen.conduct": "Run the AI interview",
    "application.recommend_interview": "Recommend who to interview", "message.send_templated": "Send confirmations and reminders", "message.send_freeform": "Send a message a team member wrote to a candidate",
    "disposition.send": "Send the decision message when someone presses Send",
    "message.still_reviewing": STILL_REVIEWING_LABEL,
    "interview.request": "Advance someone to an interview", "interview.schedule": "Book interviews on calendars",
    "interview.reschedule": "Reschedule an interview", "interview.record": "Record an interview (with consent)", "scorecard.draft": "Draft scorecards for interviewers",
    "debrief.recommend": "Recommend a finalist", "candidate.hire_decision": "Decide who to hire", "offer.draft": "Draft an offer", "offer.send": "Send an offer",
    "offer.negotiate": "Negotiate an offer", "offer.revise": "Revise an offer", "reference.request": "Request references", "background_check.order": "Order a background check",
    "background_check.adverse_action": "Act on a background check", "employee.create_in_hris": "Create the new hire in payroll/HR", "welcome.send": "Send welcome and start reminders",
    "checkin.request": "Ask how the hire is going at 30/60/90 days", "intervention.nudge": "Nudge when a job is stuck", "intervention.offer_recruiter": "Offer a recruiter when stuck",
    "sourcing.search_internal": "Search your own talent pool", "sourcing.enrich_external": "Look up outside candidates (uses credits)", "outreach.send": "Reach out to outside candidates",
    "policy.change": "Change these rules", "knockout_rule.change": "Change eligibility rules", "notice_text.change": "Change candidate notices", "data.delete": "Delete candidate data", "data.export": "Export data",
  } as Record<string, string>)[a] ?? a;
}

/** A short line under a rule, said in full on view. */
const ACTION_NOTE: Record<string, string> = {
  "application.hold_ineligible": "It reminds you, and never declines anyone.",
  "message.send_freeform": "Ask me first or Only a person: an owner or admin reads it first. Their own messages go at once.",
};

/**
 * What each choice of a rule does, when that takes more than a line: one click away under the rule. The decision
 * message says what happens after five working days in every case (founder decision D-03 = A, 14 Oct 2026).
 */
const ACTION_MORE: Record<string, string> = {
  "disposition.send": "Declining never sends anything by itself. Do it: the message goes when someone presses Send, and if nobody has told someone five working days after a decision, the standard message goes by itself and you are told. Ask me first: a second person approves it, and a recruiter is brought in instead of the message going by itself. Only a person: the app sends none and you tell candidates yourself, and if nobody has after five working days a recruiter is brought in to make sure they hear from you.",
};

/**
 * Whether "Connect Google Calendar" can work on this deployment: only with the real Google provider set up. The
 * development stand-in ("fake") has no consent page in production, so its button led to a page that was not found, and
 * Google without its keys ("not_connected") refuses the connection.
 */
export function calendarConnectOffered(providers: MyCalendar["providers"] | undefined): boolean {
  return !!providers?.some((p) => p.key === "google" && p.status === "live");
}
export const CALENDAR_OFF_LINE = "Calendar connection is not switched on for this workspace yet. Interviews are scheduled with the times you set below.";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ZONES = ["America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago", "America/New_York"];

/** My availability (docs/04 /setup/availability): a calendar connection, or declared windows, or both (windows constrain the calendar). */
function MyAvailability() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const q = useQuery({ queryKey: ["me", "calendar"], queryFn: () => api.get<MyCalendar>("/api/v1/me/calendar") });
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [windows, setWindows] = useState<Record<number, { on: boolean; start: string; end: string }>>(Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { on: d >= 1 && d <= 5, start: "09:00", end: "17:00" }])));
  const [bufferMinutes, setBuffer] = useState(15);
  const [maxPerDay, setMax] = useState(3);
  const [loaded, setLoaded] = useState(false);
  if (q.data && !loaded) {
    setLoaded(true);
    if (q.data.availability) {
      setTimezone(q.data.availability.timezone);
      setBuffer(q.data.availability.bufferMinutes);
      setMax(q.data.availability.maxPerDay);
      const next = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { on: false, start: "09:00", end: "17:00" }])) as Record<number, { on: boolean; start: string; end: string }>;
      for (const w of q.data.availability.windows) next[w.day] = { on: true, start: w.start, end: w.end };
      setWindows(next);
    }
  }
  const save = useMutation({
    mutationFn: () => api.put("/api/v1/me/availability", { timezone, windows: Object.entries(windows).filter(([, w]) => w.on).map(([d, w]) => ({ day: Number(d), start: w.start, end: w.end })), bufferMinutes, maxPerDay }),
    onSuccess: async () => { toast("Availability saved. Any interview waiting on it moves ahead."); await qc.invalidateQueries({ queryKey: ["me", "calendar"] }); await qc.invalidateQueries({ queryKey: ["members"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save."),
  });
  const disconnect = useMutation({ mutationFn: () => api.post("/api/v1/integrations/calendar/google/disconnect", { reason: "disconnected from Setup" }), onSuccess: async () => { toast("Disconnected. The credential is being deleted."); await qc.invalidateQueries({ queryKey: ["me", "calendar"] }); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not disconnect.") });
  const c = q.data?.connection;
  const connectable = calendarConnectOffered(q.data?.providers);
  const connected = !!c && c.status !== "not_connected";
  const calParam = params.get("calendar");
  return (
    <Card title="My availability for interviews">
      {calParam === "connected" ? <Alert tone="info">Calendar connected. Interviews now use your real free time.</Alert> : calParam && calParam !== "connected" ? <Alert tone="critical">The calendar connection did not complete ({calParam.replace(/_/g, " ")}). Try again.</Alert> : null}
      <p className="small muted" style={{ marginBottom: 10 }}>When you can interview. Candidates are offered times from here.</p>
      <div className="stack" style={{ gap: 12 }}>
        <div>
          <h3 style={{ marginBottom: 6 }}>Calendar</h3>
          {q.isLoading ? <Skeleton lines={2} /> : c && connected ? (
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span>{c.provider} · {c.externalAccountId} <Pill size="sm" tone={c.status === "live" ? "good" : "caution"}>{c.status === "live" ? "connected" : c.status.replace(/_/g, " ")}</Pill>{c.lastError ? <span className="small muted"> {c.lastError}</span> : null}</span>
              <div className="row">{c.status !== "live" && connectable ? <a className="btn secondary sm" href="/api/v1/integrations/calendar/google/connect">Reconnect</a> : null}<Button size="sm" variant="quiet" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</Button></div>
            </div>
          ) : connectable ? (
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="small muted">Not connected. Until you connect, your hours below are used.</span>
              <a className="btn primary sm" href="/api/v1/integrations/calendar/google/connect">Connect Google Calendar</a>
            </div>
          ) : <p className="small muted" style={{ margin: 0 }}>{CALENDAR_OFF_LINE}</p>}
          {connectable || connected ? (
            <details className="more" style={{ marginTop: 6 }}>
              <summary>How this works</summary>
              <p className="small muted" style={{ margin: 0 }}>With a calendar, times are offered from your real free time; without one, your declared hours below are used. We ask only for events on your calendar and free/busy times. Disconnecting deletes the credential; you can see when that is done.</p>
            </details>
          ) : null}
        </div>
        <div>
          <h3 style={{ marginBottom: 6 }}>Declared hours</h3>
          <Field label="Time zone" htmlFor="av-tz"><select id="av-tz" className="select" value={timezone} onChange={(e) => setTimezone(e.target.value)}>{[...new Set([timezone, ...ZONES])].map((z) => <option key={z} value={z}>{z}</option>)}</select></Field>
          <div className="stack" style={{ gap: 4 }}>
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <div key={d} className="row small" style={{ gap: 8, alignItems: "center" }}>
                <label style={{ width: 110 }}><input type="checkbox" checked={windows[d].on} onChange={(e) => setWindows({ ...windows, [d]: { ...windows[d], on: e.target.checked } })} /> {DAY_NAMES[d]}</label>
                <input aria-label={`${DAY_NAMES[d]} start`} className="input" type="time" style={{ width: 130 }} disabled={!windows[d].on} value={windows[d].start} onChange={(e) => setWindows({ ...windows, [d]: { ...windows[d], start: e.target.value } })} />
                <span>to</span>
                <input aria-label={`${DAY_NAMES[d]} end`} className="input" type="time" style={{ width: 130 }} disabled={!windows[d].on} value={windows[d].end} onChange={(e) => setWindows({ ...windows, [d]: { ...windows[d], end: e.target.value } })} />
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <Field label="Buffer between interviews (minutes)" htmlFor="av-buf"><input id="av-buf" className="input" type="number" min={0} max={120} value={bufferMinutes} onChange={(e) => setBuffer(Number(e.target.value))} /></Field>
            <Field label="Most interviews per day" htmlFor="av-max"><input id="av-max" className="input" type="number" min={1} max={12} value={maxPerDay} onChange={(e) => setMax(Number(e.target.value))} /></Field>
          </div>
          <div style={{ marginTop: 8 }}><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save availability</Button></div>
        </div>
      </div>
    </Card>
  );
}

type Grant = { id: string; kind: string; purpose: string; escalationId: string | null; roleId: string | null; roleTitle: string | null; applicationId: string | null; startsAt: string; expiresAt: string; endedAt: string | null; revokedAt: string | null; revokeReason: string | null; recruiterName: string | null; recruiterEmail: string; active: boolean };

/** ITS recruiter access (founder decision F10; item 1 of 21 Sep): visible to everyone on the team; owners and admins can end it now. */
function RecruiterAccess({ canRevoke }: { canRevoke: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["staff-access"], queryFn: () => api.get<Grant[]>("/api/v1/companies/current/staff-access"), refetchInterval: 20000 });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const revoke = useMutation({
    mutationFn: (id: string) => api.post<{ recruiterNotified: boolean }>(`/api/v1/companies/current/staff-access/${id}/revoke`, { reason, confirm: true }),
    onSuccess: async (r) => { toast(r.recruiterNotified ? "Access ended. The recruiter has been told and your activity log records it." : "Access ended and recorded. The email to the recruiter failed; ITS has been alerted to tell them another way."); setConfirming(null); setReason(""); await qc.invalidateQueries({ queryKey: ["staff-access"] }); await qc.invalidateQueries({ queryKey: ["staff-audit"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not end the access."),
  });
  const active = (q.data ?? []).filter((g) => g.active);
  const past = (q.data ?? []).filter((g) => !g.active).slice(0, 10);
  return (
    <Card title="ITS recruiter access">
      <p className="small muted">Which ITS recruiters can see your hiring, and until when.</p>
      <details className="more" style={{ marginTop: 6 }}>
        <summary>How this works</summary>
        <p className="small muted" style={{ margin: 0 }}>A recruiter gets access when your team asks for one, and also when the system brings one in on its own: a candidate asks for a person, or something gets stuck. A request about one candidate or one job gives access to that alone; all of your hiring only when someone on your team chose that. Access ends a day after the request is resolved, or after {ACCESS_DAYS} days at most, and you are told when a recruiter starts. Reopening an answered request gives fresh access, listed here like any other. Every page they open is recorded in your activity. {canRevoke ? "You can end it at any time." : "Owners and admins can end it at any time."}</p>
      </details>
      {q.isLoading ? <Skeleton lines={2} /> : active.length === 0 ? <p className="small muted" style={{ marginTop: 8 }}>No recruiter has access right now.</p> : (
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          {active.map((g) => (
            <div key={g.id} className="stack" style={{ gap: 6, padding: "8px 0", borderTop: "1px solid var(--line)" }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span><strong>{g.recruiterName ?? g.recruiterEmail}</strong> <span className="small muted">· {g.purpose}</span></span>
                <Chip tone="accent">{accessChip(g)}</Chip>
              </div>
              <span className="small muted">Ends {new Date(g.expiresAt).toLocaleString()}{g.escalationId ? ", or a day after the request is resolved if that is sooner" : ""}.</span>
              {canRevoke ? (
                confirming === g.id ? (
                  <div className="stack" style={{ gap: 6 }}>
                    <Field label="Why you are ending it (the recruiter sees this)" htmlFor={`rv-${g.id}`}><input id={`rv-${g.id}`} className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                    <div className="row"><Button size="sm" variant="destructive" disabled={reason.trim().length < 5} loading={revoke.isPending} onClick={() => revoke.mutate(g.id)}>End access now</Button><Button size="sm" variant="quiet" onClick={() => { setConfirming(null); setReason(""); }}>Keep it</Button></div>
                  </div>
                ) : <div className="row"><Button size="sm" variant="secondary" onClick={() => { setConfirming(g.id); setReason(""); }}>End this recruiter's access</Button></div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      <AccessHistory />
      {past.length ? <details style={{ marginTop: 10 }}><summary className="small">Past access ({past.length})</summary><ul className="small" style={{ paddingLeft: 18, marginTop: 6 }}>{past.map((g) => <li key={g.id}>{g.recruiterName ?? g.recruiterEmail} · {g.purpose} · {g.revokedAt ? `ended early: ${g.revokeReason ?? "released"}` : `ended ${g.endedAt ? new Date(g.endedAt).toLocaleDateString() : "at expiry"}`}</li>)}</ul></details> : null}
    </Card>
  );
}

type AuditRow = { id: string; action: string; description: string; actor: { kind: string; name: string | null }; reason: string | null; at: string; details: Record<string, unknown> };
const ACTION_LABEL: Record<string, string> = { "staff.access_granted": "Access granted", "staff.access_ended": "Access ended", "staff.access_revoked": "Access ended by your team", "admin.break_glass": "Emergency access by an ITS administrator" };
const ACCESS_ACTIONS = "staff.access_granted,staff.access_ended,staff.access_revoked,admin.break_glass";

/** The customer's own record of recruiter access: who acted, when, and why. */
function AccessHistory() {
  const q = useQuery({ queryKey: ["staff-audit"], queryFn: () => api.get<AuditRow[]>(`/api/v1/companies/current/audit?limit=20&actions=${ACCESS_ACTIONS}`), retry: false });
  if (q.error || !q.data?.length) return null;
  return (
    <details style={{ marginTop: 10 }}>
      <summary className="small">Access history ({q.data.length})</summary>
      <ul className="small" style={{ paddingLeft: 18, marginTop: 6 }}>
        {q.data.map((r) => <li key={r.id}>{new Date(r.at).toLocaleString()} · {ACTION_LABEL[r.action] ?? r.action} · by {r.actor.name ?? r.actor.kind}{r.reason ? ` · ${r.reason}` : ""}</li>)}
      </ul>
    </details>
  );
}

/**
 * Everything the team may see of the audit ledger (A9): recruiter access, team changes, rule and company changes,
 * candidate views, outcomes, exports; in plain words, newest first, and as a spreadsheet. Hidden for roles without
 * events.read (the API answers 403).
 */
function AuditHistory() {
  const [everyPage, setEveryPage] = useState(false);
  const path = `/api/v1/companies/current/audit?limit=50${everyPage ? "" : "&exclude=staff.tenant_accessed"}`;
  const q = useQuery({ queryKey: ["audit-history", everyPage], queryFn: () => api.get<AuditRow[]>(path), retry: false });
  const s = useTableSort<"when" | "who">({ key: "when", dir: "descending" });
  if (q.error) return null;
  return (
    <Card title="Audit history" aside={<a className="btn secondary sm" href="/api/v1/companies/current/audit.csv">Download as a spreadsheet</a>}>
      <p className="small muted">Who did what in your workspace, newest first.</p>
      <details className="more" style={{ marginTop: 6 }}>
        <summary>How this works</summary>
        <p className="small muted" style={{ margin: 0 }}>It lists recruiter access, team changes, rule changes, company changes, candidate records opened, outcomes and downloads. The last 50 are shown; the spreadsheet has everything, and downloading it is recorded too.</p>
      </details>
      <label className="small" style={{ display: "block", margin: "8px 0" }}><input type="checkbox" checked={everyPage} onChange={(e) => setEveryPage(e.target.checked)} /> Include every page an ITS recruiter opened</label>
      {!q.isLoading && !q.data?.length ? <p className="small muted">Nothing recorded yet.</p> : (
        <Table head={[s.col("when", "When", "date"), "What happened", s.col("who", "Who", "text")]} label="Audit history" scroll loading={q.isLoading ? 5 : undefined} announce={s.announce}>
          {s.apply(q.data ?? [], { when: (r) => Date.parse(r.at), who: (r) => r.actor.name ?? r.actor.kind }).map((r) => <tr key={r.id}><td className="small nowrap">{new Date(r.at).toLocaleString()}</td><td>{r.description}</td><td className="small">{r.actor.name ?? r.actor.kind}</td></tr>)}
        </Table>
      )}
    </Card>
  );
}

type SessionRow = { id: string; createdAt: string; lastSeenAt: string | null; expiresAt: string; addressHash: string | null; userAgent: string | null; provider: string; current: boolean };

/** Where the person is signed in (A11): every open session, the current one marked, with "Sign out everywhere else". */
function YourSessions() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["sessions"], queryFn: () => api.get<SessionRow[]>("/api/v1/auth/sessions") });
  const refresh = () => qc.invalidateQueries({ queryKey: ["sessions"] });
  const revokeOthers = useMutation({ mutationFn: () => api.post<{ sessionsEnded: number }>("/api/v1/auth/sessions/revoke-all"), onSuccess: (r) => { toast(r.sessionsEnded === 0 ? "No other sessions were open." : `Signed out ${r.sessionsEnded === 1 ? "one other session" : `${r.sessionsEnded} other sessions`}.`); refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not sign out.") });
  const revokeOne = useMutation({ mutationFn: (id: string) => api.post(`/api/v1/auth/sessions/${id}/revoke`), onSuccess: () => { toast("Signed out."); refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not sign out.") });
  const rows = q.data ?? [];
  const browser = (ua: string | null) => (!ua ? "unknown device" : /iphone|ipad/i.test(ua) ? "iPhone or iPad" : /android/i.test(ua) ? "Android" : /macintosh/i.test(ua) ? "Mac" : /windows/i.test(ua) ? "Windows" : /node|vitest/i.test(ua) ? "a test client" : "a browser");
  const PROVIDER: Record<string, string> = { google: "Google", azure: "Microsoft", magic_link: "email link", email: "email link" };
  return (
    <Card title="Your sessions" aside={rows.length > 1 ? <Button size="sm" variant="secondary" loading={revokeOthers.isPending} onClick={() => revokeOthers.mutate()}>Sign out everywhere else</Button> : null}>
      <p className="small muted">Every place you are signed in. Sign out any you do not recognise.</p>
      <details className="more" style={{ marginTop: 6 }}>
        <summary>How this works</summary>
        <p className="small muted" style={{ margin: 0 }}>Each place's internet address is shown only as a short code, never in full.</p>
      </details>
      {q.isLoading ? <Skeleton lines={2} /> : q.error ? <p className="small muted">Could not load your sessions.</p> : (
        <div className="stack" style={{ gap: 6, marginTop: 8 }}>
          {rows.map((s) => (
            <div key={s.id} className="row" style={{ justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <span className="small">{s.current ? <Pill size="sm" tone="good">this one</Pill> : null} {browser(s.userAgent)} · signed in with {PROVIDER[s.provider] ?? s.provider} · {s.lastSeenAt ? `last seen ${new Date(s.lastSeenAt).toLocaleString()}` : `opened ${new Date(s.createdAt).toLocaleString()}`}{s.addressHash ? ` · address ${s.addressHash.slice(0, 6)}` : ""}</span>
              {s.current ? null : <Button size="sm" variant="quiet" loading={revokeOne.isPending} onClick={() => revokeOne.mutate(s.id)}>Sign out</Button>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/**
 * Sends the person through their sign-in provider again; they come straight back to the same tab (`returnTo`, e.g.
 * "/setup?tab=rules") with the confirmation recorded.
 */
function ReauthPrompt({ returnTo }: { returnTo: string }) {
  const start = useMutation({
    mutationFn: () => api.post<{ url: string }>("/api/v1/auth/reauth/start", { returnTo }),
    onSuccess: (r) => { window.location.assign(r.url); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not start the confirmation."),
  });
  return (
    <Alert tone="caution">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span><strong>Confirm it's you.</strong> Rules, candidate notices and new admins or owners need a fresh sign-in. You come straight back here.</span>
        <Button size="sm" variant="primary" loading={start.isPending} onClick={() => start.mutate()}>Confirm with my sign-in</Button>
      </div>
    </Alert>
  );
}

type NoticeView = { key: string; version: string; text: string; overridden: boolean; defaultText: string; defaultVersion: string };
const NOTICE_LABEL: Record<string, string> = { ai_use: "How we use AI (shown on the job page and the apply form)", privacy: "How we handle information (shown on the apply form and the privacy page)", pay_transparency: "Pay range notice (states that require it)", adverse_decision_explanation: "Decision review notice (states that require it)" };
/** The same notices named briefly, for the read view's one-line summary. */
const NOTICE_SHORT: Record<string, string> = { ai_use: "AI notice", privacy: "privacy notice", pay_transparency: "pay range notice", adverse_decision_explanation: "decision review notice" };
const SIZE_BANDS = ["1-19", "20-49", "50-99", "100-199", "200-499", "500+"];
/** The plan's allowances in the company card's words (recruiter_asks counts the team's own requests, founder decision Q33). */
const USAGE_LABEL: Record<string, string> = { active_roles: "active jobs", text_screens: "screening chats this month", screen_person_requests: "requests for a person instead of the screening chat", voice_minutes: "voice minutes", sourcing_contacts: "sourcing contacts", recruiter_asks: "recruiter requests", seats: "people (invitations not yet answered count too)" };
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * When the monthly allowances start again from zero (GET /companies/current `usage[key].resetsAt`; roles never reset):
 * "Monthly allowances reset on October 30.", or null when no limited allowance has a reset date.
 */
export function usageResets(usage: Record<string, { limit: number | null; resetsAt?: string | null }> | null | undefined): string | null {
  const dates = Object.values(usage ?? {}).filter((v) => v.limit !== null && v.resetsAt).map((v) => Date.parse(v.resetsAt!)).filter(Number.isFinite);
  if (!dates.length) return null;
  return `Monthly allowances reset on ${new Date(Math.min(...dates)).toLocaleDateString("en-US", { month: "long", day: "numeric" })}.`;
}

/**
 * What the company card sends: only what the person may change; the plan, pilot and allowances are never in it. The
 * logo and the "about" text have a card of their own (CompanyProfileCard): an uploaded picture, and words a person approved.
 */
type CompanyForm = { name: string; website: string; timezone: string; sizeBand: string; locations: string; intro: string; benefits: string; hoursOn: boolean; days: number[]; start: string; end: string; notices: Record<string, string> };

function formOf(c: Company, notices: NoticeView[]): CompanyForm {
  return {
    name: c.name, website: c.settings.website ?? "", timezone: c.timezone, sizeBand: c.sizeBand,
    locations: c.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).join("\n"),
    intro: c.settings.careersPage?.intro ?? "", benefits: c.settings.benefitsSummary ?? "",
    hoursOn: !!c.settings.businessHours, days: c.settings.businessHours?.days ?? [1, 2, 3, 4, 5], start: c.settings.businessHours?.start ?? "09:00", end: c.settings.businessHours?.end ?? "17:00",
    notices: Object.fromEntries(notices.map((n) => [n.key, n.overridden ? n.text : ""])),
  };
}

function parseLocations(text: string): Array<{ city: string; region: string; country: string }> {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => { const [city, region] = line.split(",").map((p) => p.trim()); return { city: city ?? "", region: (region ?? "").toUpperCase().slice(0, 2), country: "US" }; }).filter((l) => l.city);
}

/**
 * The company's own details (A8, J16): name, website, logo, time zone, size, locations, careers-page intro, benefits,
 * contact hours and the wording of the candidate notices. Owners and admins edit; everyone else reads. A reworded
 * notice gets a new version (the date) and needs a fresh sign-in.
 */
function CompanyCard({ company: c, canEdit, onReauthRequired }: { company: Company; canEdit: boolean; onReauthRequired: () => void }) {
  const qc = useQueryClient();
  const notices = useQuery({ queryKey: ["company", "notices"], queryFn: () => api.get<NoticeView[]>("/api/v1/companies/current/notices") });
  const [form, setForm] = useState<CompanyForm | null>(null);
  const [editing, setEditing] = useState(false);
  const shownNotices = (notices.data ?? []).filter((n) => NOTICE_LABEL[n.key]);
  const save = useMutation({
    mutationFn: (f: CompanyForm) => {
      const changedNotices: Record<string, { text: string } | null> = {};
      for (const n of shownNotices) {
        const typed = (f.notices[n.key] ?? "").trim();
        if (n.overridden && !typed) changedNotices[n.key] = null;
        else if (typed && typed !== (n.overridden ? n.text : "")) changedNotices[n.key] = { text: typed };
      }
      return api.patch<Company & { changed: string[] }>("/api/v1/companies/current", {
        name: f.name.trim(), timezone: f.timezone, sizeBand: f.sizeBand, locations: parseLocations(f.locations),
        settings: { website: f.website.trim(), benefitsSummary: f.benefits.trim(), careersPage: { intro: f.intro.trim() }, businessHours: f.hoursOn ? { days: f.days, start: f.start, end: f.end } : null, ...(Object.keys(changedNotices).length ? { notices: changedNotices } : {}) },
      });
    },
    onSuccess: async (r) => {
      toast(r.changed.length ? `Saved: ${r.changed.map(fieldLabel).join(", ")}.` : "Nothing changed.");
      setEditing(false); setForm(null);
      await qc.invalidateQueries({ queryKey: ["company"] }); await qc.invalidateQueries({ queryKey: ["audit-history"] });
    },
    onError: (e) => { if (e instanceof ApiError && e.code === "reauth_required") { onReauthRequired(); toast("Confirm it's you first, then save again."); } else toast(e instanceof ApiError ? e.message : "Could not save."); },
  });
  const f = form ?? (notices.data ? formOf(c, notices.data) : null);
  const set = (patch: Partial<CompanyForm>) => setForm({ ...(f ?? formOf(c, notices.data ?? [])), ...patch });
  const hours = c.settings.businessHours;
  // The Trial plan's last 7 days, or its end (founder decision L-02 B), for those who can talk to ITS about the plan.
  const trial = canEdit ? trialRow(c.trial, c.timezone) : null;
  const trialLine = trialPlanLine(c.trial, c.timezone);
  return (
    <Card title="Company" aside={canEdit && !editing ? <Button size="sm" variant="secondary" onClick={() => { setForm(formOf(c, notices.data ?? [])); setEditing(true); }}>Edit</Button> : null}>
      {!editing || !f ? (
        <>
          {trial ? <div style={{ marginBottom: 10 }}><Alert tone="caution">{trial.level === "ended" ? trial.body : `${trial.title}. ${trial.body}`}</Alert></div> : null}
          <dl className="kv">
            <dt>Name</dt><dd>{c.name}</dd>
            <dt>ITS check</dt><dd>{companyCheckOf(c) === "waiting" ? <Chip tone="caution">ITS is confirming your company</Chip> : <Chip tone="good">Confirmed</Chip>}</dd>
            <dt>Careers page</dt><dd><a href={`/careers/${c.slug}`} target="_blank" rel="noreferrer">/careers/{c.slug}</a>{companyCheckOf(c) === "waiting" ? <span className="small muted"> · {CAREERS_PAGE_WAITS}</span> : null}</dd>
            <dt>Website</dt><dd>{c.settings.website || <span className="muted">not set</span>}</dd>
            <dt>Locations</dt><dd>{c.locations.map((l) => [l.city, l.region].filter(Boolean).join(", ")).join("; ")}</dd>
            <dt>Plan</dt><dd><Chip tone="accent">{c.plan?.name ?? c.planKey}</Chip>{trialLine ? <span className="small muted"> · {trialLine}</span> : null}{c.settings.pilot ? <span className="small muted"> · pilot until {new Date(c.settings.pilot.extendedUntil ?? c.settings.pilot.endsAt).toLocaleDateString()}; jobs in progress are never cut off</span> : null}</dd>
            {c.usage ? <><dt>Usage</dt><dd className="small">{Object.entries(c.usage).map(([k, v]) => `${USAGE_LABEL[k] ?? k.replace(/_/g, " ")}: ${v.used}${v.limit === null ? "" : ` of ${v.limit}`}`).join(" · ")}{usageResets(c.usage) ? <span> {usageResets(c.usage)}</span> : null}{c.usage.recruiter_asks ?<span className="muted"> Recruiter requests count only what your team asks for. Going over never holds a request up; ITS will talk with you about the extra.</span> : null}</dd></> : null}
          </dl>
          {/* The rest of the company's details, one click away. The plan and its usage stay on view: "See usage" links land here. */}
          <details className="more" style={{ marginTop: 10 }}>
            <summary>Type, size, hours and notices</summary>
            <dl className="kv">
              <dt>Business type</dt><dd>{VERTICALS.find(([v]) => v === c.vertical)?.[1] ?? c.vertical.replace(/_/g, " ")}</dd>
              <dt>Size</dt><dd>{c.sizeBand} employees</dd>
              <dt>Time zone</dt><dd>{c.timezone}</dd>
              <dt>Contact hours</dt><dd>{hours ? `${hours.days.map((d) => DAY_SHORT[d]).join(", ")} ${hours.start} to ${hours.end}` : "Any day, 8:00 to 21:00 local time (the legal default for texts)"}</dd>
              <dt>Notices</dt><dd className="small">{shownNotices.some((n) => n.overridden) ? shownNotices.filter((n) => n.overridden).map((n) => `${NOTICE_SHORT[n.key] ?? n.key} reworded (version ${n.version})`).join("; ") : "Standard wording"}</dd>
            </dl>
          </details>
        </>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          <Field label="Company name" htmlFor="co-name"><input id="co-name" className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <div className="grid-2">
            <Field label="Website" htmlFor="co-web" hint="Shown to candidates and search engines"><input id="co-web" className="input" placeholder="acme.com" value={f.website} onChange={(e) => set({ website: e.target.value })} /></Field>
            <Field label="Time zone" htmlFor="co-tz" hint="Closing dates end at midnight here"><select id="co-tz" className="select" value={f.timezone} onChange={(e) => set({ timezone: e.target.value })}>{[...new Set([f.timezone, ...ZONES])].map((z) => <option key={z} value={z}>{z}</option>)}</select></Field>
            <Field label="Size" htmlFor="co-size"><select id="co-size" className="select" value={f.sizeBand} onChange={(e) => set({ sizeBand: e.target.value })}>{SIZE_BANDS.map((s) => <option key={s} value={s}>{s} employees</option>)}</select></Field>
          </div>
          <Field label="Locations (one per line, as City, ST)" htmlFor="co-loc"><textarea id="co-loc" className="input" rows={2} value={f.locations} onChange={(e) => set({ locations: e.target.value })} /></Field>
          <Field label="Careers page introduction" htmlFor="co-intro" hint="The first line candidates read on your careers page"><textarea id="co-intro" className="input" rows={2} maxLength={1000} value={f.intro} onChange={(e) => set({ intro: e.target.value })} /></Field>
          <Field label="Benefits summary" htmlFor="co-ben" hint="Shown on job pages where a job describes none of its own; some states ask for it on every job ad"><textarea id="co-ben" className="input" rows={2} maxLength={2000} value={f.benefits} onChange={(e) => set({ benefits: e.target.value })} /></Field>
          {/* Rarely changed, so folded: the hours candidates may be texted, and the legal wording of the notices. */}
          <details className="more">
            <summary>Contact hours for texts</summary>
            <p className="small muted">When candidates may be texted. The law already keeps texts between 8:00 and 21:00 local time; your hours can only narrow that.</p>
            <label className="small" style={{ display: "block", margin: "6px 0" }}><input type="checkbox" checked={f.hoursOn} onChange={(e) => set({ hoursOn: e.target.checked })} /> Set our own contact hours</label>
            {f.hoursOn ? (
              <div className="row small" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {[1, 2, 3, 4, 5, 6, 0].map((d) => <label key={d}><input type="checkbox" checked={f.days.includes(d)} onChange={(e) => set({ days: e.target.checked ? [...f.days, d].sort() : f.days.filter((x) => x !== d) })} /> {DAY_SHORT[d]}</label>)}
                <input aria-label="Contact hours start" className="input" type="time" style={{ width: 130 }} value={f.start} onChange={(e) => set({ start: e.target.value })} />
                <span>to</span>
                <input aria-label="Contact hours end" className="input" type="time" style={{ width: 130 }} value={f.end} onChange={(e) => set({ end: e.target.value })} />
              </div>
            ) : null}
          </details>
          <details className="more">
            <summary>Candidate notices (legal wording)</summary>
            <p className="small muted">Leave a box empty to use the standard wording. A reworded notice gets a new version (today's date), which is recorded with every application from then on. Changing a notice needs a fresh sign-in.</p>
            {shownNotices.map((n) => (
              <Field key={n.key} label={NOTICE_LABEL[n.key]} htmlFor={`co-n-${n.key}`} hint={n.overridden ? `Reworded (version ${n.version}). Clear the box to go back to the standard text.` : `Standard text (version ${n.defaultVersion}): ${n.defaultText}`}>
                <textarea id={`co-n-${n.key}`} className="input" rows={3} maxLength={4000} placeholder={n.defaultText} value={f.notices[n.key] ?? ""} onChange={(e) => set({ notices: { ...f.notices, [n.key]: e.target.value } })} />
              </Field>
            ))}
          </details>
          <p className="small muted">The plan, the pilot term and the allowances are set by Identified Talent Solutions; ask them to change those.</p>
          <div className="row"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(f)}>Save changes</Button><Button variant="quiet" onClick={() => { setEditing(false); setForm(null); }}>Cancel</Button></div>
        </div>
      )}
    </Card>
  );
}

function fieldLabel(f: string): string {
  return ({ name: "name", website: "website", timezone: "time zone", sizeBand: "size", locations: "locations", logoUrl: "logo", benefitsSummary: "benefits summary", careersPage: "careers page intro", businessHours: "contact hours", notices: "candidate notices", boardPosting: "who posts on job boards", zipRecruiterPlan: "ZipRecruiter plan", about: "about the company", newTimesAfterCancel: "automatic new times after a cancellation" } as Record<string, string>)[f] ?? f;
}

/*
 * How candidates see the company (founder decision Q13, plan D10): the logo and a short "about the company" text, both
 * shown on the careers page and every job page. The server owns these routes (apps/api routes/company-settings.ts):
 *   POST /companies/current/about/draft   the assistant drafts the text from what the company told us; nothing is saved
 *   POST /companies/current/about         { text } approves it as it stands (who and when are recorded); { text: null } takes it off
 *   POST /companies/current/logo          the picture itself (multipart, field "file"), stored and served by us
 * The text the assistant writes while drafting a role (its "company blurb") is never shown: only words a person approved.
 */
const ABOUT_DRAFT_PATH = "/api/v1/companies/current/about/draft";
const ABOUT_PATH = "/api/v1/companies/current/about";
const LOGO_PATH = "/api/v1/companies/current/logo";
/* GET: what candidates see (`contactShown`: the company's own contact or the ITS inbox). PUT { email | null, name? }. */
const PUBLIC_PROFILE_PATH = "/api/v1/companies/current/public-profile";
const HIRING_CONTACT_PATH = "/api/v1/companies/current/hiring-contact";
type PublicProfile = { hiringContact: { email: string; name: string | null } | null; contactShown: { email: string; name: string | null; kind: "company" | "its" } };

function CompanyProfileCard({ company: c, canEdit }: { company: Company; canEdit: boolean }) {
  return (
    <Card title="How candidates see you">
      <p className="small muted" style={{ marginBottom: 10 }}>What candidates see on your careers page and every job page.</p>
      <div className="stack" style={{ gap: 18 }}>
        <LogoPicker company={c} canEdit={canEdit} />
        <AboutText company={c} canEdit={canEdit} />
        <HiringContactField canEdit={canEdit} />
      </div>
    </Card>
  );
}

/**
 * Who candidates can write to before they apply (plan D10): for help, or a change to how they apply because of a
 * disability. The company's own address once it sets one; until then, the ITS inbox that answers for the company. The
 * line shows on the careers page, every job page and the apply form.
 */
function HiringContactField({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["public-profile"], queryFn: () => api.get<PublicProfile>(PUBLIC_PROFILE_PATH) });
  const [form, setForm] = useState<{ email: string; name: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: { email: string | null; name?: string | null }) => api.put<PublicProfile>(HIRING_CONTACT_PATH, body),
    onSuccess: async (_r, body) => {
      toast(body.email ? "Contact saved." : "Back to the ITS inbox.", body.email ? "Candidates see it on your careers page, job pages and the apply form." : "Candidates write to the ITS inbox that answers for you.");
      setForm(null);
      setProblem(null);
      await qc.invalidateQueries({ queryKey: ["public-profile"] });
      await qc.invalidateQueries({ queryKey: ["audit-history"] });
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : "Could not save the contact."),
  });
  const shown = q.data?.contactShown ?? null;
  const own = q.data?.hiringContact ?? null;
  const submit = () => {
    const email = form?.email.trim() ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setProblem("Use an email address like jobs@yourcompany.com."); return; }
    save.mutate({ email, name: form?.name.trim() || null });
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <h3 style={{ fontSize: 14 }}>Who candidates can write to before they apply</h3>
      {q.isLoading ? <Skeleton lines={1} /> : shown ? (
        <p className="small" style={{ color: "var(--ink-2)", margin: 0 }}>
          Candidates see: {shown.name ? `${shown.name}, ` : ""}{shown.email}. {shown.kind === "its" ? "This is the ITS inbox that answers for your company; set your own address to have them write to you." : "Your own address, set here."}
        </p>
      ) : null}
      {canEdit ? (form ? (
        <>
          <Field label="Email address" htmlFor="co-contact-email" hint="For help with applying, or a change to how someone applies because of a disability.">
            <input id="co-contact-email" className="input" type="email" autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="e.g. jobs@yourcompany.com" />
          </Field>
          <Field label="Name to show (optional)" htmlFor="co-contact-name">
            <input id="co-contact-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Dana at the front desk" />
          </Field>
          <div className="row">
            <Button variant="primary" size="sm" loading={save.isPending} onClick={submit}>Save the contact</Button>
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => { setForm(null); setProblem(null); }}>Cancel</Button>
          </div>
        </>
      ) : (
        <div className="row">
          <Button size="sm" onClick={() => setForm({ email: own?.email ?? "", name: own?.name ?? "" })}>{own ? "Change the contact" : "Set your own contact"}</Button>
          {own ? <Button size="sm" variant="ghost" loading={save.isPending} onClick={() => save.mutate({ email: null })}>Use the ITS inbox</Button> : null}
        </div>
      )) : <p className="small muted" style={{ margin: 0 }}>An owner or an admin sets it.</p>}
      {problem ? <Alert tone="caution">{problem}</Alert> : null}
    </div>
  );
}

/** The logo: a picture uploaded here, previewed before it is used, stored and served by us (never a link to another site). */
function LogoPicker({ company: c, canEdit }: { company: Company; canEdit: boolean }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The chosen picture is shown from the browser's own copy until it is uploaded; that copy is let go when replaced.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const choose = (f: File | null) => {
    setProblem(null);
    if (!f) { setFile(null); setPreview(null); return; }
    const p = logoProblem(f);
    if (p) { setProblem(p); setFile(null); setPreview(null); return; }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };
  const done = async () => { setFile(null); setPreview(null); await qc.invalidateQueries({ queryKey: ["company"] }); await qc.invalidateQueries({ queryKey: ["audit-history"] }); };
  const upload = useMutation({
    mutationFn: (f: File) => { const form = new FormData(); form.append("file", f); return api.post<unknown>(LOGO_PATH, form); },
    onSuccess: async (r) => { toast("Logo saved.", logoUrlOf(r) ? "It shows on your careers page and job pages." : undefined); await done(); },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : "Could not upload the logo. Try again."),
  });
  const remove = useMutation({
    mutationFn: () => api.patch("/api/v1/companies/current", { settings: { logoUrl: "" } }),
    onSuccess: async () => { toast("Logo taken off.", "Job pages show your company's name instead."); await done(); },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : "Could not take the logo off."),
  });
  const shown = preview ?? c.settings.logoUrl ?? null;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <h3 style={{ fontSize: 14 }}>Logo</h3>
      <div className="row" style={{ alignItems: "center", gap: 14 }}>
        <span className="logo-preview">{shown ? <img src={shown} alt={preview ? "The logo you chose, not saved yet" : `${c.name} logo`} /> : <Avatar name={c.name} tone="ink" shape="square" size="xl" letters={1} />}</span>
        <span className="small muted" style={{ flex: "1 1 200px" }}>{preview ? "This is how it will look. Save it to use it." : shown ? "Shown at the top of your careers page and job pages." : "No logo yet: job pages show your company's name."}</span>
      </div>
      {canEdit ? (
        <>
          <Field label={shown && !preview ? "Choose a different picture" : "Choose a picture"} htmlFor="co-logo-file" hint="PNG, JPG or WebP, up to 2 MB. A wide logo on a plain background looks best.">
            <input id="co-logo-file" className="input" type="file" accept={LOGO_TYPES.join(",")} onChange={(e) => choose(e.target.files?.[0] ?? null)} />
          </Field>
          <div className="row">
            {file ? <Button variant="primary" size="sm" icon="upload" loading={upload.isPending} onClick={() => upload.mutate(file)}>Use this logo</Button> : null}
            {file ? <Button size="sm" variant="ghost" disabled={upload.isPending} onClick={() => choose(null)}>Cancel</Button> : null}
            {!file && c.settings.logoUrl ? <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>Take the logo off</Button> : null}
          </div>
        </>
      ) : null}
      {problem ? <Alert tone="caution">{problem}</Alert> : null}
    </div>
  );
}

/**
 * "About the company": the assistant drafts a short text, a person edits it and approves it once; only then does it
 * appear. A change is approved again. The draft is marked as written by the assistant until a person approves it.
 */
function AboutText({ company: c, canEdit }: { company: Company; canEdit: boolean }) {
  const qc = useQueryClient();
  const approved = c.settings.about ?? null;
  const [editing, setEditing] = useState<{ text: string; drafted: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A phrase in the assistant's draft that can stand in for a protected trait, with a fairer way to say it.
  const [wording, setWording] = useState<ReturnType<typeof aboutCheckOf>>(null);
  const draft = useMutation({
    mutationFn: () => api.post<unknown>(ABOUT_DRAFT_PATH, {}),
    onSuccess: (r) => {
      const text = aboutDraftOf(r);
      setProblem(text ? null : "The assistant did not write anything. Write it yourself, or try again.");
      setWording(aboutCheckOf(r));
      setEditing({ text, drafted: !!text });
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : "The assistant could not write a draft. Write it yourself, or try again."),
  });
  const save = useMutation({
    mutationFn: (text: string | null) => api.post(ABOUT_PATH, { text }),
    onSuccess: async (_r, text) => {
      toast(text ? "Approved." : "Taken off.", text ? "It shows on your careers page and job pages, as you approved it." : "Job pages no longer show an \"about\" text.");
      setEditing(null);
      setProblem(null);
      setWording(null);
      await qc.invalidateQueries({ queryKey: ["company"] });
      await qc.invalidateQueries({ queryKey: ["audit-history"] });
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : "Could not save it."),
  });
  const approve = () => {
    const p = aboutProblem(editing?.text ?? "");
    setProblem(p);
    if (!p && editing) save.mutate(editing.text.trim());
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <h3 style={{ fontSize: 14 }}>About the company</h3>
      {editing ? (
        <>
          {editing.drafted ? <Alert tone="info">Drafted by the assistant (AI) from what you told us about the company. Read every word and change anything that is not right: nothing shows on job pages until you approve it.</Alert> : null}
          {wording && editing.text.includes(wording.text) ? <Alert tone="caution">Check this wording: "{wording.text}". {wording.reason} {wording.alternative}</Alert> : null}
          <Field label="What candidates read about the company" htmlFor="co-about" hint={`A few sentences: what you do, who you serve, what it is like to work there. Up to ${ABOUT_MAX} characters.`}>
            <textarea id="co-about" className="textarea" rows={6} maxLength={ABOUT_MAX + 200} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
          </Field>
          <div className="row">
            <Button variant="primary" size="sm" loading={save.isPending} onClick={approve}>Approve and show it</Button>
            <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => { setEditing(null); setProblem(null); }}>Cancel</Button>
          </div>
        </>
      ) : approved ? (
        <>
          <p style={{ whiteSpace: "pre-wrap", color: "var(--ink-2)", margin: 0 }}>{approved.text}</p>
          <p className="small muted" style={{ margin: 0 }}>Approved{approved.approvedBy?.name ? ` by ${approved.approvedBy.name}` : ""} on {new Date(approved.approvedAt).toLocaleDateString()}. Shown on your careers page and every job page.</p>
          {canEdit ? (
            <div className="row">
              <Button size="sm" onClick={() => setEditing({ text: approved.text, drafted: false })}>Change it</Button>
              <Button size="sm" variant="ghost" loading={save.isPending} onClick={() => save.mutate(null)}>Take it off job pages</Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className="small muted" style={{ margin: 0 }}>Nothing yet. Job pages show the job without an "about the company" part until someone approves one.</p>
          {canEdit ? (
            <div className="row">
              <Button size="sm" variant="primary" icon="sparkle" loading={draft.isPending} onClick={() => draft.mutate()}>Draft it with the assistant</Button>
              <Button size="sm" disabled={draft.isPending} onClick={() => setEditing({ text: "", drafted: false })}>Write it yourself</Button>
            </div>
          ) : <p className="small muted" style={{ margin: 0 }}>An owner or an admin writes and approves it.</p>}
        </>
      )}
      {problem ? <Alert tone="caution">{problem}</Alert> : null}
    </div>
  );
}

/**
 * Job boards (plan D3, founder decision Q11): who posts the company's jobs on LinkedIn, Indeed and ZipRecruiter (ITS by
 * default, from the company's own accounts, or the team itself), and whether the company has its own paid ZipRecruiter
 * plan, the only way ZipRecruiter is offered. Each role's boards are ticked on the role itself.
 */
function JobBoardsCard({ company: c, canEdit }: { company: Company; canEdit: boolean }) {
  const qc = useQueryClient();
  const whoPosts = c.settings.boardPosting === "self" ? "self" : "its";
  const save = useMutation({
    mutationFn: (settings: { boardPosting?: "its" | "self"; zipRecruiterPlan?: boolean }) => api.patch<{ changed: string[] }>("/api/v1/companies/current", { settings }),
    onSuccess: async (r) => {
      toast(r.changed?.length ? `Saved: ${r.changed.map(fieldLabel).join(", ")}.` : "Nothing changed.");
      await qc.invalidateQueries({ queryKey: ["company"] });
      await qc.invalidateQueries({ queryKey: ["audit-history"] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save."),
  });
  return (
    <Card title="Job boards">
      <p className="small muted" style={{ marginBottom: 10 }}>Every job goes on your careers page and Google.</p>
      <div className="stack" style={{ gap: 12 }}>
        <Field label="Who posts your jobs on the boards">
          {canEdit ? (
            <Segmented value={whoPosts} onChange={(v) => save.mutate({ boardPosting: v })} ariaLabel="Who posts your jobs on the boards" options={[{ value: "its", label: "ITS posts them for us" }, { value: "self", label: "Our team posts them" }]} />
          ) : <Chip>{whoPosts === "its" ? "ITS posts them for you" : "Your team posts them"}</Chip>}
        </Field>
        <label className="row small" style={{ gap: 8 }}>
          <input type="checkbox" checked={!!c.settings.zipRecruiterPlan} disabled={!canEdit || save.isPending} onChange={(e) => save.mutate({ zipRecruiterPlan: e.target.checked })} />
          We have our own paid ZipRecruiter plan
        </label>
        {!canEdit ? <p className="small muted" style={{ margin: 0 }}>Only owners and admins change these.</p> : null}
        <details className="more">
          <summary>How this works</summary>
          <div className="stack small muted" style={{ gap: 6 }}>
            <p style={{ margin: 0 }}>LinkedIn, Indeed and ZipRecruiter are ticked on each job, and nothing is called up on a board until its address has been checked.</p>
            <p style={{ margin: 0 }}>{whoPosts === "its" ? "An ITS recruiter posts each job from your company's own board accounts and takes it down when the job closes. You see who has it on the job's Share tab." : "Each job's Share tab has the words to paste, the board's own apply link and the steps. You record the listing's address there once it is up."}</p>
            <p style={{ margin: 0 }}>Posting on ZipRecruiter needs a paid plan of your own, so it is offered on a job only once you say you have one.</p>
          </div>
        </details>
      </div>
    </Card>
  );
}

/* GET: the setting, how many people were already told a day for their new times, and whether ITS confirmed the company. */
const NEW_TIMES_PATH = "/api/v1/companies/current/new-times";

/**
 * When a candidate cancels (founder decisions 1A to 4A; 3A): whether people who cancel and ask for new times get one set
 * by email automatically, and after how many working days (1 to 10). The box saves at once; the number has its own
 * Save. Switching it off while some people were already told a day asks what happens to them first: their day kept, or
 * their times stopped too; nothing is chosen for the owner, and the API refuses to choose (409 `pending_choice_needed`)
 * if this page was out of date. Like a rule change, it needs a recent sign-in.
 */
function NewTimesCard({ company: c, canEdit, onReauthRequired }: { company: Company; canEdit: boolean; onReauthRequired: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["new-times-setting"], queryFn: () => api.get<NewTimesSettingView>(NEW_TIMES_PATH), retry: false });
  // Until that answer is in (or if it fails), the company's own settings say what is set.
  const saved = q.data ? { auto: q.data.auto, workingDays: q.data.workingDays } : newTimesSettingFrom(c.settings);
  const confirmed = q.data ? q.data.companyConfirmed : companyCheckOf(c) !== "waiting";
  const [days, setDays] = useState<string | null>(null);
  const typed = days ?? String(saved.workingDays);
  const n = workingDaysFrom(typed);
  // Switching off with people already told a day: the question, with nothing chosen yet.
  const [asking, setAsking] = useState<{ pending: number; choice: "keep" | "stop" | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (input: { auto: boolean; workingDays: number; pending?: "keep" | "stop"; asked?: number }) =>
      api.patch<{ changed?: string[]; pendingNewTimes?: number }>("/api/v1/companies/current", { settings: { newTimesAfterCancel: { auto: input.auto, workingDays: input.workingDays, ...(input.pending ? { pending: input.pending } : {}) } } }),
    onSuccess: async (r, input) => {
      toast(r.changed?.length ? `Saved: ${r.changed.map(fieldLabel).join(", ")}.` : "Nothing changed.");
      const what: NewTimesSaved = input.pending
        ? { kind: "off", choice: input.pending, count: input.pending === "keep" ? (r.pendingNewTimes ?? input.asked ?? 0) : (input.asked ?? 0) }
        : input.auto === saved.auto && input.workingDays !== saved.workingDays ? { kind: "days", pending: r.pendingNewTimes ?? 0 } : { kind: "other" };
      setNotice(newTimesSavedNotice(what));
      setAsking(null);
      setDays(null);
      await Promise.all([qc.invalidateQueries({ queryKey: ["company"] }), qc.invalidateQueries({ queryKey: ["new-times-setting"] }), qc.invalidateQueries({ queryKey: ["audit-history"] })]);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "pending_choice_needed") {
        // this page did not know someone was already told a day: ask, as it would have
        const pending = Number((e.details as { pending?: unknown } | undefined)?.pending ?? 0);
        setAsking({ pending: pending > 0 ? pending : 1, choice: null });
        qc.invalidateQueries({ queryKey: ["new-times-setting"] });
      } else if (e instanceof ApiError && e.code === "reauth_required") {
        onReauthRequired();
        toast("Confirm it's you first, then save again.");
      } else toast(e instanceof ApiError ? e.message : "Could not save.");
    },
  });
  const toggle = (on: boolean) => {
    setNotice(null);
    const pending = q.data?.pending ?? 0;
    if (!on && saved.auto && pending > 0) setAsking({ pending, choice: null });
    else save.mutate({ auto: on, workingDays: saved.workingDays });
  };
  // The card's explanation and, when it is on, what the setting does: the first sentence of each on view, the rest under
  // "How this works". When it is off the setting says it in two short sentences, both on view.
  const intro = leadAndRest(NEW_TIMES_SETUP.intro);
  const setting = saved.auto ? leadAndRest(newTimesSettingText(saved)) : { lead: newTimesSettingText(saved), rest: "" };
  const howItWorks = (
    <details className="more" style={{ marginTop: 10 }}>
      <summary>How this works</summary>
      <div className="stack small muted" style={{ gap: 6 }}>
        {intro.rest ? <p style={{ margin: 0 }}>{intro.rest}</p> : null}
        {setting.rest ? <p style={{ margin: 0 }}>{setting.rest}</p> : null}
      </div>
    </details>
  );
  return (
    <Card title={NEW_TIMES_SETUP.title}>
      <p className="small muted" style={{ marginBottom: 10 }}>{intro.lead}</p>
      {canEdit ? (
        <div className="stack" style={{ gap: 12 }}>
          <div className="stack" style={{ gap: 4 }}>
            <label className="row small" style={{ gap: 8 }}>
              <input type="checkbox" checked={asking ? false : saved.auto} disabled={save.isPending} onChange={(e) => toggle(e.target.checked)} />
              {NEW_TIMES_SETUP.checkbox}
            </label>
            {/* before the ITS check every email to candidates waits, so nothing automatic is promised (founder decision B7) */}
            {!confirmed ? <p className="small muted" style={{ margin: 0 }}>{NEW_TIMES_SETUP.beforeCheck}</p> : null}
          </div>
          {asking ? (
            <Alert tone="caution">
              <div className="stack" style={{ gap: 8 }}>
                <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                  <legend className="small" style={{ marginBottom: 6 }}>{pendingQuestion(asking.pending)}</legend>
                  <label className="row small" style={{ gap: 8 }}><input type="radio" name="new-times-pending" value="keep" checked={asking.choice === "keep"} onChange={() => setAsking({ ...asking, choice: "keep" })} /> {NEW_TIMES_SETUP.keep}</label>
                  <label className="row small" style={{ gap: 8 }}><input type="radio" name="new-times-pending" value="stop" checked={asking.choice === "stop"} onChange={() => setAsking({ ...asking, choice: "stop" })} /> {NEW_TIMES_SETUP.stop}</label>
                </fieldset>
                <div className="row">
                  <Button size="sm" variant="primary" disabled={!asking.choice} loading={save.isPending} onClick={() => { if (asking.choice) save.mutate({ auto: false, workingDays: saved.workingDays, pending: asking.choice, asked: asking.pending }); }}>Save</Button>
                  <Button size="sm" variant="quiet" disabled={save.isPending} onClick={() => setAsking(null)}>Cancel</Button>
                </div>
              </div>
            </Alert>
          ) : null}
          {saved.auto && !asking ? (
            <div className="row" style={{ alignItems: "flex-end", gap: 8 }}>
              <Field label={NEW_TIMES_SETUP.daysLabel} htmlFor="new-times-days" hint={NEW_TIMES_SETUP.daysHint}>
                <input id="new-times-days" className="input" type="number" min={1} max={10} step={1} style={{ width: 100 }} value={typed} aria-invalid={n === null ? true : undefined} onChange={(e) => { setDays(e.target.value); setNotice(null); }} />
              </Field>
              <Button size="sm" variant="primary" disabled={n === null || n === saved.workingDays} loading={save.isPending} onClick={() => { if (n !== null) save.mutate({ auto: true, workingDays: n }); }}>Save</Button>
            </div>
          ) : null}
          <p className="small" style={{ color: "var(--ink-2)", margin: 0 }}>{setting.lead}</p>
          {notice ? <Alert tone="info">{notice}</Alert> : null}
        </div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          <p className="small" style={{ margin: 0 }}>{newTimesReadOnlyText(saved)} {NEW_TIMES_SETUP.readOnly}</p>
          {!confirmed ? <p className="small muted" style={{ margin: 0 }}>{NEW_TIMES_SETUP.beforeCheck}</p> : null}
          <p className="small muted" style={{ margin: 0 }}>{setting.lead}</p>
        </div>
      )}
      {howItWorks}
    </Card>
  );
}
