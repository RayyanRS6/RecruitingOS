import { redirect } from "next/navigation";
import { Login } from "@ros/web/src/pages/Login";
import { getMe, isAdmin } from "../../../lib/session";

/**
 * Public. A signed-in person is sent where they belong instead of seeing the sign-in form again, as the sign-in itself
 * sends them: a platform administrator to the admin dashboard, someone with a company Home, anyone else to the company
 * details.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await getMe();
  const q = await searchParams;
  if (me && !q.error) redirect(isAdmin(me) ? "/admin" : me.activeCompanyId ? "/" : "/setup/company");
  return <Login />;
}
