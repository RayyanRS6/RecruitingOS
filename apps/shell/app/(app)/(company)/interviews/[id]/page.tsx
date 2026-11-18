import { redirect } from "next/navigation";

/** An old link to one interview lands on Candidates. */
export default function InterviewRedirect() {
  redirect("/talent");
}