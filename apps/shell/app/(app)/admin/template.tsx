import type { ReactNode } from "react";

/**
 * Each console section fades up as it opens (spec 4: 240ms, 6px); see (company)/template.tsx. Next.js keys this one by
 * the section below /admin, so moving between Overview, Customers, Privacy requests, Problems and System and settings
 * runs it. Filled backwards only: no transform is left on the wrapper once it ends.
 */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="animate-enter [animation-fill-mode:backwards]">{children}</div>;
}
