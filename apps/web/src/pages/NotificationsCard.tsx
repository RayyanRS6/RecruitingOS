"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Card, ErrorState, Segmented, Skeleton } from "@ros/ui";
import { api, ApiError, type NotificationPreferencesView, type NotifyCadence, type NotifyGroup } from "../api/client";
import { Link } from "../nav";
import { CADENCE_OPTIONS, cadenceToast, digestTimeText } from "../notification-settings";
import { toast } from "../toast";

const KEY = ["notification-preferences"];

/**
 * Setup's "Email alerts" section (plan B3): each group of updates with how often it reaches this person by email (as it
 * happens, in the morning summary, in Monday's summary, or not at all), saved on click, and the few updates that are
 * always emailed. Everyone sets only their own; the app shows every update whatever is chosen here.
 */
export function NotificationsCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<NotificationPreferencesView>("/api/v1/notifications/preferences"), retry: false });
  const save = useMutation({
    mutationFn: (p: { group: NotifyGroup; cadence: NotifyCadence }) => api.put<NotificationPreferencesView>("/api/v1/notifications/preferences", { preferences: [p] }),
    onSuccess: (view, p) => {
      qc.setQueryData(KEY, view);
      const g = view.groups.find((x) => x.group === p.group);
      const t = cadenceToast(g?.label ?? "Saved", p.cadence, view.digest);
      toast(t.title, t.detail);
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save. Try again."),
  });
  // "Go back to the usual settings": every group to the product's default, in one save.
  const resetAll = useMutation({
    mutationFn: (view: NotificationPreferencesView) => api.put<NotificationPreferencesView>("/api/v1/notifications/preferences", { preferences: view.groups.map((g) => ({ group: g.group, cadence: g.defaultCadence })) }),
    onSuccess: (view) => { qc.setQueryData(KEY, view); toast("Back to the usual email alerts.", "What waits on you comes as it happens; the rest comes in the morning summary."); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save. Try again."),
  });
  const notMember = q.error instanceof ApiError && q.error.status === 403;
  const view = q.data;
  // Screenshot 6's team table: one inset box of rows, what the emails are about on the left and how often on the right.
  // The card's title and the choices say what it is for (founder, 23 October 2026: fewer words). The address the emails
  // go to and what each group covers wait under "How this works", where every keyboard, touch and screen reader user
  // reaches them; a group's label also carries its description as a tooltip, a second aid only.
  return (
    <Card title="Email alerts" aside={<Link to="/updates" className="btn secondary sm">See all your updates</Link>}>
      {q.isLoading ? <Skeleton lines={4} /> : notMember ? (
        <p className="small muted">Email alerts are for the people on this company's team.</p>
      ) : q.error || !view ? <ErrorState message="Could not load your email alerts." onRetry={() => q.refetch()} /> : (
        <>
          <div className="divide-y divide-line rounded-xl border border-line bg-surface">
            {view.groups.map((g, i) => (
              <div key={g.group} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3.5 motion-safe:animate-enter motion-safe:[animation-fill-mode:backwards]" style={i ? { animationDelay: `${Math.min(i, 7) * 30}ms` } : undefined}>
                <strong className="min-w-0 flex-[1_1_220px] text-sm text-ink" title={g.description}>{g.label}</strong>
                <Segmented ariaLabel={`Emails about ${g.label}`} value={save.isPending && save.variables?.group === g.group ? save.variables.cadence : g.cadence} options={CADENCE_OPTIONS} onChange={(cadence) => { if (cadence !== g.cadence) save.mutate({ group: g.group, cadence }); }} />
              </div>
            ))}
          </div>
          {view.groups.some((g) => g.cadence !== g.defaultCadence) ? (
            <div className="row mt-3 justify-end">
              <Button size="sm" variant="quiet" loading={resetAll.isPending} onClick={() => resetAll.mutate(view)}>Go back to the usual settings</Button>
            </div>
          ) : null}
          {/* The few updates that always go, and how summaries work: one click away. */}
          <details className="more mt-4">
            <summary>Always emailed at once ({view.alwaysSent.length})</summary>
            <ul className="small list-disc space-y-1 pl-5 marker:text-ink-3">
              {view.alwaysSent.map((a) => <li key={a.label}><strong>{a.label}.</strong> {a.why}</li>)}
            </ul>
          </details>
          <details className="more mt-2">
            <summary>How this works</summary>
            <div className="stack small muted gap-1.5">
              <p>Every update shows on Home and in your updates. Emails name the job and link to it; candidate names and details stay in the app.</p>
              <p>{`Emails go to ${view.email}.`}</p>
              <p>{digestTimeText(view.digest)}</p>
              <ul className="list-disc space-y-1 pl-5 marker:text-ink-3">
                {view.groups.map((g) => <li key={g.group}><strong>{`${g.label}:`}</strong> {g.description}</li>)}
              </ul>
            </div>
          </details>
        </>
      )}
    </Card>
  );
}
