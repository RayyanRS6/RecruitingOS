import { redirect } from "next/navigation";
import { CompanySetup } from "@ros/web/src/pages/CompanySetup";
import { getSignup } from "../../../../lib/public-config";
import { getMe } from "../../../../lib/session";

/**
 * Requires a session; no company yet. Anyone who already has a company goes home. By invitation (SIGNUP_MODE=invite,
 * GATE-V2) or by approval (SIGNUP_MODE=approval) the API says whether this person may create a company, or send a request
 * for one, and where their own request stands: someone who may not is told so instead of the form, and someone with a
 * request reads where it stands, here, at whatever address they opened (the shell's layouts send them here).
 */
export default async function CompanySetupPage() {
  const me = await getMe();
  if (!me) redirect("/login");
  if (me.activeCompanyId) redirect("/");
  return <CompanySetup signup={await getSignup()} />;
}
