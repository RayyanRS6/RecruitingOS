import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MarkNotificationsRead } from "../../packages/contracts/src/index";
import { READ_BATCH, markReadLabel, markedWords, readBatches, updateFacts } from "../../apps/web/src/updates";

/**
 * The Updates page: every update a person had, newest first. "Mark all read" marks exactly the unread updates loaded
 * on the list, in requests the API takes; each row says when it came and whether it was also emailed.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("marking updates read", () => {
  it("names the button for what it marks: all of them, or only the ones loaded", () => {
    expect(markReadLabel(3, 3)).toBe("Mark all read");
    expect(markReadLabel(25, 60)).toBe("Mark these 25 read");
    expect(markReadLabel(5, 2)).toBe("Mark all read");
  });

  it("sends the ids in requests the API takes, 200 at a time", () => {
    expect(READ_BATCH).toBe(200);
    const ids = Array.from({ length: 450 }, (_, i) => `n${i}`);
    expect(readBatches(ids).map((b) => b.length)).toEqual([200, 200, 50]);
    for (const batch of readBatches(ids)) expect(MarkNotificationsRead.safeParse({ ids: batch }).success).toBe(true);
    expect(readBatches([])).toEqual([]);
  });

  it("says what was marked", () => {
    expect(markedWords(0)).toBe("Nothing was unread.");
    expect(markedWords(1)).toBe("Marked 1 update read.");
    expect(markedWords(12)).toBe("Marked 12 updates read.");
  });
});

describe("a row", () => {
  it("says when the update came in, and that it was also emailed when it was", () => {
    expect(updateFacts({ createdAt: "2026-11-18T17:14:00.000Z", emailedAt: null }, "UTC")).toBe("Nov 18, 5:14 PM");
    expect(updateFacts({ createdAt: "2026-11-18T17:14:00.000Z", emailedAt: "2026-11-18T17:14:05.000Z" }, "UTC")).toBe("Nov 18, 5:14 PM · also emailed to you");
  });
});

describe("the page", () => {
  it("is its own address, reached from the frame and from Settings' Email updates", () => {
    expect(existsSync(new URL("../../apps/shell/app/(app)/(company)/updates/page.tsx", import.meta.url))).toBe(true);
    expect(read("../../apps/shell/components/AppShell.tsx")).toContain("<NavLink to={appPaths.updates}");
    expect(read("../../apps/web/src/pages/settings/EmailSection.tsx")).toContain("<Link to={appPaths.updates}");
    // and it links back to the one switch that decides the emails
    expect(read("../../apps/web/src/pages/Updates.tsx")).toContain('<Link to="/setup#setup-notifications"');
  });

  it("pages back with the last update's id, marks read and unread, and never marks an update on a page not loaded yet", () => {
    const updates = read("../../apps/web/src/pages/Updates.tsx");
    expect(updates).toContain(`/api/v1/notifications/history?filter=\${filter}&limit=\${PAGE}\${pageParam ? \`&before=\${pageParam}\` : ""}`);
    expect(updates).toContain(`\`/api/v1/notifications/\${v.read ? "read" : "unread"}\``);
    expect(updates).toContain("Show earlier updates");
    expect(updates).toContain('for (const batch of readBatches(ids)) marked += (await api.post<NotificationsMarked>("/api/v1/notifications/read", { ids: batch })).marked;');
    expect(updates).not.toContain("/api/v1/notifications/read-all");
  });
});
