"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { companyCheckOf, type CompanyCheck } from "../company-check";

/**
 * Whether ITS has confirmed the signed-in person's company (founder decision B7), from GET /companies/current (the
 * query Setup's company card reads too). "unknown" until it has loaded, so no page promises anything either way.
 */
export function useCompanyCheck(): CompanyCheck {
  const q = useQuery({ queryKey: ["company"], queryFn: () => api.get<{ settings: Record<string, unknown> }>("/api/v1/companies/current") });
  return companyCheckOf(q.data);
}
