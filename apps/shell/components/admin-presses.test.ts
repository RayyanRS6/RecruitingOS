import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminCompany } from "@ros/contracts";

/**
 * Presses in the admin dashboard, pressed the way a person does while the page reads itself again under them. There is
 * no DOM renderer here, so the component is called as a plain function with React's hooks replaced by a small stand-in
 * that keeps its state from one draw to the next, as React does for one component on screen, and draws again at once
 * when the component changes its own state while drawing. Its children are not drawn: a test reads and presses them by
 * their props. What a press sends is what reaches `fetch`.
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
    useQuery(options: { queryKey: readonly unknown[] }) {
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

const { AccessButtons, AccessChoice } = await import("@ros/web/src/pages/admin/access");
const { Companies } = await import("@ros/web/src/pages/admin/companies");
const { PlanChangeForm, TrialCard } = await import("@ros/web/src/pages/admin/plan");
const { Home } = await import("@ros/web/src/pages/Home");
const { ApiError } = await import("@ros/web/src/api/client");
const { Button } = await import("@ros/ui");

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
/** A kit Button by its accessible name (its `ariaLabel`, or its words), and the names of every Button drawn. */
const named = (el: El) => (el.props.ariaLabel as string | undefined) ?? [el.props.children].flat().join("");
const buttons = (tree: unknown) => [...elements(tree)].filter((e) => e.type === Button);
const button = (tree: unknown, name: string) => {
  const b = buttons(tree).find((e) => named(e) === name);
  expect(b, name).toBeDefined();
  return b?.props as { onClick: () => void; disabled?: boolean; variant?: string };
};
/** A native field by its id: what it holds, and typing into it. */
const control = (tree: unknown, type: string, id: string) => [...elements(tree)].find((e) => e.type === type && e.props.id === id)?.props as { value: string; onChange: (e: unknown) => void } | undefined;

/** What the dashboard sent, as `fetch` saw it, and the API's answer to each. */
const sent: Array<{ path: string; body: unknown; reason: string | undefined }> = [];
function answer(status: number, json: unknown) {
  sent.length = 0;
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    sent.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined, reason: (init.headers as Record<string, string> | undefined)?.["x-admin-reason"] });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
});

type Choice = Parameters<typeof AccessChoice>[0];
type Row = Parameters<typeof AccessButtons>[0]["company"];
const person = { name: "Sam Asker", email: "sam@stranger.test" };
/** Harbor Dental as its row stands: a request, a declined company, or an accepted one. */
const harbor = (status: AdminCompany["status"]): Row => ({
  id: "co-harbor",
  name: "Harbor Dental",
  accessRequest: status === "active" ? null : { status: status === "waiting" ? "requested" : "declined", person, declined: status === "declined" ? { at: "2026-11-09T09:00:00.000Z", by: "Nadine" } : null },
  accessDecisions: status === "waiting" ? ["accept", "decline"] : status === "declined" ? ["accept"] : ["remove"],
});
const DECIDED = { error: { code: "access_decided", message: "Harbor Dental was declined a moment ago by Nadine. Nothing changed. To let them in, accept it under Declined." } };
const ACCESS = "/api/v1/admin/customers/co-harbor/access";

