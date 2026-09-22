import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getMe, isStaff } from "../../../lib/session";

/** ITS staff only (platform role its_recruiter or platform_admin). */
export default async function RecruiterLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!isStaff(me)) redirect(me.activeCompanyId ? "/" : "/setup/company");
  return <>{children}</>;
}
