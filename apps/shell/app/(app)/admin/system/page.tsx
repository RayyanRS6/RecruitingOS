import { Dashboard } from "@ros/web/src/pages/admin/Dashboard";

/** The dashboard's System: health, costs, email, security reports and administrators (`?view=`). */
export default function AdminSystemPage() {
  return <Dashboard section="system" />;
}
