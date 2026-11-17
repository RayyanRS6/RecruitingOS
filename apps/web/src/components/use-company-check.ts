"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { companyCheckOf, type CompanyCheck } from "../company-check";
import { safetyNetWorkDays } from "../telling";

type CompanyAnswer = { settings: Record<string, unknown>; timezone?: string | null };
const companyQuery = { queryKey: ["company"], queryFn: () => api.get<CompanyAnswer>("/api/v1/companies/current") };

/**
 * Whether ITS has confirmed the signed-in person's company (founder decision B7), from GET /companies/current (the
 * query Setup's company card reads too). "unknown" until it has loaded, so no page promises anything either way.
 */
export function useCompanyCheck(): CompanyCheck {
  const q = useQuery(companyQuery);
  return companyCheckOf(q.data);
}

/**
 * The company's time zone, from the same answer: an interview's date and time are always on the company's clock, said by
 * name, never the browser's (6 November 2026). Null until it has loaded.
 */
export function useCompanyTimezone(): string | null {
  const q = useQuery(companyQuery);
  return q.data?.timezone ?? null;
}

/**
 * The company's calendar as the untold safety net counts it, from the same answer: its time zone, and its contact days
 * Monday to Friday (`workDays`, null for Monday to Friday), as the daily check reads them, so the day a decline step, "No
 * hire" and the close card name before the click is the day the toast names after it (the second review of the live-test
 * fixes, 12 November 2026). Both null until it has loaded.
 */
export function useCompanyCalendar(): { timeZone: string | null; workDays: number[] | null } {
  const q = useQuery(companyQuery);
  const hours = q.data?.settings?.businessHours as { days?: unknown } | null | undefined;
  return { timeZone: q.data?.timezone ?? null, workDays: Array.isArray(hours?.days) ? safetyNetWorkDays(hours.days) : null };
}
