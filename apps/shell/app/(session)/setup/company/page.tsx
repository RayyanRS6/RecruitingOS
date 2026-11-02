import { redirect } from "next/navigation";
import { CompanySetup } from "@ros/web/src/pages/CompanySetup";
import { getSignup } from "../../../../lib/public-config";
import { getMe } from "../../../../lib/session";

/**
 * Requires a session; no company yet. Anyone who already has a company goes home. By invitation (SIGNUP_MODE=invite,
 * GATE-V2) the API says whether this person may create a company, and someone who may not is told so instead of the form.
 */
export default async function CompanySetupPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  if (me.activeCompanyId) redirect("/");
  return <CompanySetup signup={await getSignup()} />;
}
