import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getMe, isAdmin } from "../../../lib/session";

/** Owner-side routes need an active company: a membership. */
export default async function CompanyLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!me.activeCompanyId) redirect(isAdmin(me) ? "/admin" : "/setup/company");
  return <>{children}</>;
}
