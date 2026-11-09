import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Presses in the console, pressed the way a person does while the page reads itself again under them (the review of 9
 * November 2026). There is no DOM renderer here, so the component is called as a plain function with React's hooks
 * replaced by a small stand-in that keeps its state from one draw to the next, as React does for one component on screen,
 * and draws again at once when the component changes its own state while drawing. Its children are not drawn: a test reads
 * and presses them by their props. What a press sends is what reaches `fetch`.
 */
const ui = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects: Array<() => void> = [];
  const runs: Array<Promise<void>> = [];
  const toasts: Array<{ title: string; more?: unknown }> = [];
  const answers = new Map<string, { data?: unknown; error?: unknown }>();
  let cursor = 0;
  let drawing = false;
  let again = false;
  type Options = { mutationFn: (v: unknown) => Promise<unknown>; onSuccess?: (r: unknown, v: unknown) => unknown; onError?: (e: unknown, v: unknown) => unknown };
  return {
    effects,
    toasts,
    answers,
    /** A new component on screen: no state yet. */
    fresh() {
      slots.length = 0;
      effects.length = 0;
      runs.length = 0;
      toasts.length = 0;
      answers.clear();
    },
    /** Draws the component with these props, keeping its state; drawn again at once while it changes its state as it draws. */
    draw<P>(component: (props: P) => unknown, props: P): unknown {
      let out: unknown;
      for (let n = 0; ; n++) {
        if (n > 20) throw new Error("drew more than 20 times in a row");
        again = false;
        cursor = 0;
        effects.length = 0;
        drawing = true;
        try {
          out = component(props);
        } finally {
          drawing = false;
        }
        if (!again) return out;
      }
    },
    /** Every press sent so far has had its answer. */
    async settled() {
      await Promise.all(runs);
    },
    useState(initial: unknown) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const set = (next: unknown) => {
        slots[i] = typeof next === "function" ? (next as (prev: unknown) => unknown)(slots[i]) : next;
        if (drawing) again = true;
      };
      return [slots[i], set];
    },
    useRef(initial: unknown) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useEffect(fn: () => void) {
      effects.push(fn);
    },
    /** As TanStack's: `mutate` runs the options of the latest draw, whichever draw's button was pressed. */
    useMutation(options: Options) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { options };
      const slot = slots[i] as { options: Options };
      slot.options = options;
      return {
        isPending: false,
        mutate: (v: unknown) => {
          const o = slot.options;
          runs.push((async () => {
            try {
              await o.onSuccess?.(await o.mutationFn(v), v);
            } catch (e) {
              await o.onError?.(e, v);
            }
          })());
        },
      };
    },
    useQuery(options: { queryKey: unknown[] }) {
      const a = answers.get(JSON.stringify(options.queryKey)) ?? {};
      return { data: a.data, error: a.error ?? null, isError: a.error !== undefined, isLoading: a.data === undefined && a.error === undefined, refetch: async () => undefined };
    },
  };
});

