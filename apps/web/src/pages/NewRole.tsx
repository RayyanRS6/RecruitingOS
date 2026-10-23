"use client";

import { useQuery } from "@tanstack/react-query";
import { EmptyState, Skeleton } from "@ros/ui";
import { api, type Me } from "../api/client";
import { useSearchParams } from "../nav";
import { activeCompanyOf } from "../rail";
import { canStartHire } from "../roles";
import { Builder } from "./new-role/Builder";
import { QuickStart } from "./new-role/QuickStart";
import { StartView } from "./new-role/StartView";

/**
 * The job builder's page, /roles/new (plan C4; founder decisions Q4 and Q5): a full-width page of its own, reached from
 * "Start a hire" in the rail, the Jobs page and Home, with no new menu section. Without `?session=` it opens on "Who
 * are you hiring?" with two ways to start (or picks up the draft in progress): the quick questions (`?way=quick`, Wave
 * S2) or a sentence or a job ad for the assistant. With `?session=`, the conversation and the draft side by side. The
 * address names the draft only, never the person's words, which may hold pay.
 */
export function NewRole() {
  const [params] = useSearchParams();
  const sessionId = params.get("session");
  const fresh = params.get("new") === "1";
  const way = params.get("way");
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const company = activeCompanyOf(me.data);
  if (me.isLoading) return <Skeleton lines={4} />;
  // The same rule as the rail's button: role.create, held through a membership. The API checks it again.
  if (!canStartHire(company.role)) {
    return <EmptyState icon="roles" title="Starting a hire is not part of your role" body="Owners, admins and hiring managers start hires here. Ask one of them, or ask an owner to change your role." />;
  }
  // The quick start's answers are kept in this browser for this person in this company only.
  const scope = me.data?.activeCompanyId && me.data.user?.id ? { companyId: me.data.activeCompanyId, userId: me.data.user.id } : null;
  if (sessionId) return <Builder key={sessionId} sessionId={sessionId} companyName={company.name} />;
  if (way === "quick") return <QuickStart key={scope ? `${scope.companyId}:${scope.userId}` : "nobody"} scope={scope} />;
  return <StartView key={fresh ? "fresh" : "resume"} fresh={fresh} scope={scope} />;
}
