import type { Metadata } from "next";
import { signupModeOf } from "@ros/api/src/env";
import { WelcomePage } from "../../../components/welcome/WelcomePage";

export const metadata: Metadata = {
  title: "Recruiting OS",
  description: "An AI recruiting guide for businesses without a recruiter: define the role, make sense of applicants with the evidence beside them, and choose whom to hire yourself.",
};

/**
 * Public. The first page for someone who is not signed in: the address of Home sends a visitor without a session here
 * (middleware.ts), and every way in leads to the sign-in page. By invitation (SIGNUP_MODE=invite, GATE-V2) it invites no
 * stranger to start. The mode is read from this process's environment the way the API reads it (apps/api/src/env.ts),
 * not asked of the API, so a visitor without a session never starts the API's container or counts against its shared
 * limit on anonymous calls.
 */
export default function Welcome() {
  return <WelcomePage inviteOnly={signupModeOf(process.env) === "invite"} />;
}
