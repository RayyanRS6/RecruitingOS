"use client";

import { useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Card, EmptyState, ErrorState, PageHeader, Pill, Segmented, Skeleton } from "@ros/ui";
import { api, ApiError, type NotificationHistoryPage, type NotificationView } from "../api/client";
import { Link } from "../nav";
import { READ_BATCH, markReadLabel, updateTime } from "../notification-settings";
import { toast } from "../toast";

/** How many updates one page brings; "Show earlier updates" brings the next. */
const PAGE = 25;

type Filter = "all" | "unread";

/**
 * Every update this person ever had at this company, newest first (plan B3): Home's "Recent activity" shows only the
 * newest unread ones, and "See earlier updates" leads here. Each can be marked read or unread again;
 * "Mark all read" marks exactly the unread updates loaded on the list, never one on a page not loaded yet or one that
 * arrived since (while some are further back, the button says how many it marks).
 */
export function Updates() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const q = useInfiniteQuery({
    queryKey: ["notifications", "history", filter],
    queryFn: ({ pageParam }) => api.get<NotificationHistoryPage>(`/api/v1/notifications/history?filter=${filter}&limit=${PAGE}${pageParam ? `&before=${pageParam}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["notifications"] });
  const mark = useMutation({
    mutationFn: (v: { id: string; read: boolean }) => api.post<{ marked: number }>(`/api/v1/notifications/${v.read ? "read" : "unread"}`, { ids: [v.id] }),
    onSuccess: refresh,
    onError: (e) => toast(e instanceof ApiError ? e.message : "That didn't work. Try again."),
  });
  const pages = q.data?.pages ?? [];
  const items = pages.flatMap((p) => p.items);
  const unread = pages[0]?.unreadCount ?? 0;
  const shownUnread = items.filter((n) => !n.readAt).map((n) => n.id);
  const readShown = useMutation({
    mutationFn: async (ids: string[]) => {
      let marked = 0;
      for (let i = 0; i < ids.length; i += READ_BATCH) marked += (await api.post<{ marked: number }>("/api/v1/notifications/read", { ids: ids.slice(i, i + READ_BATCH) })).marked;
      return { marked };
    },
    onSuccess: (r) => { toast(r.marked ? `Marked ${r.marked} ${r.marked === 1 ? "update" : "updates"} read.` : "Nothing was unread."); refresh(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "That didn't work. Try again."),
  });

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader
        eyebrow={<Link to="/">Home</Link>}
        title="Updates"
        sub="Everything the assistant told you, newest first."
        actions={<Link to="/setup#setup-notifications" className="btn secondary">Email alerts</Link>}
      />
      <Card>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <Segmented ariaLabel="Which updates to show" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "unread", label: `Unread (${unread})` }]} />
          {shownUnread.length ? <Button size="sm" variant="secondary" loading={readShown.isPending} onClick={() => readShown.mutate(shownUnread)}>{markReadLabel(shownUnread.length, unread)}</Button> : null}
        </div>
        {q.isLoading ? <div style={{ marginTop: 12 }}><Skeleton lines={5} /></div> : q.error ? (
          <div style={{ marginTop: 12 }}><ErrorState message="Could not load your updates." onRetry={() => q.refetch()} /></div>
        ) : !items.length ? (
          filter === "unread"
            ? <EmptyState icon="check-circle" title="Nothing unread" body="You have seen every update. The earlier ones are under All." />
            : <EmptyState title="No updates yet" body="When the assistant does something for you, or something needs you, it shows here." />
        ) : (
          <ul aria-label="Updates" style={{ listStyle: "none", margin: "12px 0 0", padding: 0 }}>
            {items.map((n) => <UpdateRow key={n.id} n={n} busy={mark.isPending && mark.variables?.id === n.id} onMark={(read) => mark.mutate({ id: n.id, read })} />)}
          </ul>
        )}
        {q.hasNextPage ? (
          <div className="row" style={{ justifyContent: "center", marginTop: 12 }}>
            <Button size="sm" variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Show earlier updates</Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function UpdateRow({ n, busy, onMark }: { n: NotificationView; busy: boolean; onMark: (read: boolean) => void }) {
  const isNew = !n.readAt;
  return (
    <li style={{ display: "flex", gap: 10, alignItems: "flex-start", borderTop: "1px solid var(--line)", padding: "10px 0" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <strong className="small" style={{ overflowWrap: "anywhere", color: isNew ? "var(--ink)" : "var(--ink-2)" }}>{n.title}</strong>
          {isNew ? <Pill size="sm" tone="accent">Unread</Pill> : null}
        </div>
        <p className="small" style={{ margin: "2px 0 0", color: "var(--ink-2)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{n.body}</p>
        <p className="small muted" style={{ margin: "4px 0 0" }}>
          {updateTime(n.createdAt)} · {n.groupLabel}{n.emailedAt ? " · also emailed to you" : ""}
          {n.action ? <> · <Link to={n.action.href}>{n.action.label}</Link></> : null}
        </p>
      </div>
      <Button size="sm" variant="quiet" loading={busy} onClick={() => onMark(isNew)} ariaLabel={`${isNew ? "Mark read" : "Mark unread"}: ${n.title}`}>{isNew ? "Mark read" : "Mark unread"}</Button>
    </li>
  );
}
