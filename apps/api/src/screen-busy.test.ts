import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { SCREEN_BUSY_JS } from "./pages/candidate";

/**
 * The screening conversation's one script (SCREEN_BUSY_JS): a typed answer waits for the assistant inside the request,
 * so the first press locks the page ("Sending…", every button disabled) and a second press, from any form, is stopped.
 * The pages themselves (the nonce, the empty status line, nothing else scripted) are covered in apply-visit-pages.test.ts
 * and csp.test.ts; this runs the script against a small stand-in for the browser's document.
 */
type Handler = (ev: FakeEvent) => void;
type FakeEvent = { submitter?: FakeButton | null; persisted?: boolean; defaultPrevented: boolean; preventDefault(): void };

class FakeButton {
  disabled = false;
  textContent: string;
  private attrs = new Map<string, string>();
  constructor(label: string) {
    this.textContent = label;
  }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string) { return this.attrs.has(name); }
  removeAttribute(name: string) { this.attrs.delete(name); }
}

/** A conversation page in miniature: its buttons, the status line, and the document and window the script listens on. */
function pageWith(labels: string[], opts: { note?: boolean; preDisabled?: string[] } = {}) {
  const buttons = labels.map((l) => new FakeButton(l));
  for (const b of buttons) if (opts.preDisabled?.includes(b.textContent)) b.disabled = true;
  const note = opts.note === false ? null : { textContent: "" };
  const on: Record<string, Handler[]> = {};
  const timers: Array<() => void> = [];
  const listen = (type: string, fn: Handler) => { on[type] = [...(on[type] ?? []), fn]; };
  const doc = {
    addEventListener: listen,
    getElementById: (id: string) => (id === "sending" ? note : null),
    querySelectorAll: (selector: string) => {
      if (selector === "main button") return buttons;
      if (selector === "main button[data-busy]") return buttons.filter((b) => b.hasAttribute("data-busy"));
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  const win = { addEventListener: listen, setTimeout: (fn: () => void) => { timers.push(fn); } };
  runInNewContext(SCREEN_BUSY_JS, { document: doc, window: win });
  const fire = (type: string, init: Partial<FakeEvent> = {}): FakeEvent => {
    const ev: FakeEvent = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    for (const fn of on[type] ?? []) fn(ev);
    return ev;
  };
  return {
    buttons,
    note,
    /** A press of `label`: the submit event the browser fires before it builds what the form sends. */
    press: (label: string) => fire("submit", { submitter: buttons.find((b) => b.textContent === label) ?? null }),
    /** What the browser does once the submit event is over: queued work runs, the request is already on its way. */
    afterSubmit: () => { for (const fn of timers.splice(0)) fn(); },
    back: (persisted: boolean) => fire("pageshow", { persisted }),
  };
}

describe("the screening conversation: one press at a time", () => {
  it("the first press goes through untouched, then every button is disabled and the pressed one says Sending…", () => {
    const page = pageWith(["Yes", "No", "Skip this question", "Send", "Finish later: email me the link"]);
    const first = page.press("No");
    expect(first.defaultPrevented).toBe(false);
    // While the browser builds what the form sends, the pressed button is still enabled, so "choice=no" is sent with it.
    expect(page.buttons.every((b) => !b.disabled)).toBe(true);
    expect(page.buttons[1].textContent).toBe("No");
    page.afterSubmit();
    expect(page.buttons.every((b) => b.disabled)).toBe(true);
    expect(page.buttons.map((b) => b.textContent)).toEqual(["Yes", "Sending…", "Skip this question", "Send", "Finish later: email me the link"]);
    expect(page.note?.textContent).toBe("Sending… This can take up to a minute, so please keep this page open.");
  });

  it("a second press, from the same form or another one, is stopped, even before the buttons are disabled", () => {
    const page = pageWith(["Send", "Skip this question", "Finish later: email me the link"]);
    expect(page.press("Send").defaultPrevented).toBe(false);
    // a double click lands before the buttons are disabled
    expect(page.press("Send").defaultPrevented).toBe(true);
    page.afterSubmit();
    expect(page.press("Skip this question").defaultPrevented).toBe(true);
    expect(page.press("Finish later: email me the link").defaultPrevented).toBe(true);
    // the pressed button keeps saying Sending…, the others their own words
    expect(page.buttons.map((b) => b.textContent)).toEqual(["Sending…", "Skip this question", "Finish later: email me the link"]);
  });

  it("coming back with the Back button unlocks the page as it was; a fresh load changes nothing", () => {
    const page = pageWith(["Start", "Do this later", "Already off"], { preDisabled: ["Already off"] });
    page.press("Start");
    page.afterSubmit();
    expect(page.buttons.map((b) => [b.textContent, b.disabled])).toEqual([["Sending…", true], ["Do this later", true], ["Already off", true]]);
    page.back(false);
    expect(page.buttons[0].disabled).toBe(true);
    page.back(true);
    expect(page.buttons.map((b) => [b.textContent, b.disabled])).toEqual([["Start", false], ["Do this later", false], ["Already off", true]]);
    expect(page.buttons.some((b) => b.hasAttribute("data-busy") || b.hasAttribute("data-label"))).toBe(false);
    expect(page.note?.textContent).toBe("");
    // and it can be pressed again
    expect(page.press("Do this later").defaultPrevented).toBe(false);
    page.afterSubmit();
    expect(page.buttons[1].textContent).toBe("Sending…");
  });

  it("a submit something else stopped leaves the page free; a browser that does not say which button was pressed still gets the lock", () => {
    const page = pageWith(["Send", "Skip this question"]);
    const stopped = page.press("Send");
    stopped.preventDefault();
    page.afterSubmit();
    expect(page.buttons.every((b) => !b.disabled && b.textContent !== "Sending…")).toBe(true);
    expect(page.press("Send").defaultPrevented).toBe(false);

    const old = pageWith(["Send", "Skip this question"], { note: false });
    expect(old.press("nothing reported").defaultPrevented).toBe(false);
    old.afterSubmit();
    expect(old.buttons.every((b) => b.disabled)).toBe(true);
    expect(old.buttons.map((b) => b.textContent)).toEqual(["Send", "Skip this question"]);
    expect(old.press("Send").defaultPrevented).toBe(true);
  });

  it("is plain ES5 with no inline handler and nothing that leaves the page", () => {
    expect(SCREEN_BUSY_JS).not.toMatch(/=>|\blet\b|\bconst\b|`|fetch|XMLHttpRequest|sendBeacon|innerHTML|\bon[a-z]+=/);
    expect(SCREEN_BUSY_JS).not.toContain("</script");
  });
});
