import { describe, expect, it } from "vitest";
import {
  ACTION_BLOCKED, CANDIDATE_ACTION_LABEL, EARLIER_VERSION_LINE, candidateActions, cvScoreOf, cvScoreSummary, interviewScoreOf, interviewScoreSummary, noCvScore, noInterviewScore,
  type AiInterviewView, type BulkActionResult, type CandidateActionFacts, type CandidateCounts, type CandidateRow, type ScoredRequirement,
} from "../../packages/contracts/src/index";
import {
  SHORTLIST_NOTE, answerWords, bandTone, batches, bulkButtons, bulkLabel, emptyView, findingTone, interviewFacts, listHref, listRefresh, mergeBulk, opensPanelFirst, panelButtons, panelRefresh,
  pickedJob, privateLine, questionRows, refusedLines, requirementRows, resumeView, rowActions, rowView, scoreView, tabFrom, tabItems, ticksOnScreen, toggleAll, toggleTick, undoMillis,
} from "../../apps/web/src/candidates";

/**
 * A job's Candidates list, the bar for several ticked people and the candidate panel: what each lays out from what the
 * API sends. The API decides every tab, label, score, order and allowed action (`candidateActions`, used here to make
 * the actions exactly as it would); the page never works a rule out again.
 */
const now = new Date(2026, 10, 18, 15, 0);
const daysAgo = (n: number) => new Date(2026, 10, 18 - n, 9, 0).toISOString();

const req = (key: string, label: string, mustHave: boolean, finding: ScoredRequirement["finding"], quote: string | null = null): ScoredRequirement => ({ key, label, mustHave, importance: mustHave ? null : "important", finding, quote, source: quote ? "resume" : null });
const strong = cvScoreOf([req("m1", "Active RDA licence", true, "shown", "RDA licence, renewed 2025"), req("m2", "Two years chairside", true, "shown", "three years chairside"), req("s1", "Digital radiography", false, "partly")]);
const missing = cvScoreOf([req("m1", "Active RDA licence", true, "not_met", "my licence lapsed in 2023"), req("m2", "Two years chairside", true, "shown", "three years chairside"), req("s1", "Digital radiography", false, "shown", "digital x-rays daily")]);

const facts = (over: Partial<CandidateActionFacts>): CandidateActionFacts => ({ stage: "triaged", aiInterview: null, toldState: null, decisionEmailWaiting: false, reachable: true, remindedRecently: false, roleStatus: "open", planStop: null, ...over });
const ai = (over: Partial<AiInterviewView> = {}): AiInterviewView => ({ status: "sent", label: "AI interview sent", sentAt: daysAgo(1), linkOpenUntil: new Date(2026, 10, 22, 9, 0).toISOString(), lastEmailAt: daysAgo(1), startedAt: null, completedAt: null, ...over });
const row = (id: string, over: Partial<CandidateRow> = {}): CandidateRow => ({
  id, name: `Person ${id.toUpperCase()}`, appliedAt: daysAgo(2), stage: "triaged", tab: "new", label: "New", cvScore: cvScoreSummary(strong), interviewScore: null, aiInterview: null, flags: [], toldState: null, toldLabel: null,
  actions: candidateActions(facts({})), ...over,
});
const counts = (byTab: Partial<CandidateCounts["byTab"]> = {}, total?: number): CandidateCounts => {
  const tabs = { new: 0, shortlisted: 0, interviewed: 0, hired: 0, not_selected: 0, ...byTab };
  return { total: total ?? Object.values(tabs).reduce((n, x) => n + x, 0), byTab: tabs, locked: 0 };
};

