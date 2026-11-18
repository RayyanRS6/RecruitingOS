/**
 * What a page decides from the signed-in person's role in the company. Almost nothing: the API sends what each person
 * may do with a job, a candidate and the team (`actions`, `viewer`), and a page shows that. What it does not send is
 * here, and the API checks it again on every request.
 */

/** An owner or an admin: changes the company's details, sets a draft's closing date and may take a draft over. */
export function managesCompany(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}
