import type { ReactNode } from "react";

/**
 * Each section of the admin dashboard fades up as it opens (240ms, 6px); see (company)/template.tsx. Next.js keys this
 * one by the section below /admin, so moving between Companies, Privacy requests and System runs it. Filled backwards
 * only: no transform is left on the wrapper once it ends.
 */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="animate-enter [animation-fill-mode:backwards]">{children}</div>;
}