describe("the five tabs and the list's address", () => {
  it("reads the tab from the address, New for anything else", () => {
    expect(tabFrom("interviewed")).toBe("interviewed");
    expect(tabFrom("not_selected")).toBe("not_selected");
    for (const other of [null, undefined, "", "longlist", "offer"]) expect(tabFrom(other)).toBe("new");
  });

  it("names the tabs in the API's words and order, with how many each holds once known", () => {
    expect(tabItems(null).map((t) => t.label)).toEqual(["New", "Shortlisted", "Interviewed", "Hired", "Not selected"]);
    expect(tabItems(null).every((t) => t.count === undefined)).toBe(true);
    expect(tabItems(counts({ new: 4, shortlisted: 2, hired: 1 })).map((t) => t.count)).toEqual([4, 2, 0, 1, 0]);
  });

  it("keeps the addresses the server links to under a job, and names the picked job under Candidates in the rail", () => {
    const job = { kind: "job", roleId: "r1" } as const;
    expect(listHref(job)).toBe("/roles/r1/talent");
    expect(listHref(job, { tab: "new" })).toBe("/roles/r1/talent");
    expect(listHref(job, { tab: "interviewed" })).toBe("/roles/r1/talent?tab=interviewed");
    expect(listHref(job, { tab: "new", open: "a1" })).toBe("/roles/r1/talent?open=a1");
    expect(listHref(job, { tab: "hired", open: "a1" })).toBe("/roles/r1/talent?tab=hired&open=a1");
    const all = { kind: "all", roleId: "r1" } as const;
    expect(listHref(all)).toBe("/talent?job=r1");
    expect(listHref(all, { tab: "shortlisted", open: "a1" })).toBe("/talent?job=r1&tab=shortlisted&open=a1");
  });

  it("opens Candidates in the rail on the job the address names, else the first open job, else the newest", () => {
    const jobs = [{ id: "d", status: "draft" as const }, { id: "p", status: "paused" as const }, { id: "o", status: "open" as const }, { id: "o2", status: "open" as const }];
    expect(pickedJob(jobs, "p")?.id).toBe("p");
    expect(pickedJob(jobs, null)?.id).toBe("o");
    expect(pickedJob(jobs, "gone")?.id).toBe("o");
    expect(pickedJob([jobs[0], jobs[1]], null)?.id).toBe("d");
    expect(pickedJob([], "p")).toBeNull();
  });
});

describe("a score", () => {
  it("is the number with the API's one band word; the colour only follows the band, and is never red", () => {
    expect(scoreView(cvScoreSummary(strong))).toEqual({ score: 90, band: "Very high", tone: "good", none: null });
    expect([bandTone("very_high"), bandTone("high"), bandTone("medium"), bandTone("low"), bandTone(null)]).toEqual(["good", "good", "caution", "neutral", "neutral"]);
    // a missing must-have holds the number at 54: the band says Low, in grey; the red is the missing line's
    expect(scoreView(cvScoreSummary(missing))).toEqual({ score: 54, band: "Low", tone: "neutral", none: null });
  });

  it("says in the API's words why there is no number", () => {
    expect(scoreView(cvScoreSummary(noCvScore("being_read")))).toEqual({ score: null, band: null, tone: "neutral", none: "Reading the resume" });
    expect(scoreView(cvScoreSummary(noCvScore("unreadable"))).none).toBe("Resume could not be read");
    expect(scoreView(interviewScoreSummary(noInterviewScore("being_scored"))).none).toBe("Scoring the AI interview");
    expect(scoreView({ score: null, band: null, bandLabel: null, noScoreLabel: null }).none).toBe("No score yet");
  });

  it("colours a finding's word: green shown, amber partly, red only for one their own words show is not met", () => {
    expect((["shown", "partly", "not_met", "not_shown"] as const).map(findingTone)).toEqual(["good", "caution", "critical", "neutral"]);
  });
});

