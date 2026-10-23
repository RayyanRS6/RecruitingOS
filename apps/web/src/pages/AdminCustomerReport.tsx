"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, ErrorState, numHead, Pill, Skeleton, Table } from "@ros/ui";
import { api } from "../api/client";
import { ReportDefinitions, ReportFigures, type RoleReport } from "./RoleReport";

type CustomerReport = {
  company: { id: string; name: string; status: string; planKey: string };
  roles: Array<{ id: string; title: string; status: string; openedAt: string | null; closedAt: string | null; applicants: number; waitingOnYou: number; hired: number }>;
  report: RoleReport;
};

const reason = { headers: { "x-admin-reason": "admin console: customer report" } };

/**
 * The customer's report in the admin console: the same ten figures as the role page, over every role of the company.
 * Counts only; no candidate names. The Report tab of the customer drawer (Wave S6); it was a sheet of its own before.
 * Its one line says when it was drawn up and that no candidate is named in it (the tab already says whose report it is).
 * What the figures mean ("typical", "average", response time, the decision counted) left the cards on 23 Oct 2026 for
 * the role page's closed disclosure, so the same disclosure closes this panel too, in its customer words ("across all
 * roles" where the role page says "this role"; each figure here adds the roles up the same way), without the must-haves
 * and the AI interview, which are one role's cards and not on this panel.
 */
export function CustomerReportPanel({ companyId }: { companyId: string }) {
  const q = useQuery({ queryKey: ["admin", "customer-report", companyId], queryFn: () => api.get<CustomerReport>(`/api/v1/admin/customers/${companyId}/report`, reason) });
  if (q.isLoading) return <Skeleton lines={8} />;
  if (q.error || !q.data) return <ErrorState message="Could not load the report." onRetry={() => q.refetch()} />;
  return (
    <div className="stack gap-4">
      <p className="small muted">As of {new Date(q.data.report.generatedAt).toLocaleString()}. Counts and days only; no candidate is named here.</p>
      {/* each role's title reads as the row's title; the cell itself stays bare (admin-customers-ui.test.ts pins `<td>title</td>`) */}
      <Card title={`Roles (${q.data.roles.length})`} className="[&_tbody_td:first-child]:font-semibold">
        {q.data.roles.length ? (
          <Table head={["Role", "Status", numHead("Applicants"), numHead("Waiting on them"), numHead("Hired")]} label="Roles of this customer">
            {q.data.roles.map((r) => <tr key={r.id}><td>{r.title}</td><td><Pill size="sm" tone={r.status === "open" ? "good" : r.status === "closed" ? "neutral" : "caution"}>{r.status.replace(/_/g, " ")}</Pill></td><td className="num">{r.applicants}</td><td className="num">{r.waitingOnYou}</td><td className="num">{r.hired}</td></tr>)}
          </Table>
        ) : <p className="small muted">No roles yet.</p>}
      </Card>
      <ReportFigures report={q.data.report} />
      <ReportDefinitions scope="customer" />
    </div>
  );
}
