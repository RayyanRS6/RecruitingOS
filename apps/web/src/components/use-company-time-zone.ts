"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

/**
 * The company's own time zone (GET /companies/current, the query Setup's company card reads too), or null until it has
 * loaded. Dates the API checks against "today" are the company's days, not the reader's: someone whose computer is
 * already on tomorrow must not be offered a day the company has not reached.
 */
export function useCompanyTimeZone(): string | null {
  const q = useQuery({ queryKey: ["company"], queryFn: () => api.get<{ timezone?: string | null }>("/api/v1/companies/current") });
  return q.data?.timezone || null;
}
