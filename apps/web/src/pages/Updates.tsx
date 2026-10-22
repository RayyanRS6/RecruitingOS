"use client";

import { type CSSProperties, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Card, cn, EmptyState, ErrorState, IconChip, PageHeader, Pill, Segmented, Skeleton } from "@ros/ui";
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

  // Screenshot 4's look: the header, a bar with the filter pills and the bulk action, then one bordered list of rows.
  return (
    <div className="stack gap-5">
      <PageHeader
        eyebrow={<Link to="/" className="font-normal text-ink-2 underline decoration-line-strong underline-offset-2 transition-colors ease-soft hover:text-primary pointer-coarse:inline-flex pointer-coarse:min-h-10 pointer-coarse:items-center">Home</Link>}
        title="Updates"
        sub="Everything the assistant told you, newest first."
        actions={<Link to="/setup#setup-notifications" className="btn secondary">Email alerts</Link>}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented ariaLabel="Which updates to show" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "unread", label: `Unread (${unread})` }]} />
        {shownUnread.length ? <Button size="sm" variant="secondary" loading={readShown.isPending} onClick={() => readShown.mutate(shownUnread)}>{markReadLabel(shownUnread.length, unread)}</Button> : null}
      </div>
      {q.isLoading ? <Card><Skeleton lines={5} /></Card> : q.error ? (
        <ErrorState message="Could not load your updates." onRetry={() => q.refetch()} />
      ) : !items.length ? (
        filter === "unread"
          ? <EmptyState icon="check-circle" title="Nothing unread" body="You have seen every update. The earlier ones are under All." />
          : <EmptyState title="No updates yet" body="When the assistant does something for you, or something needs you, it shows here." />
      ) : (
        <ul aria-label="Updates" className="list-card">
          {items.map((n, i) => <UpdateRow key={n.id} n={n} order={i} busy={mark.isPending && mark.variables?.id === n.id} onMark={(read) => mark.mutate({ id: n.id, read })} />)}
        </ul>
      )}
      {q.hasNextPage ? (
        <div className="row justify-center">
          <Button size="sm" variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Show earlier updates</Button>
        </div>
      ) : null}
    </div>
  );
}

/** One update: a mark for read or not, the title and its word, the message, when and what kind, and its own button. */
function UpdateRow({ n, order, busy, onMark }: { n: NotificationView; order: number; busy: boolean; onMark: (read: boolean) => void }) {
  const isNew = !n.readAt;
  // a list's first appearance (spec 4): 30ms a row, the ninth and later with the eighth
  const delay: CSSProperties | undefined = order % PAGE ? { animationDelay: `${Math.min(order % PAGE, 7) * 30}ms` } : undefined;
  return (
    <li className="list-row items-start motion-safe:animate-enter motion-safe:[animation-fill-mode:backwards]" style={delay}>
      <IconChip icon={isNew ? "inbox" : "check"} size="sm" tone={isNew ? "lavender" : "neutral"} />
      <div className="list-row-main gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <strong className={cn("text-[14.5px] [overflow-wrap:anywhere]", isNew ? "text-ink" : "text-ink-2")}>{n.title}</strong>
          {isNew ? <Pill size="sm" tone="accent">Unread</Pill> : null}
        </div>
        <p className="small whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{n.body}</p>
        <p className="small muted">
          {updateTime(n.createdAt)} · {n.groupLabel}{n.emailedAt ? " · also emailed to you" : ""}
          {n.action ? <> · <Link to={n.action.href}>{n.action.label}</Link></> : null}
        </p>
      </div>
      <div className="list-row-end">
        <Button size="sm" variant="quiet" loading={busy} onClick={() => onMark(isNew)} ariaLabel={`${isNew ? "Mark read" : "Mark unread"}: ${n.title}`}>{isNew ? "Mark read" : "Mark unread"}</Button>
      </div>
    </li>
  );
}
