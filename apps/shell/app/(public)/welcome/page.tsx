import type { Metadata } from "next";
import { WelcomePage } from "../../../components/welcome/WelcomePage";

export const metadata: Metadata = {
  title: "Recruiting OS",
  description: "An AI recruiting guide for businesses without a recruiter: define the role, make sense of applicants with the evidence beside them, and choose whom to hire yourself.",
};

/**
 * Public. The first page for someone who is not signed in: the address of Home sends a visitor without a session here
 * (middleware.ts), and every way in leads to the sign-in page.
 */
export default function Welcome() {
  return <WelcomePage />;
}