describe("a row of the list", () => {
  it("shows the name, when they applied, the resume score's lines and any flag, and nothing the tab already says", () => {
    const v = rowView(row("a", { flags: ["Answered No: Can you work Saturdays?"] }), now);
    expect(v).toMatchObject({ id: "a", name: "Person A", facts: ["Applied 2 days ago"], mustHaveLine: "2 of 2 must-haves shown", missingLine: null, earlierVersion: null, interview: null, flags: ["Answered No: Can you work Saturdays?"] });
    expect(v.resume).toEqual({ score: 90, band: "Very high", tone: "good", none: null });
  });

  it("says a missing must-have and an earlier version of the job in the API's lines", () => {
    const v = rowView(row("a", { cvScore: cvScoreSummary(cvScoreOf([req("m1", "Active RDA licence", true, "not_met", "lapsed")], { earlierVersion: true })) }), now);
    expect(v.missingLine).toBe("Missing a must-have: Active RDA licence");
    expect(v.earlierVersion).toBe(EARLIER_VERSION_LINE);
  });

  it("under Shortlisted says where the AI interview stands and until when its link is open", () => {
    const v = rowView(row("a", { stage: "screen_invited", tab: "shortlisted", label: "AI interview sent", aiInterview: ai(), actions: candidateActions(facts({ stage: "screen_invited", aiInterview: "sent" })) }), now);
    expect(v.facts).toEqual(["Applied 2 days ago", "AI interview sent", "Link open until Nov 22"]);
    expect(v.primary?.action).toBe("remind_screen");
    expect(v.more.map((a) => a.action)).toEqual(["cancel_screen", "hire", "reject"]);
  });

  it("under Interviewed carries the interview score beside the resume score, never merged", () => {
    const interview = interviewScoreOf([{ key: "q1", question: "Tell us about a busy day.", finding: "shown", quote: "we saw forty patients", note: null }, { key: "q2", question: "How do you sterilise?", finding: "partly", quote: null, note: null }]);
    const v = rowView(row("a", { stage: "screen_complete", tab: "interviewed", label: "Interviewed", interviewScore: interviewScoreSummary(interview), aiInterview: ai({ status: "done", label: "AI interview done", linkOpenUntil: null, completedAt: daysAgo(0) }) }), now);
    expect(v.interview).toEqual({ score: 75, band: "High", tone: "good", none: null });
    expect(v.resume.score).toBe(90);
    expect(v.facts).toEqual(["Applied 2 days ago"]);
  });

  it("under Not selected says whether they were told, and that someone withdrew", () => {
    const notTold = rowView(row("a", { stage: "rejected", tab: "not_selected", label: "Not selected", toldState: "not_told", toldLabel: "Not told yet", actions: candidateActions(facts({ stage: "rejected", toldState: "not_told" })) }), now);
    expect(notTold.facts).toEqual(["Applied 2 days ago", "Not told yet"]);
    expect(notTold.primary?.action).toBe("send_decision");
    const withdrew = rowView(row("b", { stage: "withdrawn", tab: "not_selected", label: "Withdrew", actions: candidateActions(facts({ stage: "withdrawn" })) }), now);
    expect(withdrew.facts).toEqual(["Applied 2 days ago", "Withdrew"]);
    // nothing is left to do with someone who withdrew: no button, no menu
    expect(withdrew.primary).toBeNull();
    expect(withdrew.more).toEqual([]);
  });

  it("makes the first action the API lists the row's button and puts the rest under More, allowed or not", () => {
    const beingRead = candidateActions(facts({ stage: "received" }));
    expect(rowActions(beingRead).primary).toEqual({ action: "shortlist", label: "Shortlist", allowed: false, reason: ACTION_BLOCKED.beingRead });
    expect(rowActions(beingRead).more.map((a) => a.label)).toEqual(["Hire", "Not selected"]);
    expect(rowActions([])).toEqual({ primary: null, more: [] });
  });

  it("opens the panel on the email before \"Email the decision\" sends anything; every other action is done where its button is", () => {
    expect(opensPanelFirst("send_decision")).toBe(true);
    for (const action of ["shortlist", "remind_screen", "send_new_link", "cancel_screen", "hire", "reject", "undo_decision", "unsend_decision"] as const) expect(opensPanelFirst(action), action).toBe(false);
  });

  it("asks again every few seconds only while a resume is being read or an AI interview scored", () => {
    expect(listRefresh({ rows: [row("a")] })).toBe(false);
    expect(listRefresh({ rows: [row("a"), row("b", { cvScore: cvScoreSummary(noCvScore("being_read")) })] })).toBe(4000);
    expect(listRefresh({ rows: [row("a", { interviewScore: interviewScoreSummary(noInterviewScore("being_scored")) })] })).toBe(4000);
    expect(listRefresh({ rows: [row("a", { cvScore: cvScoreSummary(noCvScore("ai_used_up")) })] })).toBe(false);
    expect(listRefresh(undefined)).toBe(false);
    expect(panelRefresh({ cvScore: noCvScore("being_read"), aiInterview: null })).toBe(4000);
    expect(panelRefresh({ cvScore: strong, aiInterview: { ...ai({ status: "done" }), score: noInterviewScore("being_scored"), review: null, answers: [] } })).toBe(4000);
    expect(panelRefresh({ cvScore: strong, aiInterview: null })).toBe(false);
    expect(panelRefresh(null)).toBe(false);
  });
});

