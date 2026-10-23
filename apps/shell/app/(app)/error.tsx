"use client";

import { ErrorState } from "@ros/ui";

/**
 * Anything a page throws lands here: what happened and what to do, beside the Try again button (so the line does not
 * say "try again" too). The message never carries internals.
 */
export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="py-2">
      <ErrorState message="Something went wrong loading this page. If it keeps happening, tell us with 'Bring in a recruiter'." onRetry={reset} />
    </div>
  );
}
