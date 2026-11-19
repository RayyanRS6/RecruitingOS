import { Dashboard } from "@ros/web/src/pages/admin/Dashboard";

/** The admin dashboard lands on Companies: the requests to accept or decline, the list, and one company at `?open=<id>`. */
export default function AdminCompaniesPage() {
  return <Dashboard section="companies" />;
}
