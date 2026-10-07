/**
 * "Start a hire" from anywhere (Wave DS, plan item C4's shell button): where it goes and its one-key shortcut. The
 * rail's button, the Roles page and the shortcut all use these, so the address changes in one place.
 */

/**
 * Where "Start a hire" goes. Today opens the new-role conversation on `?start=1` (or the draft already in progress)
 * until the job builder has a page of its own; Wave C switches this to "/roles/new". The API's empty Today card points
 * at the same address (START_HIRE_PATH in apps/api/src/services/brief.ts); tests/web/start-hire.test.ts keeps them equal.
 */
export const START_HIRE_HREF = "/?start=1";

/** The key that opens it, shown as a hint on the button and announced through aria-keyshortcuts. */
export const START_HIRE_KEY = "N";

/**
 * A one-letter shortcut can be set off by speech input or a stray key, so a person can turn it off (WCAG 2.1.4). The
 * choice is kept in this browser only, under this key; Setup has the switch.
 */
export const SHORTCUT_STORAGE_KEY = "ros:shortcut:start-hire";

/** Sent on the window when the switch changes, so the rail's hint follows without a reload. */
export const SHORTCUT_CHANGED_EVENT = "ros:shortcut-changed";

type KeyLike = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; repeat?: boolean; defaultPrevented?: boolean };
type TargetLike = { tagName?: string; isContentEditable?: boolean; type?: string; closest?: (selector: string) => unknown } | null | undefined;

/** Input types that take no typing: a key pressed on one of these is not text. */
const NOT_TYPING = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

/** True when a key pressed here would be typing: a text field, a text box, a dropdown, or anything editable. */
export function isTextEntry(target: TargetLike): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NOT_TYPING.has((target.type ?? "text").toLowerCase());
  return !!target.closest?.('[role="textbox"], [role="combobox"], [role="searchbox"], [contenteditable="true"]');
}

/**
 * True for a control a person changes by typing, ticking or choosing (a field, a tick box, a dropdown, anything
 * editable). The shell watches changes made in these: once something on a page was changed, it may not be saved yet.
 */
export function isFormControl(target: TargetLike): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Whether a key press should open Start a hire: N on its own (either case), not held down, not already handled by the
 * page, not typed into a field, not while a dialog or a menu is open (the key belongs to what is on top then), and not
 * on a page where something was typed, ticked or chosen (`unsavedWork`): leaving would throw that away unasked. The
 * button still works there.
 */
export function isStartHireShortcut(e: KeyLike, target: TargetLike, page: { modalOpen: boolean; unsavedWork?: boolean }): boolean {
  if (e.key !== START_HIRE_KEY && e.key !== START_HIRE_KEY.toLowerCase()) return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented) return false;
  if (page.modalOpen || page.unsavedWork || isTextEntry(target)) return false;
  return !target?.closest?.('[role="dialog"], [role="menu"], [role="listbox"]');
}

/** Whether the shortcut is on in this browser: on unless the person turned it off. Storage that cannot be read counts as on. */
export function startHireShortcutOn(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  try {
    return storage?.getItem(SHORTCUT_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Turns the shortcut on or off in this browser. False when the browser would not keep the choice (private windows, blocked storage). */
export function setStartHireShortcut(storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined, on: boolean): boolean {
  if (!storage) return false;
  try {
    if (on) storage.removeItem(SHORTCUT_STORAGE_KEY);
    else storage.setItem(SHORTCUT_STORAGE_KEY, "off");
    return true;
  } catch {
    return false;
  }
}

/** The page's local storage, or null where reading it throws (blocked site data, some private windows). */
export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
