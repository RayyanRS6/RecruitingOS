import type { ReactNode } from "react";

/**
 * Each company page fades up as it opens (spec 4: 240ms, 6px). Next.js draws a template afresh when the segment below it
 * changes, so this one (under (company), not under (app)) runs between Home, Jobs, Candidates, Interviews, Settings and
 * Updates, while a job's own pages, all under /roles, stay still. admin/ and recruiter/ have their own. A CSS animation
 * (animate-enter, styles.css): it runs before any script loads and not at all for someone who asked for less motion.
 * Filled backwards only, so once it ends the wrapper keeps no transform and is no containing block for the sheets and
 * menus drawn inside the page.
 */
export default function Template({ children }: { children: ReactNode }) {
  return <div className="animate-enter [animation-fill-mode:backwards]">{children}</div>;
}
