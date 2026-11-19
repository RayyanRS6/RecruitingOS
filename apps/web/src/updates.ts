import { dayAndTime } from "./dates";

/**
 * The Updates page (every update a person had at this company, newest first): the words that need no browser, kept
 * out of the page so tests/web/updates.test.ts can check them.
 */

/** How many updates one request to mark read may carry (the API's limit). */
export const READ_BATCH = 200;

/** The ids to mark read, cut into requests the API takes. */
export function readBatches(ids: readonly string[], size: number = READ_BATCH): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * The page marks read exactly the unread updates it has loaded, never one on a page not loaded yet or one that arrived
 * since; while there are unread ones further back, the button says how many it marks.
 */
export function markReadLabel(shownUnread: number, totalUnread: number): string {
  return shownUnread >= totalUnread ? "Mark all read" : `Mark these ${shownUnread} read`;
}

/** What is said once updates were marked read. */
export function markedWords(marked: number): string {
  if (!marked) return "Nothing was unread.";
  return `Marked ${marked} ${marked === 1 ? "update" : "updates"} read.`;
}

/** One update's small line: when it came in, and that it was also emailed when it was. */
export function updateFacts(n: { createdAt: string; emailedAt: string | null }, timeZone?: string): string {
  return [dayAndTime(n.createdAt, timeZone), ...(n.emailedAt ? ["also emailed to you"] : [])].filter(Boolean).join(" · ");
}