describe("ticks and the bar for several people", () => {
  const rows = [
    row("a"),
    row("b"),
    row("c", { actions: candidateActions(facts({ stage: "received" })) }),
    row("d", { actions: candidateActions(facts({ reachable: false })) }),
  ];

  it("ticks and unticks one person, and everyone on screen with Select all", () => {
    expect([...toggleTick(new Set(), "a")]).toEqual(["a"]);
    expect([...toggleTick(new Set(["a", "b"]), "a")]).toEqual(["b"]);
    expect([...toggleAll(new Set(), rows)]).toEqual(["a", "b", "c", "d"]);
    expect([...toggleAll(new Set(["a"]), rows)]).toEqual(["a", "b", "c", "d"]);
    expect([...toggleAll(new Set(["a", "b", "c", "d"]), rows)]).toEqual([]);
    expect([...toggleAll(new Set(), [])]).toEqual([]);
  });

  it("never keeps a tick for someone who left the screen", () => {
    expect([...ticksOnScreen(new Set(["a", "gone"]), rows)]).toEqual(["a"]);
    expect([...ticksOnScreen(new Set(["gone"]), rows)]).toEqual([]);
  });

  it("draws no button with nobody ticked", () => {
    expect(bulkButtons(rows, new Set())).toEqual([]);
  });

  it("offers each action for several that some ticked person allows, in the API's order, for exactly the people who allow it", () => {
    expect(bulkButtons(rows, new Set(["a", "b"]))).toEqual([
      { action: "shortlist", label: "Shortlist", ids: ["a", "b"] },
      { action: "reject", label: "Not selected", ids: ["a", "b"] },
    ]);
    // c's resume is still being read and d has no working address: Shortlist reaches a alone, Not selected all three
    const mixed = bulkButtons(rows, new Set(["a", "c", "d"]));
    expect(mixed).toEqual([
      { action: "shortlist", label: "Shortlist", ids: ["a"] },
      { action: "reject", label: "Not selected", ids: ["a", "c", "d"] },
    ]);
    expect(bulkLabel(mixed[0], 3)).toBe("Shortlist (1 of 3)");
    expect(bulkLabel(mixed[1], 3)).toBe("Not selected");
  });

  it("draws nothing for an action no ticked person allows, and nothing for an action that is not one for several", () => {
    // only people Shortlist is not allowed for: the bar has no Shortlist button at all
    expect(bulkButtons(rows, new Set(["c", "d"])).map((b) => b.action)).toEqual(["reject"]);
    // Hire is never done for several, though every ticked row allows it
    expect(bulkButtons(rows, new Set(["a", "b"])).some((b) => (b.action as string) === "hire")).toBe(false);
    // a hired person allows only Undo, which is not an action for several: no button
    expect(bulkButtons([row("h", { stage: "hired", tab: "hired", actions: candidateActions(facts({ stage: "hired" })) })], new Set(["h"]))).toEqual([]);
  });

  it("under Not selected offers the email to those not told, and Don't send to those whose email still waits", () => {
    const list = [
      row("n", { stage: "rejected", tab: "not_selected", actions: candidateActions(facts({ stage: "rejected", toldState: "not_told" })) }),
      row("q", { stage: "rejected", tab: "not_selected", actions: candidateActions(facts({ stage: "rejected", toldState: "queued", decisionEmailWaiting: true })) }),
      row("t", { stage: "rejected", tab: "not_selected", actions: candidateActions(facts({ stage: "rejected", toldState: "sent" })) }),
    ];
    expect(bulkButtons(list, new Set(["n", "q", "t"]))).toEqual([
      { action: "send_decision", label: "Email the decision", ids: ["n"] },
      { action: "unsend_decision", label: "Don't send", ids: ["q"] },
    ]);
    // someone already told allows neither: ticked alone, the bar is empty
    expect(bulkButtons(list, new Set(["t"]))).toEqual([]);
  });

  it("sends a long list a hundred people a request, and reads the answers as one", () => {
    const ids = Array.from({ length: 230 }, (_, i) => `a${i}`);
    expect(batches(ids).map((b) => b.length)).toEqual([100, 100, 30]);
    expect(batches([])).toEqual([]);
    const part = (done: number, refused: BulkActionResult["results"], message: string, undoUntil: string | null): BulkActionResult => ({ action: "send_decision", results: [...Array.from({ length: done }, (_, i) => ({ applicationId: `ok${i}`, name: "Someone", ok: true, code: null, message: "" })), ...refused], done, refused: refused.length, message, undoUntil });
    const merged = mergeBulk([
      part(2, [], "2 emails on their way.", "2026-11-18T15:01:00.000Z"),
      part(1, [{ applicationId: "x", name: "Person X", ok: false, code: "action_not_allowed", message: ACTION_BLOCKED.noEmail }], "1 email on its way. 1 could not be sent.", "2026-11-18T15:00:30.000Z"),
    ]);
    expect(merged).toMatchObject({ action: "send_decision", done: 3, refused: 1, message: "2 emails on their way. 1 email on its way. 1 could not be sent.", undoUntil: "2026-11-18T15:00:30.000Z" });
    expect(merged?.results).toHaveLength(4);
    expect(refusedLines(merged as BulkActionResult)).toEqual([`Person X: ${ACTION_BLOCKED.noEmail}`]);
    expect(mergeBulk([])).toBeNull();
  });

  it("keeps Don't send for as long as the email still waits, and not a moment longer", () => {
    const at = Date.parse("2026-11-18T15:00:00.000Z");
    expect(undoMillis("2026-11-18T15:00:30.000Z", at)).toBe(30_000);
    expect(undoMillis("2026-11-18T14:59:00.000Z", at)).toBe(0);
    expect(undoMillis(null, at)).toBe(0);
    expect(undoMillis("not a date", at)).toBe(0);
  });
});

