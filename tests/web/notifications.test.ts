import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOTIFY_CADENCES } from "../../packages/contracts/src/api/notifications";
import { CADENCE_OPTIONS, READ_BATCH, cadenceToast, digestTimeText, hourText, markReadLabel, zoneText } from "../../apps/web/src/notification-settings";

/**
 * Email alerts in Setup and the full history of updates (plan B3): the four choices in plain words, when summaries
 * arrive, what a change says it did, and the way from Today to every earlier update.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const home = read("../../apps/web/src/pages/Home.tsx");
const card = read("../../apps/web/src/pages/NotificationsCard.tsx");
const updates = read("../../apps/web/src/pages/Updates.tsx");

describe("the email alert choices", () => {
  it("offer every cadence the API takes, in plain words, in order", () => {
    expect(CADENCE_OPTIONS.map((o) => o.value)).toEqual([...NOTIFY_CADENCES]);
    expect(CADENCE_OPTIONS.map((o) => o.label)).toEqual(["As it happens", "Daily summary", "Weekly summary", "Off"]);
    for (const o of CADENCE_OPTIONS) expect(o.label).not.toMatch(/[_]/);
  });

  it("say when summaries arrive in the company's own time", () => {
    expect(hourText(8)).toBe("8:00 AM");
    expect(hourText(0)).toBe("12:00 AM");
    expect(hourText(12)).toBe("12:00 PM");
    expect(hourText(13)).toBe("1:00 PM");
    expect(zoneText("America/New_York")).toBe("New York time");
    expect(digestTimeText({ hour: 8, weekday: "Monday", timezone: "America/Los_Angeles" })).toMatch(/^Daily summaries arrive at 8:00 AM, Los Angeles time; weekly ones on Monday/);
  });

  it("say what a change did, and that the app still shows everything when emails are off", () => {
    const d = { hour: 8, weekday: "Monday", timezone: "America/Chicago" };
    expect(cadenceToast("Candidates", "immediate", d).title).toBe("Candidates: emailed as it happens.");
    expect(cadenceToast("Candidates", "daily", d).detail).toBe("It arrives at 8:00 AM, Chicago time.");
    expect(cadenceToast("Candidates", "weekly", d).detail).toBe("It arrives on Monday at 8:00 AM, Chicago time.");
    expect(cadenceToast("Candidates", "off", d)).toEqual({ title: "Candidates: no emails.", detail: "You still see these on Today and in your updates." });
  });
});

describe("the way to every earlier update", () => {
  it("leads from Today's updates, whether or not anything is unread", () => {
    expect(home.match(/<Link to="\/updates">See earlier updates<\/Link>/g)).toHaveLength(2);
  });

  it("is a page of its own that pages back with the last update's id and marks read and unread", () => {
    expect(existsSync(new URL("../../apps/shell/app/(app)/(company)/updates/page.tsx", import.meta.url))).toBe(true);
    expect(updates).toContain("/api/v1/notifications/history?filter=${filter}&limit=${PAGE}${pageParam ? `&before=${pageParam}` : \"\"}");
    expect(updates).toContain('`/api/v1/notifications/${v.read ? "read" : "unread"}`');
    expect(updates).toContain("Show earlier updates");
  });

  it("marks read exactly the unread updates on the list, never one on a page not loaded yet", () => {
    expect(updates).not.toContain("/api/v1/notifications/read-all");
    expect(updates).toContain('api.post<{ marked: number }>("/api/v1/notifications/read", { ids: ids.slice(i, i + READ_BATCH) })');
    expect(markReadLabel(3, 3)).toBe("Mark all read");
    expect(markReadLabel(25, 40)).toBe("Mark these 25 read");
    expect(READ_BATCH).toBe(200);
  });

  it("and Setup's email alerts card links there too, saving each person's own settings", () => {
    expect(card).toContain('<Link to="/updates"');
    expect(card).toContain('api.put<NotificationPreferencesView>("/api/v1/notifications/preferences"');
    expect(card).toContain("Always emailed at once");
  });
});
