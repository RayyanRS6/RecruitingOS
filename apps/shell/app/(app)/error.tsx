"use client";

import { ErrorState } from "@ros/ui";

/** Anything a page throws lands here with a retry; the message never carries internals. */
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorState message="Something went wrong loading this page. Try again; if it keeps happening, tell us with 'Bring in a recruiter'." onRetry={reset} />;
}
