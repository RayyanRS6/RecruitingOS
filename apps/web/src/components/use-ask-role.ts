"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type Me } from "../api/client";
import { activeCompanyOf } from "../rail";
import { canAskRecruiter } from "../roles";

/**
 * Whether the signed-in person may bring in a recruiter and read the team's requests (escalation.create, plan B7):
 * everyone but an interviewer. An ITS recruiter inside a customer under a grant asks with a recruiter's rights, within
 * that grant. `ready` is false until the answer is known, so nothing shows and then disappears.
 */
export function useAskRole(): { ready: boolean; mayAsk: boolean; staff: boolean } {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const staff = !!me.data?.staffAccess;
  const role = activeCompanyOf(me.data).role ?? (staff ? "recruiter" : null);
  return { ready: !!me.data, mayAsk: canAskRecruiter(role), staff };
}
