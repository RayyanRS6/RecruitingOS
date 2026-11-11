import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Notes from a call about someone locked, which the API keeps on the recruiter's own note (the check of 9 November 2026, C1).
 * The card is drawn as the server first draws it and "Add the notes" is pressed through its own handler, with a real query
 * cache; the Notes tab is then drawn from that same cache, as it is when the recruiter goes back to it.
 */
const presses = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@ros/ui", async (importOriginal) => {
  const kit = await importOriginal<typeof import("@ros/ui")>();
  const { createElement: draw } = await import("react");
  // The kit's own Button, drawn as it is; its press is kept by its words, so the test can press it.
  const Button = (props: Parameters<typeof kit.Button>[0]) => {
    if (typeof props.children === "string" && props.onClick) presses.set(props.children, props.onClick);
    return draw(kit.Button, props);
  };
  return { ...kit, Button };
});

(globalThis as { React?: typeof React }).React = React;
const { CallNotesCard } = await import("@ros/web/src/pages/candidate-panel/call-notes");
const { NotesTab, notesKey } = await import("@ros/web/src/pages/candidate-panel/notes");

const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const sam = { id: "a9", roleId: "r1", stage: "received", lockedAt: "2026-11-06T10:00:00.000Z", allowedActions: ["reject"], blockedReasons: {}, screens: [], communications: [], packetLabels: { mustHaves: [], competencies: [], questions: [{ key: "q1", question: "Can you work Saturdays?" }], written: [] }, candidate: { firstName: "Sam", lastName: "Lockwood", email: "sam@people.test" } } as never;
const myNote = (body: string) => ({ id: "n1", applicationId: "a9", author: { userId: "s2", name: "Rae Recruiter" }, mine: true, starter: null, starterLabel: null, body, createdAt: "2026-11-09T09:00:00.000Z", updatedAt: "2026-11-09T09:05:00.000Z", edited: false });
const notesOf = (body: string) => ({ notes: [myNote(body)], mine: myNote(body), canRead: "all", canWrite: true, writeBlockedReason: null, starters: [], privacy: "Only your team reads these notes. The candidate never does." });
const sent: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  presses.clear();
  sent.length = 0;
});

describe("call notes kept on the recruiter's own note", () => {
  it("the Notes tab's earlier read goes, so the tab opens on the note as it now stands and its next save cannot write over them", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Rae wrote on the Notes tab, then went to the AI interview tab: the tab's read stays in the cache, with nothing drawing it.
    qc.setQueryData(notesKey("a9"), notesOf("Sounds organised."));
    // someone else's notes are not touched
    qc.setQueryData(notesKey("a8"), notesOf("About someone else."));
    render(qc, createElement(CallNotesCard, { a: sam, roleId: "r1", prominent: true }));
    vi.stubGlobal("fetch", async (path: string) => {
      sent.push(path);
      return new Response(JSON.stringify({ ok: true, screenId: null, completed: false, keptAsNote: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    presses.get("Add the notes")?.();
    await vi.waitFor(() => expect(qc.getMutationCache().getAll()[0]?.state.status).toBe("success"));
    expect(sent).toEqual(["/api/v1/applications/a9/screen/recruiter-notes"]);

    // The old words are gone from the cache, not only marked stale.
    expect(qc.getQueryData(notesKey("a9"))).toBeUndefined();
    expect(qc.getQueryData(notesKey("a8"))).toEqual(notesOf("About someone else."));
    // Back on the Notes tab, the box does not open on the words from before the call: the tab waits for the note as it is now.
    const tab = () => render(qc, createElement(NotesTab, { applicationId: "a9", firstName: "Sam" }));
    expect(tab()).not.toContain("Sounds organised.");
    expect(tab()).not.toContain('id="my-note-a9"');
    // Once read, the box holds the note with the call notes after the earlier words, so its next save keeps them.
    qc.setQueryData(notesKey("a9"), notesOf("Sounds organised.\n\nNotes from a call, 2026-11-09:\nCan you work Saturdays?\nYes, mornings."));
    expect(tab()).toMatch(/<textarea id="my-note-a9"[^>]*>Sounds organised\.\n\nNotes from a call, 2026-11-09:\nCan you work Saturdays\?\nYes, mornings\.<\/textarea>/);
  });

  it("notes that went on the AI interview leave the Notes tab's read as it was", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(notesKey("a9"), notesOf("Sounds organised."));
    render(qc, createElement(CallNotesCard, { a: { ...(sam as object), lockedAt: null } as never, roleId: "r1", prominent: true }));
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, screenId: "s1", completed: true }), { status: 200, headers: { "content-type": "application/json" } }));
    presses.get("Add the notes")?.();
    await vi.waitFor(() => expect(qc.getMutationCache().getAll()[0]?.state.status).toBe("success"));
    expect(qc.getQueryData(notesKey("a9"))).toEqual(notesOf("Sounds organised."));
  });
});