describe("a tab with nobody in it", () => {
  const list = (status: "draft" | "open" | "paused" | "closed", c: CandidateCounts) => ({ role: { id: "r1", status }, counts: c });

  it("offers to share an open job nobody has applied to yet", () => {
    expect(emptyView("new", list("open", counts()))).toEqual({ title: "Nobody has applied yet", action: { label: "Share the job", href: "/roles/r1?tab=share" } });
    expect(emptyView("new", list("paused", counts())).action).toEqual({ label: "Share the job", href: "/roles/r1?tab=share" });
    expect(emptyView("new", list("draft", counts()))).toEqual({ title: "Nobody has applied yet", action: { label: "Open the job", href: "/roles/r1" } });
    expect(emptyView("new", list("closed", counts()))).toEqual({ title: "Nobody has applied yet", action: null });
  });

  it("says nobody is new once everyone was reviewed, with nothing to press", () => {
    expect(emptyView("new", list("open", counts({ shortlisted: 2, hired: 1 })))).toEqual({ title: "Nobody new to review", action: null });
    // everyone who applied is past the plan's limit: the locked cards under the list say so, not an invitation to share
    expect(emptyView("new", list("open", { ...counts({}, 3), locked: 3 }))).toEqual({ title: "Nobody new to review", action: null });
  });

  it("points an empty later tab at the tab its people come from, when that one has someone", () => {
    expect(emptyView("shortlisted", list("open", counts({ new: 3 })))).toEqual({ title: "Nobody is shortlisted", action: { label: "Review new candidates", tab: "new" } });
    expect(emptyView("shortlisted", list("open", counts())).action).toBeNull();
    expect(emptyView("interviewed", list("open", counts({ shortlisted: 1 })))).toEqual({ title: "Nobody has finished the AI interview yet", action: { label: "See who is shortlisted", tab: "shortlisted" } });
    expect(emptyView("interviewed", list("open", counts({ new: 2 }))).action).toBeNull();
    expect(emptyView("hired", list("open", counts({ interviewed: 2 })))).toEqual({ title: "Nobody hired yet", action: { label: "See who was interviewed", tab: "interviewed" } });
    expect(emptyView("hired", list("open", counts())).action).toBeNull();
    expect(emptyView("not_selected", list("open", counts({ new: 5 })))).toEqual({ title: "Nobody here", action: null });
  });
});

