import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getMe, isStaff } from "../../../lib/session";

/** Owner-side routes need an active company: a membership, or a recruiter grant that opened a customer. */
export default async function CompanyLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!me.activeCompanyId) redirect(isStaff(me) ? "/recruiter/queue" : "/setup/company");
  return <>{children}</>;
}
