import { redirect } from "next/navigation";
import { Login } from "@ros/web/src/pages/Login";
import { getMe, isStaff } from "../../../lib/session";

/** Public. A signed-in person is sent where they belong instead of seeing the sign-in form again. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await getMe();
  const q = await searchParams;
  if (me && !q.error) redirect(me.activeCompanyId ? "/" : isStaff(me) ? "/recruiter/queue" : "/setup/company");
  return <Login />;
}