describe("the candidate panel's actions, stage by stage", () => {
  const buttons = (f: Partial<CandidateActionFacts>) => panelButtons(candidateActions(facts(f))).map((b) => `${b.label}:${b.variant}:${b.allowed ? "on" : "off"}`);

  it("New: Shortlist is the main button, with the line that it sends the AI interview; then Hire and Not selected", () => {
    expect(buttons({ stage: "triaged" })).toEqual(["Shortlist:primary:on", "Hire:secondary:on", "Not selected:secondary:on"]);
    expect(panelButtons(candidateActions(facts({ stage: "triaged" })))[0].note).toBe(SHORTLIST_NOTE);
    expect(SHORTLIST_NOTE).toBe("Shortlist sends the AI interview.");
  });

  it("New, resume still being read: Shortlist stays, greyed, with the API's reason and no promise; Hire leads", () => {
    const list = panelButtons(candidateActions(facts({ stage: "received" })));
    expect(list.map((b) => `${b.label}:${b.variant}:${b.allowed ? "on" : "off"}`)).toEqual(["Shortlist:secondary:off", "Hire:primary:on", "Not selected:secondary:on"]);
    expect(list[0].reason).toBe(ACTION_BLOCKED.beingRead);
    expect(list[0].note).toBeNull();
  });

  it("New, the plan has no AI interviews left or the job is closed: Shortlist is greyed with that reason", () => {
    expect(panelButtons(candidateActions(facts({ planStop: "ai_interviews_used_up" })))[0]).toMatchObject({ action: "shortlist", allowed: false, reason: ACTION_BLOCKED.interviewsUsedUp, variant: "secondary", note: null });
    expect(panelButtons(candidateActions(facts({ roleStatus: "closed" })))[0]).toMatchObject({ allowed: false, reason: ACTION_BLOCKED.jobClosed });
  });

  it("Shortlisted, link open: Send a reminder, Cancel the AI interview (quiet), Hire, Not selected", () => {
    expect(buttons({ stage: "screen_invited", aiInterview: "sent" })).toEqual(["Send a reminder:primary:on", "Cancel the AI interview:ghost:on", "Hire:secondary:on", "Not selected:secondary:on"]);
    expect(buttons({ stage: "screening", aiInterview: "started" })[0]).toBe("Send a reminder:primary:on");
    // reminded in the last day: the reminder is greyed with why, and Hire leads
    const again = panelButtons(candidateActions(facts({ stage: "screen_invited", aiInterview: "sent", remindedRecently: true })));
    expect(again[0]).toMatchObject({ action: "remind_screen", allowed: false, reason: ACTION_BLOCKED.remindedRecently, variant: "secondary" });
    expect(again.find((b) => b.variant === "primary")?.action).toBe("hire");
  });

  it("Shortlisted, link closed: Send a new link instead of the reminder", () => {
    expect(buttons({ stage: "screen_invited", aiInterview: "link_closed" })).toEqual(["Send a new link:primary:on", "Cancel the AI interview:ghost:on", "Hire:secondary:on", "Not selected:secondary:on"]);
  });

  it("Shortlisted, chose not to do it: no email to send; Cancel, Hire, Not selected", () => {
    expect(buttons({ stage: "screen_invited", aiInterview: "opted_out" })).toEqual(["Cancel the AI interview:ghost:on", "Hire:primary:on", "Not selected:secondary:on"]);
  });

  it("Interviewed: Hire and Not selected, nothing else", () => {
    expect(buttons({ stage: "screen_complete", aiInterview: "done" })).toEqual(["Hire:primary:on", "Not selected:secondary:on"]);
  });

  it("Hired: Undo alone, quiet", () => {
    expect(buttons({ stage: "hired" })).toEqual(["Undo:ghost:on"]);
  });

  it("Not selected, not told: Email the decision and Undo", () => {
    expect(buttons({ stage: "rejected", toldState: "not_told" })).toEqual(["Email the decision:primary:on", "Undo:ghost:on"]);
    // no working address: the email is greyed with why, and nothing else becomes the main button
    const unreachable = panelButtons(candidateActions(facts({ stage: "rejected", toldState: "not_told", reachable: false })));
    expect(unreachable[0]).toMatchObject({ action: "send_decision", allowed: false, reason: ACTION_BLOCKED.noEmail, variant: "secondary" });
    expect(unreachable.some((b) => b.variant === "primary")).toBe(false);
  });

  it("Not selected, email on its way: Don't send, and Undo greyed until it is taken back", () => {
    const list = panelButtons(candidateActions(facts({ stage: "rejected", toldState: "queued", decisionEmailWaiting: true })));
    expect(list.map((b) => `${b.label}:${b.variant}:${b.allowed ? "on" : "off"}`)).toEqual(["Don't send:primary:on", "Undo:ghost:off"]);
    expect(list[1].reason).toBe(ACTION_BLOCKED.emailOnItsWay);
    // the email has left: Don't send is greyed too
    expect(panelButtons(candidateActions(facts({ stage: "rejected", toldState: "queued", decisionEmailWaiting: false })))[0]).toMatchObject({ allowed: false, reason: ACTION_BLOCKED.emailLeft });
  });

  it("Not selected, told: both stay, greyed, with why; nothing can be pressed", () => {
    const list = panelButtons(candidateActions(facts({ stage: "rejected", toldState: "sent" })));
    expect(list.map((b) => `${b.label}:${b.allowed ? "on" : "off"}`)).toEqual(["Email the decision:off", "Undo:off"]);
    expect(list.every((b) => b.reason === ACTION_BLOCKED.toldAlready)).toBe(true);
    expect(list.some((b) => b.variant === "primary")).toBe(false);
  });

  it("Withdrew: no button at all", () => {
    expect(panelButtons(candidateActions(facts({ stage: "withdrawn" })))).toEqual([]);
  });

  it("draws a button only for an action the API lists, in the API's words", () => {
    const listed = panelButtons([{ action: "hire", label: CANDIDATE_ACTION_LABEL.hire, allowed: true, reason: null }]);
    expect(listed.map((b) => b.action)).toEqual(["hire"]);
    expect(panelButtons([])).toEqual([]);
  });

  it("says plainly that a decision nobody has emailed is private", () => {
    const person = { candidate: { firstName: "Sam" } };
    expect(privateLine({ ...person, stage: "rejected", toldState: "not_told" })).toBe("Private: Sam has not been told.");
    expect(privateLine({ ...person, stage: "rejected", toldState: "queued" })).toBeNull();
    expect(privateLine({ ...person, stage: "rejected", toldState: "sent" })).toBeNull();
    expect(privateLine({ ...person, stage: "hired", toldState: null })).toBeNull();
    expect(privateLine({ candidate: { firstName: " " }, stage: "rejected", toldState: "not_told" })).toBe("Private: this person has not been told.");
  });
});

