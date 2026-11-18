import { redirect } from "next/navigation";

/** The Interviews page is gone; an old link lands on Candidates, where each job's AI interviews are. */
export default function InterviewsRedirect() {
  redirect("/talent");
}