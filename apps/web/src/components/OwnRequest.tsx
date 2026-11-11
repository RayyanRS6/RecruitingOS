"use client";

import { useQuery } from "@tanstack/react-query";
import type { SignupConfig } from "@ros/contracts";
import { Alert } from "@ros/ui";
import { api } from "../api/client";

/** The line about this person's own request for access, waiting or declined; null without one. */
export function ownRequestLine(request: SignupConfig["request"] | undefined): string | null {
  if (!request) return null;
  return request.status === "declined" ? "We can't offer access to your own company right now." : "Your own company's request is waiting for approval.";
}

/**
 * Someone who asked for access and joined another company by invitation works there, so the waiting screen, the one place
 * that said where their own request stands, never shows again (the review of 6 November 2026). Home says it in one line,
 * from the same answer that screen reads (GET /auth/config), with the same "Questions?" for a declined one, and looks again
 * on focus and every minute while there is a request, so the line goes once it is accepted. Nothing shows without one.
 */
export function OwnRequest() {
  const config = useQuery({
    queryKey: ["auth", "config", "own request"],
    queryFn: () => api.get<{ signup?: SignupConfig }>("/api/v1/auth/config"),
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data?.signup?.request ? 60_000 : false),
    refetchIntervalInBackground: false,
  });
  const signup = config.data?.signup;
  const line = ownRequestLine(signup?.request);
  if (!line) return null;
  return (
    <Alert tone="info">
      {line}
      {signup?.request?.status === "declined" && signup.contact ? <> Questions? <a href={`mailto:${signup.contact}`}>{signup.contact}</a></> : null}
    </Alert>
  );
}