vi.mock("react", async (importOriginal) => ({ ...(await importOriginal<typeof import("react")>()), useState: ui.useState, useRef: ui.useRef, useEffect: ui.useEffect, useSyncExternalStore: (_subscribe: unknown, client: () => unknown) => client() }));
vi.mock("@tanstack/react-query", () => ({ useMutation: ui.useMutation, useQuery: ui.useQuery, useQueryClient: () => ({ invalidateQueries: async () => undefined }) }));
vi.mock("@ros/web/src/toast", () => ({ toast: (title: string, more?: unknown) => void ui.toasts.push({ title, more }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin", useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }), useParams: () => ({}), useSearchParams: () => new URLSearchParams("") }));
vi.mock("next/link", () => ({ default: () => null }));

const { AccessButtons, AccessChoice, CandidateScorePanel, CompanyCheckPanel, PlanPanel, TrialExtensionCard, companyCheckToast } = await import("@ros/web/src/pages/admin/customers");
const { Overview } = await import("@ros/web/src/pages/admin/Overview");
const { ApiError } = await import("@ros/web/src/api/client");
const { Button, Field, Segmented } = await import("@ros/ui");

type El = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;
const isEl = (n: unknown): n is El => !!n && typeof n === "object" && "props" in (n as object);
/** Every element in a drawn tree, the children of components not drawn included. */
function* elements(node: unknown): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* elements(n);
  else if (isEl(node)) {
    yield node;
    yield* elements(node.props.children);
  }
}
const propsOf = <T>(tree: unknown, type: unknown): T => {
  const el = [...elements(tree)].find((e) => e.type === type);
  expect(el, "drawn").toBeDefined();
  return el?.props as T;
};
/** A kit Button by its accessible name (its `ariaLabel`, or its words), and the words of every Button drawn. */
const named = (el: El) => (el.props.ariaLabel as string | undefined) ?? [el.props.children].flat().join("");
const buttons = (tree: unknown) => [...elements(tree)].filter((e) => e.type === Button);
const button = (tree: unknown, name: string) => {
  const b = buttons(tree).find((e) => named(e) === name);
  expect(b, name).toBeDefined();
  return b?.props as { onClick: () => void; disabled?: boolean; variant?: string };
};
/** Every string drawn in a tree: children, and the titles and labels of components not drawn. */
const words = (tree: unknown): string[] => [...elements(tree)].flatMap((e) => [e.props.children, e.props.title, e.props.label].flat().filter((w): w is string => typeof w === "string"));
/** A native field by its id: what it holds, and typing into it. */
const control = (tree: unknown, type: string, id: string) => [...elements(tree)].find((e) => e.type === type && e.props.id === id)?.props as { value: string; onChange: (e: unknown) => void } | undefined;

/** What the console sent, as `fetch` saw it, and the API's answer to each. */
const sent: Array<{ path: string; body: unknown }> = [];
function answer(status: number, json: unknown) {
  sent.length = 0;
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    sent.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
});

type Choice = Parameters<typeof AccessChoice>[0];
const person = { name: "Sam Asker", email: "sam@stranger.test" };
const harbor = (status: "requested" | "declined") => ({ id: "co-harbor", name: "Harbor Dental", accessRequest: { status, person, declined: status === "declined" ? { at: "2026-11-09T09:00:00.000Z", by: "Nadine" } : null } });
const DECIDED = { error: { code: "access_decided", message: "Harbor Dental was declined a moment ago by Nadine. Nothing changed. To let them in, accept it under Declined." } };

describe("a question asked on a request for access", () => {
  it("keeps where the request stood at its first press: the list read again with another administrator's Decline takes it away, and a Yes that lands first still says requested, so it changes nothing", async () => {
    ui.fresh();
    answer(409, DECIDED);
    // Paul, in the drawer's ITS check: Accept, and the question
    let tree = ui.draw(AccessButtons, { company: harbor("requested") });
    propsOf<Choice>(tree, AccessChoice).onPress("accept");
    tree = ui.draw(AccessButtons, { company: harbor("requested") });
    const asked = propsOf<Choice>(tree, AccessChoice);
    expect(asked.asking).toBe("accept");
    const yes = button(AccessChoice(asked), "Yes, accept Harbor Dental");
    // the list is read again on focus: Nadine declined it from the Overview meanwhile
    tree = ui.draw(AccessButtons, { company: harbor("declined") });
    const now = propsOf<Choice>(tree, AccessChoice);
    expect(now.asking).toBeNull();
    // the card offers the declined company's own Accept, the undo, and no question
    expect(buttons(AccessChoice(now)).map(named)).toEqual(["Accept Harbor Dental"]);
    // a Yes that lands before that draw sends what the first press saw
    yes.onClick();
    await ui.settled();
    expect(sent).toEqual([{ path: "/api/v1/admin/customers/co-harbor/access", body: { decision: "accept", from: "requested", confirm: true } }]);
    // the API's calm answer, as a calm toast
    expect(ui.toasts).toEqual([{ title: DECIDED.error.message, more: undefined }]);
  });

  it("a question on a row that stays as it was sends where it stands: requested from a request, declined from the declined company's own Accept", async () => {
    for (const status of ["requested", "declined"] as const) {
      ui.fresh();
      answer(200, { ok: true, companyId: "co-harbor", decision: "accept", status: "active", changed: true, message: "Harbor Dental was accepted." });
      let tree = ui.draw(AccessButtons, { company: harbor(status) });
      propsOf<Choice>(tree, AccessChoice).onPress("accept");
      tree = ui.draw(AccessButtons, { company: harbor(status) });
      tree = ui.draw(AccessButtons, { company: harbor(status) });
      const asked = propsOf<Choice>(tree, AccessChoice);
      expect(asked.asking, status).toBe("accept");
      button(AccessChoice(asked), "Yes, accept Harbor Dental").onClick();
      await ui.settled();
      expect(sent, status).toEqual([{ path: "/api/v1/admin/customers/co-harbor/access", body: { decision: "accept", from: status, confirm: true } }]);
      expect(ui.toasts, status).toEqual([{ title: "Harbor Dental was accepted.", more: undefined }]);
    }
  });

  it("No takes the question away, and a Decline asked on a request sends requested", async () => {
    ui.fresh();
    answer(200, { ok: true, companyId: "co-harbor", decision: "decline", status: "declined", changed: true, message: "Harbor Dental was declined." });
    let tree = ui.draw(AccessButtons, { company: harbor("requested") });
    propsOf<Choice>(tree, AccessChoice).onPress("decline");
    tree = ui.draw(AccessButtons, { company: harbor("requested") });
    propsOf<Choice>(tree, AccessChoice).onNo();
    tree = ui.draw(AccessButtons, { company: harbor("requested") });
    expect(propsOf<Choice>(tree, AccessChoice).asking).toBeNull();
    propsOf<Choice>(tree, AccessChoice).onPress("decline");
    tree = ui.draw(AccessButtons, { company: harbor("requested") });
    button(AccessChoice(propsOf<Choice>(tree, AccessChoice)), "Yes, decline Harbor Dental").onClick();
    await ui.settled();
    expect(sent).toEqual([{ path: "/api/v1/admin/customers/co-harbor/access", body: { decision: "decline", from: "requested", confirm: true } }]);
  });
});

describe("a question asked in the company check", () => {
  const CONFIRMED_AT = "2026-11-09T10:00:00.000Z";
  type Panel = Parameters<typeof CompanyCheckPanel>[0];
  const check = (verifiedAt: string | null): Panel => ({ company: { id: "co-harbor", name: "Harbor Dental", verifiedAt, verifiedBy: verifiedAt ? { id: "s2", name: "Nadine" } : null, heldMessages: 0, whoPosts: "its", jobBoardsConfirmedAt: null, settings: {} } as never });
  const field = (tree: unknown) => {
    const input = [...elements(tree)].find((e) => e.type === "input" && e.props.id === "co-check-why");
    const label = [...elements(tree)].find((e) => e.type === Field && e.props.htmlFor === "co-check-why");
    return { value: input?.props.value, label: label?.props.label, type: (text: string) => (input?.props.onChange as (e: unknown) => void)({ target: { value: text } }) };
  };
  /** Types the reason and presses the card's button: the question, and its Yes as drawn then. */
  const ask = (verifiedAt: string | null, reasonTyped: string, press: string) => {
    ui.fresh();
    let tree = ui.draw(CompanyCheckPanel, check(verifiedAt));
    field(tree).type(reasonTyped);
    tree = ui.draw(CompanyCheckPanel, check(verifiedAt));
    button(tree, press).onClick();
    return ui.draw(CompanyCheckPanel, check(verifiedAt));
  };

  it("keeps what its first press asked for: another administrator's confirmation read in under a pending Confirm takes the question away, keeps the reason, and a Yes that lands first sends verified: true, never a taking back", async () => {
    answer(200, { ok: true, companyId: "co-harbor", verified: true, changed: false, verifiedAt: CONFIRMED_AT, releasedMessages: 0 });
    // Paul types how he checked it and presses Confirm the company
    let tree = ask(null, "Called the owner", "Confirm the company");
    expect(words(tree)).toContain("Confirm Harbor Dental and make its pages public?");
    const yes = button(tree, "Yes, confirm it");
    expect(yes.variant).toBe("primary");
    // Nadine confirms the same company; the minute's look lands, and no question is left, either way round
    tree = ui.draw(CompanyCheckPanel, check(CONFIRMED_AT));
    expect(words(tree)).not.toContain("Take back the confirmation of Harbor Dental?");
    expect(words(tree)).not.toContain("Confirm Harbor Dental and make its pages public?");
    expect(buttons(tree).map(named)).toEqual(["Take back the confirmation", "ITS can sign in to the job boards"]);
    // the card now says what is true, and what he typed stays
    expect(field(tree)).toMatchObject({ label: "Why you are taking it back", value: "Called the owner" });
    // a Yes pressed before that draw asks for what it said
    yes.onClick();
    await ui.settled();
    expect(sent).toEqual([{ path: "/api/v1/admin/customers/co-harbor/verification", body: { verified: true, reason: "Called the owner", confirm: true } }]);
    expect(ui.toasts).toEqual([{ title: "Harbor Dental was already confirmed.", more: "Nothing changed." }]);
  });

  it("the mirror: a pending take-back, once someone else took it back, never makes the pages public again", async () => {
    answer(200, { ok: true, companyId: "co-harbor", verified: false, changed: false, verifiedAt: null, releasedMessages: 0 });
    let tree = ask(CONFIRMED_AT, "The website does not match", "Take back the confirmation");
    expect(words(tree)).toContain("Take back the confirmation of Harbor Dental?");
    const yes = button(tree, "Yes, take it back");
    expect(yes.variant).toBe("destructive");
    tree = ui.draw(CompanyCheckPanel, check(null));
    expect(words(tree)).not.toContain("Confirm Harbor Dental and make its pages public?");
    expect(words(tree)).not.toContain("Take back the confirmation of Harbor Dental?");
    expect(buttons(tree).map(named)).toEqual(["Confirm the company", "ITS can sign in to the job boards"]);
    expect(field(tree)).toMatchObject({ label: "How you checked the company", value: "The website does not match" });
    yes.onClick();
    await ui.settled();
    expect(sent).toEqual([{ path: "/api/v1/admin/customers/co-harbor/verification", body: { verified: false, reason: "The website does not match", confirm: true } }]);
    expect(ui.toasts).toEqual([{ title: "Harbor Dental's confirmation was already taken back.", more: "Nothing changed." }]);
  });

  it("a question on a card that stays as it was sends what it asked, and the toast says what changed", async () => {
    answer(200, { ok: true, companyId: "co-harbor", verified: true, changed: true, verifiedAt: CONFIRMED_AT, releasedMessages: 2 });
    let tree = ask(null, "Called the owner", "Confirm the company");
    tree = ui.draw(CompanyCheckPanel, check(null));
    button(tree, "Yes, confirm it").onClick();
    await ui.settled();
    expect(sent).toEqual([{ path: "/api/v1/admin/customers/co-harbor/verification", body: { verified: true, reason: "Called the owner", confirm: true } }]);
    expect(ui.toasts).toEqual([{ title: "Harbor Dental is confirmed.", more: "Its pages are public now and 2 held messages are on their way. The owners were told." }]);
    // No takes the question away and keeps the reason
    tree = ask(CONFIRMED_AT, "A doubt about the company", "Take back the confirmation");
    button(tree, "No").onClick();
    tree = ui.draw(CompanyCheckPanel, check(CONFIRMED_AT));
    expect(words(tree)).not.toContain("Take back the confirmation of Harbor Dental?");
    expect(field(tree).value).toBe("A doubt about the company");
  });

  it("Send the held messages asks only to send them, so the API can refuse it on a company no longer confirmed, in its own words", async () => {
    ui.fresh();
    const refusal = "Harbor Dental is not confirmed any more, so nothing was sent. Its held messages go out when it is confirmed again.";
    answer(409, { error: { code: "not_confirmed", message: refusal } });
    const tree = ui.draw(CompanyCheckPanel, { company: { ...check(CONFIRMED_AT).company, heldMessages: 2 } as never });
    button(tree, "Send the held messages").onClick();
    await ui.settled();
    expect(sent).toEqual([{ path: "/api/v1/admin/customers/co-harbor/verification", body: { verified: true, heldOnly: true, reason: "Held messages sent after the company was confirmed.", confirm: true } }]);
    expect(ui.toasts).toEqual([{ title: refusal, more: undefined }]);
  });

  it("words the toast from what was asked and whether it changed anything", () => {
    expect(companyCheckToast("Harbor Dental", true, { changed: true, releasedMessages: 0 })).toEqual({ title: "Harbor Dental is confirmed.", detail: "Its pages are public now. The owners were told." });
    expect(companyCheckToast("Harbor Dental", true, { changed: true, releasedMessages: 1 })).toEqual({ title: "Harbor Dental is confirmed.", detail: "Its pages are public now and 1 held message is on its way. The owners were told." });
    expect(companyCheckToast("Harbor Dental", false, { changed: true, releasedMessages: 0 })).toEqual({ title: "Harbor Dental is no longer confirmed.", detail: "Its public pages are offline and its messages to candidates wait. The owners were told." });
    expect(companyCheckToast("Harbor Dental", true, { changed: false, releasedMessages: 0 })).toEqual({ title: "Harbor Dental was already confirmed.", detail: "Nothing changed." });
    // confirming a confirmed company sends anything still held, and says so
    expect(companyCheckToast("Harbor Dental", true, { changed: false, releasedMessages: 3 })).toEqual({ title: "Harbor Dental was already confirmed.", detail: "3 held messages are on their way." });
    expect(companyCheckToast("Harbor Dental", false, { changed: false, releasedMessages: 0 })).toEqual({ title: "Harbor Dental's confirmation was already taken back.", detail: "Nothing changed." });
  });
});

describe("a change of plan picked in the drawer", () => {
  const PLANS = [
    { key: "free", name: "Free", prices: { monthlyUsd: 0 }, limits: {} },
    { key: "basic", name: "Basic", prices: { monthlyUsd: 49 }, limits: {} },
    { key: "pro", name: "Pro", prices: { monthlyUsd: 99 }, limits: {} },
  ];
  const onPlan = (planKey: string): Parameters<typeof PlanPanel>[0] => ({ company: { id: "co-harbor", name: "Harbor Dental", planKey, status: "active", screeningConversations: null, trial: null } as never, onDone: () => undefined });

  it("starts again from the plan another administrator moved the company to, so it never offers to move it back unasked; the reason stays, and a Yes that lands first sends the plan its question named", async () => {
    ui.fresh();
    ui.answers.set(JSON.stringify(["admin", "plans"]), { data: PLANS });
    answer(200, { trialEnded: false, unlocked: 0, aiCreditMonthStarted: false });
    // Paul picks Pro for a company on Free, says why, and presses Change plan
    let tree = ui.draw(PlanPanel, onPlan("free"));
    control(tree, "select", "plan-pick")?.onChange({ target: { value: "pro" } });
    tree = ui.draw(PlanPanel, onPlan("free"));
    control(tree, "input", "plan-why")?.onChange({ target: { value: "Asked for more jobs." } });
    tree = ui.draw(PlanPanel, onPlan("free"));
    button(tree, "Change plan").onClick();
    tree = ui.draw(PlanPanel, onPlan("free"));
    const yes = button(tree, "Yes, change it");
    // Nadine put it on Basic meanwhile; the minute's look lands: the panel shows Basic, and offers nothing
    tree = ui.draw(PlanPanel, onPlan("basic"));
    expect(control(tree, "select", "plan-pick")?.value).toBe("basic");
    expect(buttons(tree).map(named)).toEqual([]);
    expect(control(tree, "input", "plan-why")).toBeUndefined();
    // picking again, the reason typed is still there
    control(tree, "select", "plan-pick")?.onChange({ target: { value: "free" } });
    tree = ui.draw(PlanPanel, onPlan("basic"));
    expect(control(tree, "input", "plan-why")?.value).toBe("Asked for more jobs.");
    // a Yes pressed before that draw sends the plan its question named, never the plan the company is on
    yes.onClick();
    await ui.settled();
    expect(sent).toEqual([{ path: "/api/v1/admin/customers/co-harbor/plan", body: { planKey: "pro", reason: "Asked for more jobs." } }]);
    expect(ui.toasts.map((t) => t.title)).toEqual(["Harbor Dental is on Pro now."]);
  });
});

describe("a trial extension asked in the drawer", () => {
  const card = (endsAt: string): Parameters<typeof TrialExtensionCard>[0] => ({ company: { id: "co-harbor", name: "Harbor Dental", timezone: "America/Los_Angeles" } as never, trial: { started: true, startedAt: "2026-10-21T17:00:00.000Z", endsAt, daysLeft: 11, endingSoon: false, ended: false, extendedDays: 0 } });

  it("goes when another administrator's extension is read in under it, so its date never moves under a pending Yes that would add the days again; the days and the reason stay", () => {
    ui.fresh();
    let tree = ui.draw(TrialExtensionCard, card("2026-11-20T17:00:00.000Z"));
    control(tree, "input", "trial-why")?.onChange({ target: { value: "The owner's kick-off moved." } });
    tree = ui.draw(TrialExtensionCard, card("2026-11-20T17:00:00.000Z"));
    button(tree, "Extend the trial").onClick();
    tree = ui.draw(TrialExtensionCard, card("2026-11-20T17:00:00.000Z"));
    expect(buttons(tree).map(named)).toEqual(["Yes, extend it", "No"]);
    // Nadine extended it by 14 days meanwhile; the minute's look lands
    tree = ui.draw(TrialExtensionCard, card("2026-12-04T17:00:00.000Z"));
    expect(buttons(tree).map(named)).toEqual(["Extend the trial"]);
    expect(control(tree, "input", "trial-why")?.value).toBe("The owner's kick-off moved.");
    expect(control(tree, "input", "trial-days")?.value).toBe("14");
  });
});

describe("the applicants' match score switch in the drawer", () => {
  const panel = (shown: boolean): Parameters<typeof CandidateScorePanel>[0] => ({ company: { id: "co-harbor", name: "Harbor Dental", candidateScoreShown: shown, settings: {} } as never });
  const choice = (tree: unknown) => propsOf<{ value: string; onChange: (v: string) => void }>(tree, Segmented);

  it("starts again from the switch as another administrator left it, so it never shows the old setting with a Save that would turn it back", () => {
    ui.fresh();
    let tree = ui.draw(CandidateScorePanel, panel(true));
    expect(choice(tree).value).toBe("shown");
    // Nadine turned it off; the minute's look lands
    tree = ui.draw(CandidateScorePanel, panel(false));
    expect(choice(tree).value).toBe("hidden");
    expect(buttons(tree).map(named)).toEqual([]);
    // the same in the middle of a change: the switch as it now is, and nothing to save
    choice(tree).onChange("shown");
    tree = ui.draw(CandidateScorePanel, panel(false));
    expect(buttons(tree).map(named)).toEqual(["Save", "Cancel"]);
    tree = ui.draw(CandidateScorePanel, panel(true));
    expect(choice(tree).value).toBe("shown");
    expect(buttons(tree).map(named)).toEqual([]);
  });
});

describe("the console's Overview left open", () => {
  /** Draws the Overview with yesterday's customers and this look's failure, then runs what it does once drawn. */
  const comeBack = (error: unknown) => {
    ui.fresh();
    ui.answers.set(JSON.stringify(["admin", "customers"]), { data: [], error });
    ui.answers.set(JSON.stringify(["admin", "alerts"]), { data: [] });
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    ui.draw(Overview, {});
    for (const effect of ui.effects) effect();
    return assign.mock.calls;
  };

  it("goes to sign in once a look answers 401: the staff session ended while the tab was hidden or asleep", () => {
    expect(comeBack(new ApiError(401, "unauthorized", "Sign in to continue."))).toEqual([["/login"]]);
  });

  it("stays on any other failure, which says so on its own row", () => {
    expect(comeBack(new ApiError(500, "error", "Something went wrong. It has been logged."))).toEqual([]);
    expect(comeBack(new ApiError(403, "mfa_required", "Confirm it's you."))).toEqual([]);
    expect(comeBack(new TypeError("Failed to fetch"))).toEqual([]);
  });
});
