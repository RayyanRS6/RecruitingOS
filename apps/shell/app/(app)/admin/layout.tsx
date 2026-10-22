import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getMe, isAdmin } from "../../../lib/session";

/** Platform administrators only; every read inside is audited by the API with a reason. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!isAdmin(me)) redirect(me.activeCompanyId ? "/" : "/recruiter/queue");
  return <>{children}</>;
}
