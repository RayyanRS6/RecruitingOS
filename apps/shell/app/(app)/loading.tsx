import { Skeleton } from "@ros/ui";

/**
 * While a page's data loads: the place of its heading, then a few lines (read out as "Loading"). A server file, so it
 * imports only the kit's hook-free index.
 */
export default function Loading() {
  return (
    <div className="grid gap-8 py-2">
      <div aria-hidden="true" className="grid gap-3">
        <span className="skeleton block h-3 w-32 rounded-full" />
        <span className="skeleton block h-10 w-80 max-w-full rounded-xl" />
      </div>
      <Skeleton lines={5} />
    </div>
  );
}
