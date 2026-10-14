"use client";

import type { ReactNode } from "react";

/**
 * The longer words behind a card's one line (Wave S1): one click away, never on the first view, in the one "show more"
 * pattern (`details.more`). The summary says what opens: "Why" by default, or "What happens next" before a decision.
 */
export function Why({ children, label = "Why" }: { children: ReactNode; label?: string }) {
  return (
    <details className="more" style={{ marginTop: 6 }}>
      <summary>{label}</summary>
      <div className="small muted stack" style={{ gap: 6 }}>{children}</div>
    </details>
  );
}
