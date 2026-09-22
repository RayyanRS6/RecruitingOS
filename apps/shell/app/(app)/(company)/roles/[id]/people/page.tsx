import { redirect } from "next/navigation";

/** Old name for the talent view; kept as a redirect so bookmarks work. */
export default async function RolePeopleRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/roles/${id}/talent`);
}