describe("Accept and Decline on a request: the second press", () => {
  it("the first press only asks; Yes sends the decision with where the request stood, and the toast is the API's words", async () => {
    for (const decision of ["accept", "decline"] as const) {
      ui.fresh();
      answer(200, { ok: true, companyId: "co-harbor", decision, status: decision === "accept" ? "active" : "declined", changed: true, message: `Harbor Dental was ${decision === "accept" ? "accepted" : "declined"}.` });
      let tree = ui.draw(AccessButtons, { company: harbor("waiting") });
      // no question yet: Accept and Decline, and nothing has been sent
      expect(buttons(AccessChoice(propsOf<Choice>(tree, AccessChoice))).map(named)).toEqual(["Accept Harbor Dental", "Decline Harbor Dental"]);
      propsOf<Choice>(tree, AccessChoice).onPress(decision);
      expect(sent, decision).toEqual([]);
      tree = ui.draw(AccessButtons, { company: harbor("waiting") });
      const asked = propsOf<Choice>(tree, AccessChoice);
      expect(asked.asking, decision).toBe(decision);
      expect(buttons(AccessChoice(asked)).map(named), decision).toEqual([`Yes, ${decision} Harbor Dental`, `No, do not ${decision} Harbor Dental`]);
      button(AccessChoice(asked), `Yes, ${decision} Harbor Dental`).onClick();
      await ui.settled();
      expect(sent, decision).toEqual([{ path: ACCESS, body: { decision, from: "requested", confirm: true }, reason: "admin dashboard: access request" }]);
      expect(ui.toasts, decision).toEqual([{ title: `Harbor Dental was ${decision === "accept" ? "accepted" : "declined"}.`, more: undefined }]);
    }
  });

  it("No takes the question away and sends nothing", async () => {
    ui.fresh();
    answer(200, {});
    let tree = ui.draw(AccessButtons, { company: harbor("waiting") });
    propsOf<Choice>(tree, AccessChoice).onPress("decline");
    tree = ui.draw(AccessButtons, { company: harbor("waiting") });
    propsOf<Choice>(tree, AccessChoice).onNo();
    tree = ui.draw(AccessButtons, { company: harbor("waiting") });
    expect(propsOf<Choice>(tree, AccessChoice).asking).toBeNull();
    await ui.settled();
    expect(sent).toEqual([]);
  });

  it("keeps where the request stood at its first press: the list read again with another administrator's Decline takes the question away, and a Yes that lands first still says requested, so it changes nothing", async () => {
    ui.fresh();
    answer(409, DECIDED);
    let tree = ui.draw(AccessButtons, { company: harbor("waiting") });
    propsOf<Choice>(tree, AccessChoice).onPress("accept");
    tree = ui.draw(AccessButtons, { company: harbor("waiting") });
    const asked = propsOf<Choice>(tree, AccessChoice);
    const yes = button(AccessChoice(asked), "Yes, accept Harbor Dental");
    // the list is read again on focus: another administrator declined it meanwhile
    tree = ui.draw(AccessButtons, { company: harbor("declined") });
    const now = propsOf<Choice>(tree, AccessChoice);
    expect(now.asking).toBeNull();
    // the row offers the declined company's own Accept, the undo, and no question
    expect(buttons(AccessChoice(now)).map(named)).toEqual(["Accept Harbor Dental"]);
    // a Yes that lands before that draw sends what the first press saw
    yes.onClick();
    await ui.settled();
    expect(sent.map((s) => s.body)).toEqual([{ decision: "accept", from: "requested", confirm: true }]);
    // the API's calm answer, as a calm toast
    expect(ui.toasts).toEqual([{ title: DECIDED.error.message, more: undefined }]);
  });

  it("a declined company's Accept, the undo, says declined", async () => {
    ui.fresh();
    answer(200, { ok: true, companyId: "co-harbor", decision: "accept", status: "active", changed: true, message: "Harbor Dental was accepted." });
    let tree = ui.draw(AccessButtons, { company: harbor("declined") });
    propsOf<Choice>(tree, AccessChoice).onPress("accept");
    tree = ui.draw(AccessButtons, { company: harbor("declined") });
    button(AccessChoice(propsOf<Choice>(tree, AccessChoice)), "Yes, accept Harbor Dental").onClick();
    await ui.settled();
    expect(sent.map((s) => s.body)).toEqual([{ decision: "accept", from: "declined", confirm: true }]);
  });
});

describe("Take away access on an accepted company", () => {
  it("asks first, then sends remove with no place, and says how many lost access and that the owner was emailed only when the email left", async () => {
    ui.fresh();
    answer(200, { ok: true, companyId: "co-harbor", decision: "remove", status: "declined", changed: true, message: "Harbor Dental no longer has access.", people: 2, emailed: true });
    let tree = ui.draw(AccessButtons, { company: harbor("active") });
    expect(buttons(AccessChoice(propsOf<Choice>(tree, AccessChoice))).map(named)).toEqual(["Take away access from Harbor Dental"]);
    propsOf<Choice>(tree, AccessChoice).onPress("remove");
    tree = ui.draw(AccessButtons, { company: harbor("active") });
    const asked = propsOf<Choice>(tree, AccessChoice);
    expect(asked.asking).toBe("remove");
    const yes = button(AccessChoice(asked), "Yes, take away access from Harbor Dental");
    expect(yes.variant).toBe("destructive");
    yes.onClick();
    await ui.settled();
    expect(sent).toEqual([{ path: ACCESS, body: { decision: "remove", confirm: true }, reason: "admin dashboard: take away access" }]);
    expect(ui.toasts).toEqual([{ title: "Harbor Dental no longer has access.", more: "2 people can no longer work in it. We emailed the owner." }]);
  });

  it("the question goes once someone else took the access away: the row then offers Accept, and no Yes is left to press", () => {
    ui.fresh();
    let tree = ui.draw(AccessButtons, { company: harbor("active") });
    propsOf<Choice>(tree, AccessChoice).onPress("remove");
    tree = ui.draw(AccessButtons, { company: harbor("active") });
    expect(propsOf<Choice>(tree, AccessChoice).asking).toBe("remove");
    tree = ui.draw(AccessButtons, { company: harbor("declined") });
    const now = propsOf<Choice>(tree, AccessChoice);
    expect(now.asking).toBeNull();
    expect(buttons(AccessChoice(now)).map(named)).toEqual(["Accept Harbor Dental"]);
  });
});