describe("the candidate panel's sections", () => {
  const doc = { id: "d1", filename: "resume.pdf", mime: "application/pdf", sizeBytes: 1000, status: "clean" as const, statusLabel: "Checked", hasText: true };

  it("frames a checked PDF as it is and any other checked file as its text, through this site's own address", () => {
    expect(resumeView("a1", doc)).toEqual({ frame: "/api/v1/applications/a1/documents/d1/inline", download: "/api/v1/applications/a1/documents/d1/file", words: null });
    const word = { ...doc, filename: "resume.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    expect(resumeView("a1", word).frame).toBe("/api/v1/applications/a1/documents/d1/inline?as=text");
    // not a PDF and no text of its own: only the download
    expect(resumeView("a1", { ...word, hasText: false })).toEqual({ frame: null, download: "/api/v1/applications/a1/documents/d1/file", words: null });
  });

  it("shows the API's line in place of a file that is not checked, with nothing to open", () => {
    expect(resumeView("a1", { ...doc, status: "quarantined", statusLabel: "This file is still being checked." })).toEqual({ frame: null, download: null, words: "This file is still being checked." });
    expect(resumeView("a1", { ...doc, status: "rejected", statusLabel: "This file was refused or removed and cannot be opened." }).download).toBeNull();
    expect(resumeView("a1", null)).toEqual({ frame: null, download: null, words: "No resume on file." });
  });

  it("lists every requirement in the API's order with what it is, its share, its finding's word and the quote it rests on", () => {
    expect(requirementRows(strong)).toEqual([
      { key: "m1", label: "Active RDA licence", tag: "Must-have", points: "40 points", finding: "Shown", tone: "good", quote: "\"RDA licence, renewed 2025\", from the resume" },
      { key: "m2", label: "Two years chairside", tag: "Must-have", points: "40 points", finding: "Shown", tone: "good", quote: "\"three years chairside\", from the resume" },
      { key: "s1", label: "Digital radiography", tag: "Important", points: "20 points", finding: "Partly shown", tone: "caution", quote: null },
    ]);
    expect(requirementRows(missing)[0]).toMatchObject({ finding: "Not met", tone: "critical" });
    expect(requirementRows(noCvScore("being_read"))).toEqual([]);
  });

  it("says when the AI interview's link went, how long it stays open and when the answers came, never how far anyone got", () => {
    expect(interviewFacts(null, now)).toEqual([]);
    expect(interviewFacts(ai(), now)).toEqual(["Sent Nov 17", "Link open until Nov 22"]);
    expect(interviewFacts(ai({ status: "started", startedAt: daysAgo(0) }), now)).toEqual(["Sent Nov 17", "Link open until Nov 22", "Started Nov 18"]);
    expect(interviewFacts(ai({ status: "done", linkOpenUntil: null, startedAt: daysAgo(0), completedAt: daysAgo(0) }), now)).toEqual(["Sent Nov 17", "Answers sent Nov 18"]);
  });

  it("lists each interview question with its finding's word, the note and their own words", () => {
    const score = interviewScoreOf([
      { key: "q1", question: "Tell us about a busy day.", finding: "shown", quote: "we saw forty patients", note: "A concrete example." },
      { key: "q2", question: "How do you sterilise instruments?", finding: "not_shown", quote: null, note: null },
    ]);
    expect(questionRows(score)).toEqual([
      { key: "q1", question: "Tell us about a busy day.", finding: "Shown", tone: "good", quote: "\"we saw forty patients\"", note: "A concrete example." },
      { key: "q2", question: "How do you sterilise instruments?", finding: "Not shown yet", tone: "neutral", quote: null, note: null },
    ]);
    expect(questionRows(noInterviewScore("being_scored"))).toEqual([]);
  });

  it("shows an answer as they sent it, and says when they skipped a question", () => {
    expect(answerWords({ answer: "  Three years.  ", skipped: false })).toBe("Three years.");
    expect(answerWords({ answer: null, skipped: true })).toBe("Skipped");
    expect(answerWords({ answer: " ", skipped: false })).toBe("No answer");
  });
});
