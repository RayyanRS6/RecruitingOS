import { Console } from "@ros/web/src/pages/admin/Console";

/** The console's System and settings: costs, workflows, AI runs, queue health, the business calendar and administrators (`?view=`). */
export default function AdminSystemPage() {
  return <Console section="system" />;
}
