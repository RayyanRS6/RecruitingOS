"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type Me } from "../api/client";
import { activeCompanyOf } from "../rail";
import { canRequestPlan } from "../roles";

/**
 * Whether the signed-in person may ask ITS to change the company's plan (plan.request): everyone on the team but an
 * interviewer. `ready` is false until the answer is known, so nothing shows and then disappears.
 */
export function useAskRole(): { ready: boolean; mayAsk: boolean } {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  return { ready: !!me.data, mayAsk: canRequestPlan(activeCompanyOf(me.data).role) };
}
