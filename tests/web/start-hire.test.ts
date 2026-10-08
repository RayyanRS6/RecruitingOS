import { describe, expect, it } from "vitest";
import { START_HIRE_PATH } from "../../apps/api/src/services/brief";
import { can } from "../../packages/core/src/permissions";
import { canStartHire } from "../../apps/web/src/roles";
import { isFormControl, isStartHireShortcut, isTextEntry, SHORTCUT_STORAGE_KEY, START_HIRE_HREF, setStartHireShortcut, startHireShortcutOn } from "../../apps/web/src/start-hire";

/**
 * "Start a hire" in the rail on every page (Wave DS): one address for the button, the Roles page and the empty Today
 * card, shown only to the roles that may start one, and an N shortcut that never fires while someone is typing, never
 * over a dialog, and can be turned off (WCAG 2.1.4).
 */
const key = (k: string, extra: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; repeat: boolean; defaultPrevented: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...extra });
const el = (tagName: string, extra: { type?: string; isContentEditable?: boolean; inside?: string[] } = {}) => ({
  tagName,
  type: extra.type,
  isContentEditable: extra.isContentEditable ?? false,
  closest: (selector: string) => (extra.inside ?? []).some((role) => selector.includes(`"${role}"`)) || null,
});
const page = { modalOpen: false };

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

describe("where Start a hire goes", () => {
  it("is the job builder's own page, the same address as the API's empty Today card and its draft card", () => {
    expect(START_HIRE_HREF).toBe(START_HIRE_PATH);
    expect(START_HIRE_HREF).toBe("/roles/new");
  });

  it("is offered exactly to the roles the API lets start a hire", () => {
    for (const role of ["owner", "admin", "hiring_manager", "hr", "interviewer", "recruiter"] as const) expect(canStartHire(role), role).toBe(can(role, "role.create"));
    expect(canStartHire("interviewer")).toBe(false);
    expect(canStartHire("hr")).toBe(false);
    expect(canStartHire(null)).toBe(false);
  });
});

describe("the N shortcut", () => {
  it("opens Start a hire on N alone, in either case, from anywhere that is not a text field", () => {
    expect(isStartHireShortcut(key("n"), el("BODY"), page)).toBe(true);
    expect(isStartHireShortcut(key("N"), el("BUTTON"), page)).toBe(true);
    expect(isStartHireShortcut(key("n"), el("A"), page)).toBe(true);
    expect(isStartHireShortcut(key("n"), el("INPUT", { type: "checkbox" }), page)).toBe(true);
    expect(isStartHireShortcut(key("n"), null, page)).toBe(true);
  });

  it("never fires while someone types, with a modifier, on a held key, or when the page already used the key", () => {
    expect(isStartHireShortcut(key("n"), el("INPUT"), page)).toBe(false);
    expect(isStartHireShortcut(key("n"), el("INPUT", { type: "email" }), page)).toBe(false);
    expect(isStartHireShortcut(key("n"), el("TEXTAREA"), page)).toBe(false);
    expect(isStartHireShortcut(key("n"), el("SELECT"), page)).toBe(false);
    expect(isStartHireShortcut(key("n"), el("DIV", { isContentEditable: true }), page)).toBe(false);
    expect(isStartHireShortcut(key("n"), el("DIV", { inside: ["textbox"] }), page)).toBe(false);
    expect(isStartHireShortcut(key("n", { ctrlKey: true }), el("BODY"), page)).toBe(false);
    expect(isStartHireShortcut(key("n", { metaKey: true }), el("BODY"), page)).toBe(false);
    expect(isStartHireShortcut(key("n", { altKey: true }), el("BODY"), page)).toBe(false);
    expect(isStartHireShortcut(key("n", { repeat: true }), el("BODY"), page)).toBe(false);
    expect(isStartHireShortcut(key("n", { defaultPrevented: true }), el("BODY"), page)).toBe(false);
    expect(isStartHireShortcut(key("m"), el("BODY"), page)).toBe(false);
    expect(isStartHireShortcut(key("Enter"), el("BODY"), page)).toBe(false);
  });

  it("leaves the key to a dialog, a drawer or a menu that is open", () => {
    expect(isStartHireShortcut(key("n"), el("BODY"), { modalOpen: true })).toBe(false);
    expect(isStartHireShortcut(key("n"), el("BUTTON", { inside: ["dialog"] }), page)).toBe(false);
    expect(isStartHireShortcut(key("n"), el("BUTTON", { inside: ["menu"] }), page)).toBe(false);
  });

  it("does nothing on a page where something was typed, ticked or chosen, so a stray key never throws work away", () => {
    // focus on a tick box after ticking interviewers on the Interview plan tab, or on a button after editing a card
    expect(isStartHireShortcut(key("n"), el("INPUT", { type: "checkbox" }), { modalOpen: false, unsavedWork: true })).toBe(false);
    expect(isStartHireShortcut(key("n"), el("BUTTON"), { modalOpen: false, unsavedWork: true })).toBe(false);
    expect(isStartHireShortcut(key("n"), el("BUTTON"), { modalOpen: false, unsavedWork: false })).toBe(true);
  });

  it("knows a text field from a control, and a control a person changes from one they only press", () => {
    expect(isTextEntry(el("INPUT", { type: "search" }))).toBe(true);
    expect(isTextEntry(el("INPUT", { type: "radio" }))).toBe(false);
    expect(isTextEntry(el("BUTTON"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
    for (const t of [el("INPUT", { type: "checkbox" }), el("INPUT"), el("TEXTAREA"), el("SELECT"), el("DIV", { isContentEditable: true })]) expect(isFormControl(t), t.tagName).toBe(true);
    for (const t of [el("BUTTON"), el("A"), el("DIV"), null]) expect(isFormControl(t)).toBe(false);
  });

  it("is on until the person turns it off in this browser, and storage that fails counts as on", () => {
    const s = memoryStorage();
    expect(startHireShortcutOn(s)).toBe(true);
    expect(setStartHireShortcut(s, false)).toBe(true);
    expect(s.m.get(SHORTCUT_STORAGE_KEY)).toBe("off");
    expect(startHireShortcutOn(s)).toBe(false);
    expect(setStartHireShortcut(s, true)).toBe(true);
    expect(s.m.has(SHORTCUT_STORAGE_KEY)).toBe(false);
    expect(startHireShortcutOn(s)).toBe(true);
    expect(startHireShortcutOn(null)).toBe(true);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(startHireShortcutOn(broken)).toBe(true);
    expect(setStartHireShortcut(broken, false)).toBe(false);
    expect(setStartHireShortcut(null, false)).toBe(false);
  });
});
