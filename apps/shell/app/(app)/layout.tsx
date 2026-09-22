import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "../../components/AppShell";
import { getMe } from "../../lib/session";

export const dynamic = "force-dynamic";

/** Every route under here requires a session (D19). Company, recruiter and admin groups add their own permission checks. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  if (!me) redirect("/login");
  return <AppShell me={me}>{children}</AppShell>;
}
