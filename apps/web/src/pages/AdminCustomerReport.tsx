"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, Chip, ErrorState, Sheet, Skeleton, Table } from "@ros/ui";
import { api } from "../api/client";
import { ReportFigures, type RoleReport } from "./RoleReport";

type CustomerReport = {
  company: { id: string; name: string; status: string; planKey: string };
  roles: Array<{ id: string; title: string; status: string; openedAt: string | null; closedAt: string | null; applicants: number; waitingOnYou: number; hired: number }>;
  report: RoleReport;
};

const reason = { headers: { "x-admin-reason": "admin console: customer report" } };

/** The customer's report in the admin console: the same ten figures as the role page, over every role of the company. Counts only; no candidate names. */
export function CustomerReportSheet({ companyId, companyName, onClose }: { companyId: string; companyName: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["admin", "customer-report", companyId], queryFn: () => api.get<CustomerReport>(`/api/v1/admin/customers/${companyId}/report`, reason) });
  return (
    <Sheet open onClose={onClose} title={`Report: ${companyName}`}>
      {q.isLoading ? <Skeleton lines={8} /> : q.error || !q.data ? <ErrorState message="Could not load the report." onRetry={() => q.refetch()} /> : (
        <div className="stack" style={{ gap: 14 }}>
          <p className="small muted">All roles of this customer together, as of {new Date(q.data.report.generatedAt).toLocaleString()}. Counts and days only; no candidate is named here.</p>
          <Card title={`Roles (${q.data.roles.length})`}>
            {q.data.roles.length ? (
              <Table head={["Role", "Status", "Applicants", "Waiting on them", "Hired"]} label="Roles of this customer">
                {q.data.roles.map((r) => <tr key={r.id}><td>{r.title}</td><td><Chip tone={r.status === "open" ? "accent" : r.status === "closed" ? "neutral" : "caution"}>{r.status.replace(/_/g, " ")}</Chip></td><td>{r.applicants}</td><td>{r.waitingOnYou}</td><td>{r.hired}</td></tr>)}
              </Table>
            ) : <p className="small muted">No roles yet.</p>}
          </Card>
          <ReportFigures report={q.data.report} />
        </div>
      )}
    </Sheet>
  );
}
