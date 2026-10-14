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
  return (
    <Card title="Email alerts" aside={<Link to="/updates" className="btn secondary sm">See all your updates</Link>}>
      <p className="small muted">Choose which updates also reach you by email{view?.email ? ` at ${view.email}` : ""}.</p>
      {q.isLoading ? <Skeleton lines={4} /> : notMember ? (
        <p className="small muted" style={{ marginTop: 8 }}>Email alerts are for the people on this company's team.</p>
      ) : q.error || !view ? <ErrorState message="Could not load your email alerts." onRetry={() => q.refetch()} /> : (
        <>
          <div className="stack" style={{ gap: 0, marginTop: 8 }}>
            {view.groups.map((g) => (
              <div key={g.group} className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, padding: "10px 0", borderTop: "1px solid var(--line)" }}>
                <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <strong className="small">{g.label}</strong>
                  <p className="small muted" style={{ margin: "2px 0 0" }}>{g.description}</p>
                </div>
                <Segmented ariaLabel={`Emails about ${g.label}`} value={save.isPending && save.variables?.group === g.group ? save.variables.cadence : g.cadence} options={CADENCE_OPTIONS} onChange={(cadence) => { if (cadence !== g.cadence) save.mutate({ group: g.group, cadence }); }} />
              </div>
            ))}
          </div>
          {view.groups.some((g) => g.cadence !== g.defaultCadence) ? (
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
              <Button size="sm" variant="quiet" loading={resetAll.isPending} onClick={() => resetAll.mutate(view)}>Go back to the usual settings</Button>
            </div>
          ) : null}
          {/* The few updates that always go, and how summaries work: one click away. */}
          <details className="more" style={{ marginTop: 10 }}>
            <summary>Always emailed at once ({view.alwaysSent.length})</summary>
            <p className="small muted" style={{ margin: "0 0 6px" }}>These go out whatever you choose above.</p>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {view.alwaysSent.map((a) => <li key={a.label} style={{ marginBottom: 4 }}><strong>{a.label}.</strong> {a.why}</li>)}
            </ul>
          </details>
          <details className="more" style={{ marginTop: 6 }}>
            <summary>How this works</summary>
            <div className="stack small muted" style={{ gap: 6 }}>
              <p style={{ margin: 0 }}>Every update shows on Home and in your updates. Emails name the job and link to it; candidate names and details stay in the app.</p>
              <p style={{ margin: 0 }}>{digestTimeText(view.digest)}</p>
            </div>
          </details>
        </>
      )}
    </Card>
  );
}
