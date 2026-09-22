import { redirect } from "next/navigation";
import { CompanySetup } from "@ros/web/src/pages/CompanySetup";
import { getMe } from "../../../../lib/session";

/** Requires a session; no company yet. Anyone who already has a company goes home. */
export default async function CompanySetupPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  if (me.activeCompanyId) redirect("/");
  return <CompanySetup />;
}