describe("a change of plan picked in the drawer", () => {
  const PLANS = [
    { key: "free", name: "Free", prices: { monthlyUsd: 0 }, limits: {} },
    { key: "basic", name: "Basic", prices: { monthlyUsd: 49 }, limits: {} },
    { key: "pro", name: "Pro", prices: { monthlyUsd: 99 }, limits: {} },
  ];
  const onPlan = (planKey: string, planName: string): Parameters<typeof PlanChangeForm>[0] => ({ company: { id: "co-harbor", name: "Harbor Dental", planKey, planName }, onDone: () => undefined });

  it("starts again from the plan another administrator moved the company to, so it never offers to move it back unasked; the reason stays, and a Yes that lands first sends the plan its question named", async () => {
    ui.fresh();
    ui.answers.set(JSON.stringify(["admin", "plans"]), { data: PLANS });
    answer(200, { trialEnded: false, unlocked: 0, aiCreditMonthStarted: false });
    // pick Pro for a company on Free, say why, and press Change plan
    let tree = ui.draw(PlanChangeForm, onPlan("free", "Free"));
    // nothing to change it to yet: only the way out
    expect(buttons(tree).map(named)).toEqual(["Cancel"]);
    control(tree, "select", "plan-pick")?.onChange({ target: { value: "pro" } });
    tree = ui.draw(PlanChangeForm, onPlan("free", "Free"));
    // no reason yet: Change plan waits
    expect(button(tree, "Change plan").disabled).toBe(true);
    control(tree, "input", "plan-why")?.onChange({ target: { value: "Asked for more jobs." } });
    tree = ui.draw(PlanChangeForm, onPlan("free", "Free"));
    button(tree, "Change plan").onClick();
    tree = ui.draw(PlanChangeForm, onPlan("free", "Free"));
    const yes = button(tree, "Yes, change it");
    // another administrator put it on Basic meanwhile; the minute's look lands: the form shows Basic, and offers no change
    tree = ui.draw(PlanChangeForm, onPlan("basic", "Basic"));
    expect(control(tree, "select", "plan-pick")?.value).toBe("basic");
    expect(buttons(tree).map(named)).toEqual(["Cancel"]);
    expect(control(tree, "input", "plan-why")).toBeUndefined();
    // picking again, the reason typed is still there
    control(tree, "select", "plan-pick")?.onChange({ target: { value: "free" } });
    tree = ui.draw(PlanChangeForm, onPlan("basic", "Basic"));
    expect(control(tree, "input", "plan-why")?.value).toBe("Asked for more jobs.");
    // a Yes pressed before that draw sends the plan its question named, never the plan the company is on
    yes.onClick();
    await ui.settled();
    expect(sent.map((s) => ({ path: s.path, body: s.body }))).toEqual([{ path: "/api/v1/admin/customers/co-harbor/plan", body: { planKey: "pro", reason: "Asked for more jobs." } }]);
    expect(ui.toasts.map((t) => t.title)).toEqual(["Harbor Dental is on Pro now."]);
  });

  it("keeps a plan that is no longer offered in the list while the company is on it", () => {
    ui.fresh();
    ui.answers.set(JSON.stringify(["admin", "plans"]), { data: PLANS });
    const tree = ui.draw(PlanChangeForm, onPlan("growth", "Growth"));
    const options = [...elements(tree)].filter((e) => e.type === "option").map((e) => [e.props.value, e.props.children]);
    expect(options).toEqual([["free", "Free"], ["basic", "Basic"], ["pro", "Pro"], ["growth", "Growth"]]);
    expect(control(tree, "select", "plan-pick")?.value).toBe("growth");
  });
});

