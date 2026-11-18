"use client";

import { type ReactNode, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanyView } from "@ros/contracts";
import { Alert, Card, ErrorState, PageHeader, Skeleton } from "@ros/ui";
import { api, type Me } from "../api/client";
import { useSearchParams } from "../nav";
import { activeCompanyOf } from "../rail";
import { managesCompany } from "../roles";
import { useSignInWhenSessionEnds } from "../session-ended";
import { reauthLine } from "../settings";
import { CompanySection } from "./settings/CompanySection";
import { EmailSection } from "./settings/EmailSection";
import { PlanSection } from "./settings/PlanSection";
import { TeamSection } from "./settings/TeamSection";

/** A section of the page with the address other pages link to (/setup#setup-team); the heading stays clear of the top on arrival. */
function Section({ id, children }: { id: string; children: ReactNode }) {
  return <div id={id} className="min-w-0 scroll-mt-6">{children}</div>;
}

/**
 * Settings: one page with four sections, Company, Team, Plan and Email updates. Everyone on the team reads all four;
 * an owner or an admin changes the company and the team; each person sets their own email switch.
 */
export function Settings() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const company = useQuery({ queryKey: ["company"], queryFn: () => api.get<CompanyView>("/api/v1/companies/current") });
  useSignInWhenSessionEnds([company.error, me.error]);
  const [params] = useSearchParams();
  const confirmed = reauthLine(params.get("reauth"));
  const mayEdit = managesCompany(activeCompanyOf(me.data).role);
  // A link to one section lands on it once the page has its sections: until then there is nothing to scroll to.
  const drawn = !!company.data;
  useEffect(() => {
    if (!drawn) return;
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [drawn]);
  return (
    <div className="stack gap-6">
      <PageHeader title="Settings" className="mb-0" />
      {confirmed ? <Alert tone={confirmed.tone}>{confirmed.text}</Alert> : null}
      <Section id="setup-company">
        {company.isLoading ? <Card title="Company"><Skeleton lines={5} /></Card> : company.error || !company.data ? <Card title="Company"><ErrorState message="Could not load the company." onRetry={() => company.refetch()} /></Card> : <CompanySection company={company.data} mayEdit={mayEdit} />}
      </Section>
      <Section id="setup-team"><TeamSection /></Section>
      {company.data ? <Section id="setup-plan"><PlanSection plan={company.data.plan} timeZone={company.data.timezone} /></Section> : null}
      <Section id="setup-notifications"><EmailSection /></Section>
    </div>
  );
}
