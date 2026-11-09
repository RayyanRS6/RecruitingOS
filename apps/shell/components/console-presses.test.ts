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

const { AccessButtons, AccessChoice } = await import("@ros/web/src/pages/admin/customers");
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
/** A kit Button by its accessible name (its `ariaLabel`, or its words), and the words of every Button drawn. */
const named = (el: El) => (el.props.ariaLabel as string | undefined) ?? [el.props.children].flat().join("");
const buttons = (tree: unknown) => [...elements(tree)].filter((e) => e.type === Button);
const button = (tree: unknown, name: string) => {
  const b = buttons(tree).find((e) => named(e) === name);
  expect(b, name).toBeDefined();
  return b?.props as { onClick: () => void; disabled?: boolean; variant?: string };
};

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
