"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { appPaths, type NotificationPreferences, type UpdateNotificationPreferences } from "@ros/contracts";
import { Card, ErrorState, Icon, Skeleton } from "@ros/ui";
import { api, errorWords } from "../../api/client";
import { Link } from "../../nav";
import { emailSwitchWords } from "../../settings";
import { toast } from "../../toast";

/**
 * Settings, Email updates: this person's one switch. On, every update is also emailed as it happens, to the address
 * shown; off, the updates stay in the app. The server's line says which notices are emailed either way.
 */
export function EmailSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["notifications", "preferences"], queryFn: () => api.get<NotificationPreferences>("/api/v1/notifications/preferences") });
  const save = useMutation({
    mutationFn: (emailUpdates: boolean) => api.put<NotificationPreferences>("/api/v1/notifications/preferences", { emailUpdates } satisfies UpdateNotificationPreferences),
    onSuccess: (prefs) => {
      qc.setQueryData(["notifications", "preferences"], prefs);
      const said = emailSwitchWords(prefs.emailUpdates);
      toast(said.title, said.detail);
    },
    onError: (e) => toast(errorWords(e, "Could not save.")),
  });
  const all = <Link to={appPaths.updates} className="text-link">All updates<Icon name="arrow-right" size={16} /></Link>;
  if (q.isLoading) return <Card title="Email updates"><Skeleton lines={2} /></Card>;
  if (q.error || !q.data) return <Card title="Email updates" aside={all}><ErrorState message="Could not load your email setting." onRetry={() => q.refetch()} /></Card>;
  const prefs = q.data;
  return (
    <Card title="Email updates" aside={all}>
      <div className="stack gap-3">
        <label className="check">
          <input type="checkbox" checked={prefs.emailUpdates} disabled={save.isPending} onChange={(e) => save.mutate(e.target.checked)} />
          <span>Email me updates<span className="block small muted wrap-anywhere">To {prefs.email}</span></span>
        </label>
        <p className="small muted">{prefs.alwaysEmailedLine}</p>
      </div>
    </Card>
  );
}
