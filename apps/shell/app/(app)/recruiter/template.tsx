import type { ReactNode } from "react";

/**
 * The recruiter queue fades up as it opens (spec 4: 240ms, 6px); see (company)/template.tsx. Filled backwards only: no
 * transform is left on the wrapper once it ends.
 */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="animate-enter [animation-fill-mode:backwards]">{children}</div>;
}