describe("a trial extension asked in the drawer", () => {
  const card = (endsAt: string): Parameters<typeof TrialCard>[0] => ({ company: { id: "co-harbor", name: "Harbor Dental", timezone: "America/Los_Angeles", trialTerm: null }, trial: { started: true, startedAt: "2026-10-21T17:00:00.000Z", endsAt, daysLeft: 11, endingSoon: false, ended: false, extendedDays: 0 } });

  it("goes when another administrator's extension is read in under it, so its date never moves under a pending Yes that would add the days again; the days and the reason stay", () => {
    ui.fresh();
    let tree = ui.draw(TrialCard, card("2026-11-20T17:00:00.000Z"));
    control(tree, "input", "trial-why")?.onChange({ target: { value: "The owner's kick-off moved." } });
    tree = ui.draw(TrialCard, card("2026-11-20T17:00:00.000Z"));
    button(tree, "Extend the trial").onClick();
    tree = ui.draw(TrialCard, card("2026-11-20T17:00:00.000Z"));
    expect(buttons(tree).map(named)).toEqual(["Yes, extend it", "No"]);
    // another administrator extended it by 14 days meanwhile; the minute's look lands
    tree = ui.draw(TrialCard, card("2026-12-04T17:00:00.000Z"));
    expect(buttons(tree).map(named)).toEqual(["Extend the trial"]);
    expect(control(tree, "input", "trial-why")?.value).toBe("The owner's kick-off moved.");
    expect(control(tree, "input", "trial-days")?.value).toBe("14");
  });

  it("sends the days and the reason once confirmed", async () => {
    ui.fresh();
    answer(200, { ok: true, companyId: "co-harbor", trial: { started: true, startedAt: "2026-10-21T17:00:00.000Z", endsAt: "2026-12-04T17:00:00.000Z", daysLeft: 25, endingSoon: false, ended: false, extendedDays: 14 } });
    let tree = ui.draw(TrialCard, card("2026-11-20T17:00:00.000Z"));
    control(tree, "input", "trial-why")?.onChange({ target: { value: "  The owner's kick-off moved.  " } });
    tree = ui.draw(TrialCard, card("2026-11-20T17:00:00.000Z"));
    button(tree, "Extend the trial").onClick();
    tree = ui.draw(TrialCard, card("2026-11-20T17:00:00.000Z"));
    button(tree, "Yes, extend it").onClick();
    await ui.settled();
    expect(sent.map((s) => ({ path: s.path, body: s.body }))).toEqual([{ path: "/api/v1/admin/customers/co-harbor/trial", body: { days: 14, reason: "The owner's kick-off moved.", confirm: true } }]);
    expect(ui.toasts).toEqual([{ title: "Trial extended to December 4.", more: undefined }]);
  });
});

describe("Home and the dashboard's Companies page left open", () => {
  /** Draws the page with this look's failure on one of its sources, then runs what it does once drawn. */
  const comeBack = (page: (props: Record<string, never>) => unknown, key: unknown[], error: unknown) => {
    ui.fresh();
    ui.answers.set(JSON.stringify(key), { error });
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign, pathname: "/" } });
    ui.draw(page, {});
    for (const effect of ui.effects) effect();
    return assign.mock.calls;
  };
  const ended = new ApiError(401, "unauthorized", "Sign in to continue.");
  const others = [new ApiError(500, "error", "Something went wrong. It has been logged."), new ApiError(403, "mfa_required", "Confirm it's you."), new TypeError("Failed to fetch")];

  it("Home goes to sign in once a look answers 401: the session ended while the tab was hidden or asleep", () => {
    expect(comeBack(Home, ["home"], ended)).toEqual([["/login"]]);
    expect(comeBack(Home, ["me"], ended)).toEqual([["/login"]]);
    for (const other of others) expect(comeBack(Home, ["home"], other)).toEqual([]);
  });

  it("so does the Companies page, and it stays on any other failure, which says so on the page", () => {
    expect(comeBack(Companies, ["admin", "companies"], ended)).toEqual([["/login"]]);
    for (const other of others) expect(comeBack(Companies, ["admin", "companies"], other)).toEqual([]);
  });
});
